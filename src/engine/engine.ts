import { ENGINE } from "../config.js";
import { runAgent } from "../agents/agents.js";
import { arcRevisionTool, designStoryTool, d20CheckTool, memoryDistillTool, sceneOutlineTool, sceneReportTool, sharedReadTools, verdictTool, type ToolCollector } from "../agents/tools.js";
import { DESIGN_SYSTEM, DISTILL_SYSTEM, IDEA_SYSTEM, OUTLINE_SYSTEM, REPORT_SYSTEM, REVIEWER_SYSTEM, WRITER_SYSTEM } from "../agents/prompts.js";
import type { Store } from "../facts/store.js";
import type { GameState, PlayMode, SceneReport, StoryDesign } from "../facts/types.js";
import type { Llm } from "../llm.js";
import { assembleBootPrompt, assembleDirectorReportPrompt, assembleMemoryDistillPrompt, assembleArcDistillPrompt, assembleOutlineDerivationPrompt, assembleOutlineReviewPrompt, assembleReviewerPrompt, assembleWriterPrompt, draftPrecheckNotes, extractCurrency } from "./context.js";
import { applyCharacterPatches, applyForeshadowOps, applyTransactions, sanitizeReport } from "./settle.js";

// ---------------------------------------------------------------------------
// 确定性复读检测：小模型可能陷入 n-gram 循环并耗尽 token 预算。
// 不花任何 LLM 调用，直接在草稿上查滑动窗口的重复块。
// ---------------------------------------------------------------------------
export function detectRepetitionLoop(draft: string): { quote: string; constraint: string; problem: string }[] {
	const window = 24; // 连续 24 字为一块
	const minRepeat = 4; // 同一块出现 ≥4 次视为复读
	if (draft.length < window * (minRepeat + 1)) return [];
	const counts = new Map<string, number>();
	for (let i = 0; i + window <= draft.length; i++) {
		const key = draft.slice(i, i + window);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	let worst = "";
	let worstCount = 0;
	for (const [key, count] of counts) {
		if (count > worstCount) {
			worst = key;
			worstCount = count;
		}
	}
	if (worstCount < minRepeat) return [];
	return [
		{
			quote: worst,
			constraint: "文本复读检测",
			problem: `同一片段「${worst.slice(0, 12)}…」在草稿中重复出现 ${worstCount} 次，陷入复读循环；请重写整个场景，推进剧情而不是原地重复。`,
		},
	];
}

// ---------------------------------------------------------------------------
// 确定性门禁：大纲预检 / 开局设计校验。纯函数、零 LLM，幻觉在落盘前被拦截。
// ---------------------------------------------------------------------------

const OUTLINE_MIN = 80;
const OUTLINE_MAX = 600;

/** 大纲硬性预检：字数出格直接打回（不劳 LLM 审核） */
export function outlineGateHard(outline: string): { quote: string; constraint: string; problem: string }[] {
	if (outline.length >= OUTLINE_MIN && outline.length <= OUTLINE_MAX) return [];
	return [
		{
			quote: outline.slice(0, 30),
			constraint: "大纲规格（80-600 字）",
			problem: `大纲长度 ${outline.length} 字，超出规格；请${outline.length < OUTLINE_MIN ? "充实每个节点的信息增量" : "压缩过程细节、保留节点骨架"}后重新提交。`,
		},
	];
}

/** 从读者选择文本提取关键词（按标点切分，取 ≥2 字的段），用于承接性检查 */
function choiceKeywords(choice: string): string[] {
	return choice
		.split(/[——…、，。;；!？?！:：\s()（）「」《》"'·]+/)
		.map((s) => s.trim())
		.filter((s) => s.length >= 2);
}

/** 大纲软性预检：疑点提示喂给审核，不直接打回 */
export function outlineGateNotes(outline: string, lastChoice: string | null): string[] {
	const notes: string[] = [];
	if (lastChoice) {
		const kws = choiceKeywords(lastChoice);
		if (kws.length > 0 && !kws.some((k) => outline.includes(k))) {
			notes.push(`读者上一选择「${lastChoice}」在大纲中找不到明显呼应——请核对承接性，若确实未承接应打回。`);
		}
	}
	return notes;
}

/** 大纲中已登记角色的出场情况（给审核做「未登记名扫描」的参考面） */
export function outlineCastNote(outline: string, knownNames: string[]): string | null {
	const present = knownNames.filter((n) => n.length >= 2 && outline.includes(n));
	if (present.length === 0) return null;
	return `大纲提及的已登记角色：${present.join("、")}。其余出场人物若需具名，须是已登记角色或无名指代（如「店主」）。`;
}

/** 开局设计校验：可确定性修复前的硬伤清单（供一轮 LLM 修复） */
export function designIssues(design: StoryDesign): string[] {
	const issues: string[] = [];
	if (!design.title?.trim()) issues.push("书名（title）为空");
	if (!design.premise?.trim()) issues.push("故事梗概（premise）为空");
	if (!design.worldRules?.trim()) issues.push("世界规则（worldRules）为空");
	if (!design.economy?.currency?.trim()) issues.push("经济体系的计价单位（economy.currency）为空");
	if (!design.economy?.overview?.trim()) issues.push("经济体系概述（economy.overview）为空");
	if (!design.arc?.title?.trim() || !design.arc?.goal?.trim()) issues.push("第一弧的标题或目标为空");
	if (!design.openingBeat?.trim()) issues.push("开场拍（openingBeat）为空");
	if (!Array.isArray(design.characters) || design.characters.length < 2) issues.push("主要角色少于 2 个");
	if (!Array.isArray(design.attributes) || design.attributes.length < 4 || design.attributes.length > 8) {
		issues.push(`世界属性表需要 4-8 条（当前 ${design.attributes?.length ?? 0} 条）`);
	}
	return issues;
}

/** 开局设计修复：属性表裁剪、stats 键对齐属性表并补默认值。返回告警。 */
export function sanitizeDesign(design: StoryDesign): { design: StoryDesign; warnings: string[] } {
	const warnings: string[] = [];
	let attributes = (design.attributes ?? []).map((a) => a?.trim()).filter(Boolean);
	if (attributes.length > 8) {
		attributes = attributes.slice(0, 8);
		warnings.push("属性表超过 8 条，已截断");
	}
	if (attributes.length > 0) {
		const attrSet = new Set(attributes);
		const characters = design.characters.map((c) => {
			const raw = c.initialState.stats;
			if (!raw) return c;
			const dropped = Object.keys(raw).filter((k) => !attrSet.has(k));
			const stats: Record<string, number> = {};
			for (const k of attributes) stats[k] = typeof raw[k] === "number" ? Math.min(18, Math.max(1, Math.round(raw[k]))) : 10;
			if (dropped.length > 0) warnings.push(`${c.name} 的属性键 [${dropped.join("、")}] 不在属性表中，已按属性表重排（缺省 10）`);
			return { ...c, initialState: { ...c.initialState, stats } };
		});
		return { design: { ...design, attributes, characters }, warnings };
	}
	return { design: { ...design, attributes }, warnings };
}

// ---------------------------------------------------------------------------
// 确定性场景引擎：状态机主循环零 LLM 逻辑，LLM 只在角色调用中发生。
// 每个状态变更后原子落盘 autosave，进程崩溃后可从 current.json 恢复。
// ---------------------------------------------------------------------------

export type EngineEvent =
	| { type: "phase"; phase: GameState["phase"] }
	| { type: "status"; text: string }
	| { type: "idea_user"; text: string }
	| { type: "idea_delta"; text: string }
	| { type: "idea_done"; text: string }
	| { type: "scene_delta"; text: string }
	| { type: "scene_done"; scene: number; title: string; text: string }
	| { type: "review"; attempt: number; pass: boolean; issues: { quote: string; constraint: string; problem: string }[] }
	| { type: "agent_process"; role: "director" | "writer" | "reviewer"; kind: "delta" | "tool"; text: string }
	| { type: "boot_ready"; title: string; premise: string; characters: string[]; arcTitle: string; arcGoal: string; openingBeat: string }
	| { type: "scene_outline"; scene: number; text: string }
	| { type: "outline_updated"; arc: number; title: string; goal: string }
	| { type: "choices"; scene: number; choices: { label: string; description: string; preview?: string }[]; recommended?: number }
	| { type: "arc_boundary"; summary: string }
	| { type: "ended" }
	| { type: "error"; message: string };

export class Engine {
	private state: GameState = Engine.initialState();
	private currentSteer: ((text: string) => void) | null = null;

	constructor(
		public readonly store: Store,
		private readonly llm: Llm,
		public emit: (event: EngineEvent) => void,
	) {}

	static initialState(): GameState {
		return {
			phase: "empty",
			mode: "manual",
			title: "",
			premise: "",
			sceneIndex: 0,
			arcBeatIndex: 0,
			arc: null,
			arcCount: 1,
			attempt: 0,
			pendingReport: null,
			ideaMsgs: [],
			updatedAt: new Date().toISOString(),
		};
	}

	get gameState(): GameState {
		return this.state;
	}

	/**
	 * 原子落盘：current.json 永远是"当前翻开的书"；storyId 存在时同步写该故事的
	 * 独立存档文件（存档/故事-<storyId>.json），每个故事一份、互不覆盖——
	 * 开新故事或重启都不会抹掉旧故事的最新进度，可随时 /load 回去。
	 */
	private async commit(): Promise<void> {
		this.state.updatedAt = new Date().toISOString();
		await this.store.writeJson("存档/current.json", this.state);
		if (this.state.storyId) await this.store.writeJson(`存档/故事-${this.state.storyId}.json`, this.state);
	}

	private setPhase(phase: GameState["phase"]): Promise<void> {
		this.state.phase = phase;
		this.state.substate = undefined;
		this.emit({ type: "phase", phase });
		return this.commit();
	}

	/** 持久化 playing 子状态（崩溃恢复时标注中断点） */
	private async setSubstate(substate: GameState["substate"]): Promise<void> {
		this.state.substate = substate;
		await this.commit();
	}

	/** 后台执行并兜底错误（引擎事件流对外只发 error 事件） */
	private void(p: Promise<void>): void {
		p.catch((err) => this.emit({ type: "error", message: `引擎错误：${err?.message ?? err}` }));
	}

	/** 过程事件发射器：includeText=false 时只上报工具调用（Writer 正文已有 scene_delta 流，不重复） */
	private proc(role: "director" | "writer" | "reviewer", includeText: boolean) {
		return (kind: "delta" | "tool", text: string) => {
			if (kind === "delta" && !includeText) return;
			this.emit({ type: "agent_process", role, kind, text });
		};
	}

	// -- 启动 / 恢复 -----------------------------------------------------------

	/** 有存档则恢复；否则进入待开局状态（等待 startPremise） */
	async boot(): Promise<void> {
		await this.store.ensureWorkspace();
		const saved = await this.store.readJson<GameState>("存档/current.json");
		if (saved && saved.phase === "ended") {
			// 上局已完结：以空局进入，但保留完结信息提示
			await this.setPhase("empty");
			this.emit({ type: "status", text: `上一部《${saved.title || "未命名"}》已完结。输入新灵感（或先聊聊）开始下一部。` });
			return;
		}
		await this.restoreOrEmpty(saved);
	}

	/** 从状态快照恢复（boot 与 load 共用）；空快照则进入空局 */
	private async restoreOrEmpty(saved: GameState | null): Promise<void> {
		if (saved && saved.phase !== "empty" && saved.phase !== "ended") {
			this.state = saved;
			if (!this.state.ideaMsgs) this.state.ideaMsgs = [];
			this.emit({ type: "phase", phase: saved.phase });
			this.emit({ type: "status", text: `已恢复进度：${saved.title || "未命名"}，第 ${saved.sceneIndex} 场` });
			if (saved.phase === "playing" && saved.pendingReport) {
				this.presentChoices(saved.pendingReport);
			} else if (saved.phase === "playing") {
				const labels: Record<string, string> = {
					writing: "执笔写作",
					reviewing: "校对审阅",
					rewriting: "按校对意见重写",
					settling: "场景定稿落盘",
				};
				const label = labels[saved.substate ?? ""];
				if (label) {
					this.emit({ type: "status", text: `上次在第 ${saved.sceneIndex + 1} 场的${label}中中断，本场景将重新生成。` });
				}
				this.void(this.runScene());
			} else if (saved.phase === "confirm_bible") {
				this.emit({ type: "status", text: "开局设计待确认：输入 /accept 开始，或直接输入修改意见。" });
			} else if (saved.phase === "arc_boundary") {
				this.void(this.runArcBoundary());
			} else if (saved.phase === "idea_chat") {
				for (const m of saved.ideaMsgs ?? []) {
					this.emit(m.role === "user" ? { type: "idea_user", text: m.text } : { type: "idea_done", text: m.text });
				}
				this.emit({ type: "status", text: "灵感酝酿中：继续聊，或确认后构建开局。" });
			}
		} else {
			await this.setPhase("empty");
			this.emit({ type: "status", text: "先聊聊灵感吧：题材、主角、想要的基调……聊透了再构建开局；或输入「构建：一句话灵感」直接开工。" });
		}
	}

	/** 存档位列表（不含 autosave 的 current.json） */
	async listSaves(): Promise<{ name: string; title: string; phase: string; sceneIndex: number; updatedAt: string }[]> {
		const files = await this.store.listDir("存档").catch(() => [] as string[]);
		const out: { name: string; title: string; phase: string; sceneIndex: number; updatedAt: string }[] = [];
		for (const f of files.filter((x) => x.endsWith(".json") && x !== "current.json")) {
			const s = await this.store.readJson<GameState>(`存档/${f}`);
			if (s) out.push({ name: f.replace(/\.json$/, ""), title: s.title, phase: s.phase, sceneIndex: s.sceneIndex, updatedAt: s.updatedAt });
		}
		return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
	}

	/** 读档：把存档快照恢复为当前进度（ended 存档按原样恢复供回看） */
	async load(name: string): Promise<void> {
		const saved = await this.store.readJson<GameState>(`存档/${name}.json`);
		if (!saved) {
			this.emit({ type: "error", message: `存档「${name}」不存在` });
			return;
		}
		if (!saved.ideaMsgs) saved.ideaMsgs = [];
		this.currentSteer = null;
		this.ideaBusy = false;
		if (saved.phase === "ended") {
			this.state = saved;
			this.emit({ type: "phase", phase: "ended" });
			this.emit({ type: "status", text: `已读档：《${saved.title || "未命名"}》（已完结，可回看；/restart 开新故事）` });
			return;
		}
		await this.restoreOrEmpty(saved);
	}

	/** 灵感对话互斥锁：上一轮回复未结束前忽略新输入 */
	private ideaBusy = false;

	/** d20 判定硬预算：每场重置（约束在代码，不在 prompt） */
	private diceBudget = { used: 0, max: 3 };

	/** 灵感酝酿阶段：与导播多轮对话打磨题材，不触发正式设计 */
	async chatIdea(text: string): Promise<void> {
		if (this.state.phase !== "empty" && this.state.phase !== "idea_chat") return;
		if (this.ideaBusy) {
			this.emit({ type: "status", text: "导播正在回复，稍等它说完……" });
			return;
		}
		this.ideaBusy = true;
		try {
			if (this.state.phase === "empty") await this.setPhase("idea_chat");
			this.state.ideaMsgs.push({ role: "user", text });
			this.emit({ type: "idea_user", text });
			await this.commit();

			const transcript = this.state.ideaMsgs.map((m) => (m.role === "user" ? "读者：" : "顾问：") + m.text).join("\n");
			const prompt = `【灵感对话】以下是目前与读者的闲聊记录：\n\n${transcript}\n\n像朋友一样自然接话，回应读者最新的那句。`;
			this.emit({ type: "status", text: "顾问正在回复……" });
			const result = await runAgent({
				role: "director",
				llm: this.llm,
				system: IDEA_SYSTEM,
				tools: [],
				prompt,
				onProcess: this.proc("director", true),
			});
			const reply = result.text.trim() || "（导播走神了一下，再说一遍？）";
			this.state.ideaMsgs.push({ role: "assistant", text: reply });
			await this.commit();
			this.emit({ type: "idea_done", text: reply });
		} finally {
			this.ideaBusy = false;
		}
	}

	/** 结束酝酿，把积累的对话交给导播正式设计开局 */
	async buildFromIdea(extra?: string): Promise<void> {
		if (this.state.phase !== "empty" && this.state.phase !== "idea_chat") return;
		const parts = this.state.ideaMsgs.filter((m) => m.role === "user").map((m) => m.text);
		if (extra && extra.trim()) parts.push(extra.trim());
		if (parts.length === 0) {
			this.emit({ type: "error", message: "还没有灵感记录：先和导播聊聊，或输入「构建：一句话灵感」直接开工。" });
			return;
		}
		await this.startPremise(parts.join("\n"));
	}

	/**
	 * 开局设计门禁：程序预检 → 一轮 LLM 修复 → 确定性修复（属性表裁剪、stats 对齐）。
	 * 预检仍不过返回 null（调用方终止开局流程）。
	 */
	private async validateDesign(design: StoryDesign): Promise<StoryDesign | null> {
		let current = design;
		const issues = designIssues(current);
		if (issues.length > 0) {
			this.emit({ type: "status", text: `开局设计预检发现 ${issues.length} 个问题，要求导播修复……` });
			const collector: ToolCollector = {};
			await runAgent({
				role: "director",
				llm: this.llm,
				system: DESIGN_SYSTEM,
				tools: [...sharedReadTools(this.store), designStoryTool(this.store, collector)],
				prompt: `你提交的开局设计未通过程序预检：\n${issues.map((i, n) => `${n + 1}. ${i}`).join("\n")}\n\n请调用 design_story 重新提交修复后的完整设计（保持原题材与风格，只修复列出的问题）。`,
				onProcess: this.proc("director", true),
			});
			if (collector.design) current = collector.design;
		}
		const { design: fixed, warnings } = sanitizeDesign(current);
		for (const w of warnings) this.emit({ type: "status", text: `设计门禁：${w}` });
		if (warnings.length > 0) await this.store.saveDesignBible(fixed);
		if (designIssues(fixed).length > 0) {
			this.emit({ type: "error", message: "开局设计仍未通过预检（必要字段缺失），请 /restart 重试。" });
			return null;
		}
		return fixed;
	}

	async startPremise(premise: string): Promise<void> {
		if (this.state.phase !== "empty" && this.state.phase !== "idea_chat") return;
		this.state.premise = premise;
		// 新故事 → 生成唯一 storyId（决定独立存档文件名）
		if (!this.state.storyId) {
			const slug = premise.replace(/[^A-Za-z0-9一-鿿]/g, "").slice(0, 12) || "story";
			this.state.storyId = `${slug}-${Date.now().toString(36)}`;
		}
		await this.setPhase("bootstrapping");
		this.emit({ type: "status", text: "导播正在设计世界观、角色与第一弧大纲……" });

		const collector: ToolCollector = {};
		await runAgent({
			role: "director",
			llm: this.llm,
			system: DESIGN_SYSTEM,
			tools: [...sharedReadTools(this.store), designStoryTool(this.store, collector)],
			prompt: assembleBootPrompt(premise),
			onProcess: this.proc("director", true),
		});

		if (!collector.design) {
			this.emit({ type: "error", message: "导播未能产出开局设计，请重试（/restart）" });
			return;
		}
		const design = await this.validateDesign(collector.design);
		if (!design) return;
		this.state.title = design.title;
		await this.commit();
		await this.setPhase("confirm_bible");
		this.emit({
			type: "boot_ready",
			title: design.title,
			premise: design.premise,
			characters: design.characters.map((c) => `${c.name}：${c.basics.slice(0, 40)}`),
			arcTitle: design.arc.title,
			arcGoal: design.arc.goal,
			openingBeat: design.openingBeat,
		});
		this.emit({ type: "status", text: "输入 /accept 开始故事；或直接输入修改意见让导播调整。" });
	}

	/** confirm_bible 阶段：接受开局或按意见重设计 */
	async confirmBible(feedback?: string): Promise<void> {
		if (this.state.phase !== "confirm_bible") return;
		if (!feedback) {
			this.emit({ type: "status", text: "开局确认，故事开始。" });
			await this.beginArc(1);
			return;
		}
		this.emit({ type: "status", text: "导播正在按意见调整开局……" });
		const collector: ToolCollector = {};
		await runAgent({
			role: "director",
			llm: this.llm,
			system: DESIGN_SYSTEM,
			tools: [...sharedReadTools(this.store), designStoryTool(this.store, collector)],
			prompt: `读者对现有开局设计提出了修改意见：「${feedback}」\n\n请调用 read_bible 查看现有设定后，调用 design_story 重新提交完整开局设计（在原有基础上按意见调整）。`,
			onProcess: this.proc("director", true),
		});
		if (collector.design) {
			const design = await this.validateDesign(collector.design);
			if (!design) return;
			this.state.title = design.title;
			await this.commit();
			this.emit({
				type: "boot_ready",
				title: design.title,
				premise: design.premise,
				characters: design.characters.map((c) => `${c.name}：${c.basics.slice(0, 40)}`),
				arcTitle: design.arc.title,
				arcGoal: design.arc.goal,
				openingBeat: design.openingBeat,
			});
			this.emit({ type: "status", text: "输入 /accept 开始故事；或继续输入修改意见。" });
		} else {
			this.emit({ type: "error", message: "调整失败，可再次尝试或 /accept 接受现有版本。" });
		}
	}

	// -- 场景主循环 --------------------------------------------------------------

	/** 玩家通过聊天意见修订当前弧大纲（playing 阶段，「大纲：意见」或 outline 命令触发） */
	private outlineBusy = false;
	async reviseArc(feedback: string): Promise<void> {
		if (this.state.phase !== "playing" || !this.state.arc) {
			this.emit({ type: "error", message: "当前阶段没有可修订的弧大纲（进入故事后输入「大纲：你的意见」）" });
			return;
		}
		if (this.outlineBusy) {
			this.emit({ type: "status", text: "导播正在修订大纲，稍等……" });
			return;
		}
		this.outlineBusy = true;
		try {
			this.emit({ type: "status", text: "导播正在按意见修订弧大纲……" });
			const collector: ToolCollector = {};
			await runAgent({
				role: "director",
				llm: this.llm,
				system: OUTLINE_SYSTEM,
				tools: [...sharedReadTools(this.store), arcRevisionTool(this.store, collector, this.state.arcCount)],
				prompt: `读者对当前弧大纲提出调整意见：「${feedback}」\n\n当前是第 ${this.state.arcCount} 弧「${this.state.arc.title}」，目标：${this.state.arc.goal}\n\n请先用 read_bible / search_story 了解设定与已有剧情，然后调用 save_arc_revision 提交修订后的弧大纲：目标必须吸收读者意见，并与已有剧情、已埋伏笔连贯；标题一般保留，除非意见要求更改。`,
				onProcess: this.proc("director", true),
			});
			const rev = collector.arcRevision;
			if (rev && rev.title.trim() && rev.goal.trim()) {
				this.state.arc = { ...this.state.arc, title: rev.title.trim(), goal: rev.goal.trim() };
				await this.commit();
				this.emit({ type: "outline_updated", arc: this.state.arcCount, title: rev.title.trim(), goal: rev.goal.trim() });
				this.emit({ type: "status", text: `弧大纲已修订：「${rev.title.trim()}」` });
			} else {
				this.emit({ type: "error", message: "大纲修订未完成，可再试一次。" });
			}
		} finally {
			this.outlineBusy = false;
		}
	}

	private async beginArc(n: number): Promise<void> {
		const arc = await this.store.loadArc(n);
		if (!arc) {
			this.emit({ type: "error", message: `缺少弧 ${n} 的大纲` });
			return;
		}
		this.state.arc = arc;
		this.state.arcCount = Math.max(this.state.arcCount, n);
		this.state.arcBeatIndex = 1;
		this.state.attempt = 0;
		this.emit({ type: "status", text: `第 ${n} 弧「${arc.title}」开始，目标：${arc.goal}` });
		await this.setPhase("playing");
		await this.runScene();
	}

	/** 读者最近一次选择文本（大纲承接性预检用） */
	private async lastChoiceText(): Promise<string | null> {
		const history = await this.store.readText("记忆/选择历史.jsonl");
		const lastLine = history?.trim().split("\n").pop();
		if (!lastLine) return null;
		try {
			return (JSON.parse(lastLine) as { choice?: string }).choice ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * 场大纲推演（两段式）：导播出大纲 → 确定性预检 → 校对审核 → 不过则带意见返工（≤2 轮）。
	 * 审核通过后大纲与审核意见一起进入 Writer 上下文。
	 */
	private async deriveOutline(): Promise<void> {
		this.emit({ type: "status", text: "导播正在根据现有剧情推演本场景大纲……" });
		const knownNames = (await this.store.loadCharacters()).map((c) => c.name);
		const lastChoice = await this.lastChoiceText();
		let issues: { quote: string; constraint: string; problem: string }[] = [];
		let outline = "";
		for (let round = 0; ; round++) {
			const dCollector: ToolCollector = {};
			await runAgent({
				role: "director",
				llm: this.llm,
				system: OUTLINE_SYSTEM,
				tools: [...sharedReadTools(this.store), sceneOutlineTool(this.store, dCollector)],
				prompt: await assembleOutlineDerivationPrompt(this.store, this.state, round > 0 ? issues : undefined),
				onProcess: this.proc("director", true),
			});
			outline = dCollector.nextOutline?.outline.trim() ?? "";
			if (!outline) {
				this.emit({ type: "error", message: "导播未产出场大纲，本场景按上一场结尾自然延续。" });
				outline = "自然延续上一场结尾，让情节有机推进";
				break;
			}

			// 确定性预检：字数出格直接打回（零 LLM 成本）
			const hard = outlineGateHard(outline);
			if (hard.length > 0) {
				issues = hard;
				if (round >= 2) {
					this.emit({ type: "status", text: `大纲预检 ${round + 1} 轮仍不达标，带意见交写手。` });
					break;
				}
				this.emit({ type: "status", text: `大纲预检未过（${hard[0]!.problem}），导播修订中……` });
				continue;
			}

			// 软性疑点（承接性、未登记名扫描）喂给审核，作为打回依据的参考
			const notes = [...outlineGateNotes(outline, lastChoice), outlineCastNote(outline, knownNames)].filter((n): n is string => !!n);
			const vCollector: ToolCollector = {};
			await runAgent({
				role: "reviewer",
				llm: this.llm,
				system: REVIEWER_SYSTEM,
				tools: [...sharedReadTools(this.store), verdictTool(vCollector)],
				prompt: await assembleOutlineReviewPrompt(this.store, this.state, outline, notes),
				onProcess: this.proc("reviewer", true),
			});
			const verdict = vCollector.verdict;
			if (!verdict || verdict.pass) {
				if (round > 0) this.emit({ type: "status", text: `大纲修订 ${round} 轮后通过审核。` });
				break;
			}
			issues = verdict.issues;
			if (round >= 2) {
				this.emit({ type: "status", text: `大纲审核 ${round} 轮仍有疑义，带意见直接交写手（意见会传入写作上下文）。` });
				break;
			}
			this.emit({ type: "status", text: `大纲未过审（${issues.length} 条意见），导播修订中……` });
		}
		this.state.currentOutline = outline;
		this.state.outlineNotes = issues.length > 0 ? issues.map((i) => `- ${i.problem}（修改方向：${i.constraint}）`).join("\n") : undefined;
		await this.commit();
	}

	private async runScene(): Promise<void> {
		if (this.state.phase !== "playing" || !this.state.arc) return;

		// 0) 两段式推演：若无大纲（第一弧第一场用开局时的开场拍），导播推演场大纲 → 校对审核
		if (!this.state.currentOutline) {
			if (this.state.arcBeatIndex === 1 && this.state.sceneIndex === 0) {
				this.state.currentOutline = (await this.store.readJson<{ openingBeat?: string }>("设定/开场拍.json"))?.openingBeat ?? "";
			}
			if (!this.state.currentOutline) {
				await this.setSubstate("outlining");
				await this.deriveOutline();
			}
		}
		if (this.state.currentOutline) {
			this.emit({ type: "scene_outline", scene: this.state.sceneIndex + 1, text: this.state.currentOutline });
		}
		this.emit({ type: "status", text: `场景 ${this.state.sceneIndex + 1}（弧内第${this.state.arcBeatIndex}拍）开写：${(this.state.currentOutline ?? "").slice(0, 60)}…` });

		// 1) Writer 写稿（流式）
		this.state.attempt = 0;
		this.diceBudget = { used: 0, max: 3 };
		await this.setSubstate("writing");
		let draft = await this.callWriter();
		let loopIssues = detectRepetitionLoop(draft);

		// 2) Reviewer 校验 → 打回重写环（复读检测是确定性的本地检查，优先于 LLM 校对）
		await this.setSubstate("reviewing");
		for (;;) {
			const verdict =
				loopIssues.length > 0
					? { pass: false, issues: loopIssues }
					: await this.review(draft);
			if (verdict.pass) break;
			if (this.state.attempt >= ENGINE.maxRewrites) {
				this.emit({ type: "status", text: `重写 ${ENGINE.maxRewrites} 次仍有疑义，继续呈现；可用 /steer 干预后续走向。` });
				break;
			}
			this.state.attempt += 1;
			await this.commit();
			this.emit({ type: "status", text: `校对未通过（第 ${this.state.attempt} 次重写）……` });
			await this.setSubstate("rewriting");
			draft = await this.callWriter(verdict.issues);
			loopIssues = detectRepetitionLoop(draft);
		}

		// 3) 定稿落盘 + 呈现
		await this.setSubstate("settling");
		this.state.sceneIndex += 1;
		const title = `场景${this.state.sceneIndex}`;
		await this.store.saveSceneText(this.state.sceneIndex, title, draft);
		await this.commit();
		this.emit({ type: "scene_done", scene: this.state.sceneIndex, title, text: draft });

		// 4) Director 场景报告（摘要/状态/伏笔/走向候选；落盘前过确定性门禁）
		const rawReport = await this.directorReport(draft);
		let report: SceneReport | null = null;
		if (rawReport) {
			report = await this.persistReport(rawReport);
		}
		if (!report || report.choices.length === 0) {
			this.emit({ type: "error", message: "导播未产出走向候选，请 /steer 指定走向。" });
			await this.advanceAfterChoice(null);
			return;
		}

		// 5) 走向决定（auto 自动 / manual 等玩家）
		this.state.pendingReport = report;
		await this.setSubstate("choosing");
		if (this.state.mode === "auto") {
			const idx = Math.min(Math.max(report.recommendedChoice ?? 1, 1), report.choices.length) - 1;
			const picked = report.choices[idx];
			if (!picked) {
				this.emit({ type: "error", message: "导播的走向候选为空" });
				return;
			}
			this.emit({ type: "choices", scene: this.state.sceneIndex, choices: report.choices, recommended: idx + 1 });
			this.emit({ type: "status", text: `自动选择：${picked.label}（可用 /mode manual 切换为手动）` });
			await this.advanceAfterChoice(`${picked.label}——${picked.description}`);
		} else {
			this.presentChoices(report);
		}
	}

	private presentChoices(report: SceneReport): void {
		this.emit({ type: "choices", scene: this.state.sceneIndex, choices: report.choices, recommended: report.recommendedChoice });
	}

	/** 玩家在交互区输入选择（序号/自由文本）；auto 模式由引擎直接调用 */
	async resolveChoice(input: string): Promise<void> {
		if (this.state.phase !== "playing" || !this.state.pendingReport) return;
		const report = this.state.pendingReport;
		const num = Number(input.trim());
		const picked = Number.isInteger(num) ? report.choices[num - 1] : undefined;
		const choice = picked ? `${picked.label}——${picked.description}` : input.trim();
		this.state.pendingReport = null;
		await this.advanceAfterChoice(choice);
	}

	private async advanceAfterChoice(choice: string | null): Promise<void> {
		if (this.state.phase !== "playing") return;
		if (choice) {
			const source = this.state.mode === "auto" ? "auto" : "player";
			await this.store.appendChoice(this.state.sceneIndex, choice, source);
		}

		// 弧边界判断（弧长由 scenesPerArc 决定；拍子不再预排）
		if (this.state.arcBeatIndex >= ENGINE.scenesPerArc) {
			await this.setPhase("arc_boundary");
			await this.runArcBoundary();
			return;
		}
		this.state.arcBeatIndex += 1;
		this.state.attempt = 0;
		await this.commit();
		await this.runScene();
	}

	private async runArcBoundary(): Promise<void> {
		this.emit({ type: "status", text: "本弧完结，导播正在收束……" });
		// 弧摘要（一次性补全调用，不走 agent 工具环）
		const summaries = await this.store.recentSummaries(this.state.sceneIndex, ENGINE.scenesPerArc + 2);
		const arcSummaryText = `## 弧「${this.state.arc?.title ?? ""}」总结\n${summaries.map((s) => `场景${s.scene}：${s.summary}`).join("\n")}`;
		await this.store.saveArcSummary(arcSummaryText);
		this.emit({ type: "arc_boundary", summary: `已写入弧摘要（${summaries.length} 个场景）。` });

		// 记忆蒸馏（幂等：不达标即跳过，0 成本）
		await this.distillMemories();

		// v1 验证目标为单弧短篇：弧满即完结；多弧规划作为后续迭代
		await this.setPhase("ended");
		this.emit({ type: "ended" });
	}

	/** 记忆蒸馏：弧摘要 >2500 字整体压缩；角色所知 >10 条或小传 >300 字时压缩进小传 */
	private async distillMemories(): Promise<void> {
		try {
			// 1) 弧摘要蒸馏
			const arcSummary = await this.store.readText("记忆/弧摘要.md");
			if (arcSummary && arcSummary.length > 2500) {
				const result = await runAgent({ role: "director", llm: this.llm, system: DISTILL_SYSTEM, tools: [], prompt: assembleArcDistillPrompt(arcSummary) });
				const distilled = result.text.trim().slice(0, 1000); // 蒸馏上限落进代码，不信任模型自觉
				if (distilled.length > 100 && distilled.length < arcSummary.length) {
					await this.store.replaceArcSummary(distilled);
					this.emit({ type: "status", text: `记忆蒸馏：弧摘要 ${arcSummary.length} 字 → ${distilled.length} 字。` });
				}
			}

			// 2) 角色记忆蒸馏
			const cards = await this.store.loadCharacters();
			const need = cards.filter((c) => (c.state.knowledge?.length ?? 0) > 10 || c.basics.length > 300);
			if (need.length === 0) return;
			const collector: ToolCollector = {};
			await runAgent({
				role: "director",
				llm: this.llm,
				system: DISTILL_SYSTEM,
				tools: [...sharedReadTools(this.store), memoryDistillTool(collector)],
				prompt: await assembleMemoryDistillPrompt(this.store, this.state),
				onProcess: this.proc("director", true),
			});
			const distilledChars = collector.distilled?.characters ?? [];
			for (const d of distilledChars) {
				const card = cards.find((c) => c.name === d.name);
				if (!card || !d.basics.trim()) continue;
				await this.store.saveCharacter({
					...card,
					// 蒸馏结果裁剪进代码：小传 ≤400 字、单条所知 ≤120 字（不信任模型自觉）
					basics: d.basics.trim().slice(0, 400),
					state: { ...card.state, knowledge: d.knowledge.map((k) => k.trim()).filter(Boolean).map((k) => k.slice(0, 120)).slice(-10) },
				});
			}
			if (distilledChars.length > 0) {
				this.emit({ type: "status", text: `记忆蒸馏：${distilledChars.length} 个角色的长期记忆已压缩。` });
			}
		} catch (err) {
			this.emit({ type: "status", text: `记忆蒸馏跳过：${err instanceof Error ? err.message : err}` });
		}
	}

	// -- 角色调用 ----------------------------------------------------------------

	private async callWriter(issues?: { quote: string; constraint: string; problem: string }[]): Promise<string> {
		const basePrompt = await assembleWriterPrompt(this.store, this.state);
		const prompt =
			issues && issues.length > 0
				? `${basePrompt}\n\n## 校对打回（上一稿与约束清单矛盾，必须修复）\n${issues.map((i, n) => `${n + 1}. 「${i.quote}」违反 ${i.constraint}：${i.problem}`).join("\n")}`
				: basePrompt;

		this.emit({ type: "status", text: "执笔中……" });
			const result = await runAgent({
				role: "writer",
				llm: this.llm,
				system: WRITER_SYSTEM,
				tools: [...sharedReadTools(this.store), d20CheckTool(this.store, this.state.sceneIndex + 1, this.diceBudget)],
				prompt,
			onDelta: (t) => this.emit({ type: "scene_delta", text: t }),
			onProcess: this.proc("writer", false),
			onStart: (control) => {
				this.currentSteer = control.steer;
			},
		});
		this.currentSteer = null;
		if (!result.text.trim()) {
			throw new Error("Writer 返回了空稿");
		}
		// 防御性清理：剔除正文中偶发的状态标记/分隔线样式残留（正文只会进章稿，不影响状态解析，仅为阅读干净）
		return result.text
			.replace(/<!--\/?STATE-->/g, "")
			.replace(/^[ \t]*-{3,}[ \t]*$/gm, "")
			.trim();
	}

	private async review(draft: string): Promise<{ pass: boolean; issues: { quote: string; constraint: string; problem: string }[] }> {
		this.emit({ type: "status", text: "校对中……" });
		// 确定性预检：草稿中的金额数字与角色余额并排喂给校对（金额幻觉高发区）
		const currency = extractCurrency(await this.store.loadEconomy());
		const notes = draftPrecheckNotes(draft, currency);
		const collector: ToolCollector = {};
		await runAgent({
			role: "reviewer",
			llm: this.llm,
			system: REVIEWER_SYSTEM,
			tools: [...sharedReadTools(this.store), verdictTool(collector)],
			prompt: await assembleReviewerPrompt(this.store, this.state, draft, notes),
			onProcess: this.proc("reviewer", true),
		});
		const verdict = collector.verdict;
		if (!verdict) {
			this.emit({ type: "status", text: "校对未返回结论，按通过处理。" });
			return { pass: true, issues: [] };
		}
		this.emit({ type: "review", attempt: this.state.attempt, pass: verdict.pass, issues: verdict.issues });
		return verdict;
	}

	private async directorReport(sceneText: string): Promise<SceneReport | null> {
		this.emit({ type: "status", text: "导播更新状态与走向候选……" });
		const collector: ToolCollector = {};
		await runAgent({
			role: "director",
			llm: this.llm,
			system: REPORT_SYSTEM,
			tools: [...sharedReadTools(this.store), sceneReportTool(collector)],
			prompt: assembleDirectorReportPrompt(this.state, sceneText),
			onProcess: this.proc("director", true),
		});
		return collector.report ?? null;
	}

	private async persistReport(raw: SceneReport): Promise<SceneReport> {
		// 报告门禁：未知角色补丁/流水丢弃、金额钳制、choices 复验、摘要截断（全部确定性）
		const cards = await this.store.loadCharacters();
		const { report, warnings } = sanitizeReport(raw, cards.map((c) => c.name));
		for (const w of warnings) this.emit({ type: "status", text: `报告门禁：${w}` });
		await this.store.saveSceneSummary(this.state.sceneIndex, report);
		await applyCharacterPatches(this.store, report.characterUpdates);
		await applyForeshadowOps(this.store, report.foreshadowOps, this.state.sceneIndex);
		// 经济结算：余额由代码记账，LLM 只申报流水
		const financeWarnings = await applyTransactions(this.store, this.state.sceneIndex, report.transactions ?? []);
		for (const w of financeWarnings) {
			this.emit({ type: "status", text: `经济提醒：${w}` });
		}
		// 本场大纲已用完：清空，下一场由导播根据（本场报告+读者选择）重新推演
		this.state.currentOutline = undefined;
		this.state.outlineNotes = undefined;
		await this.commit();
		return report;
	}

	// -- 运行时控制（TUI 调用） -----------------------------------------------------

	async setMode(mode: PlayMode): Promise<void> {
		this.state.mode = mode;
		await this.commit();
		this.emit({ type: "status", text: `模式切换为 ${mode === "auto" ? "自动（挂机阅读）" : "手动（每场景做选择）"}` });
	}

	/** 写作进行中插话，影响当前场景 */
	steer(text: string): void {
		if (this.currentSteer) {
			this.currentSteer(text);
			this.emit({ type: "status", text: "已把你的插话转给执笔。" });
		} else {
			this.emit({ type: "status", text: "当前没有进行中的写作；插话将在下一场景走向中考虑（作为自由选择提交）。" });
		}
	}

	async save(name: string): Promise<void> {
		await this.store.writeJson(`存档/${name}.json`, this.state);
		this.emit({ type: "status", text: `已存档：${name}` });
	}

	async restart(): Promise<void> {
		this.state = Engine.initialState();
		await this.commit();
		this.emit({ type: "status", text: "已重置。输入故事灵感开始新故事。" });
	}
}

import { ENGINE, defaultLlmSettings, normalizeLlm, validateLlm } from "../config.js";
import { runAgent } from "../agents/agents.js";
import { arcRevisionTool, arcPlanTool, designStoryTool, d20CheckTool, memoryDistillTool, saveHistoryNotesTool, sceneOutlineTool, sceneReportTool, sharedReadTools, verdictTool, webSearchTool, type ToolCollector } from "../agents/tools.js";
import { ARC_PLAN_SYSTEM, DESIGN_SYSTEM, DISTILL_SYSTEM, IDEA_SYSTEM, OUTLINE_SYSTEM, REPORT_SYSTEM, REVIEWER_SYSTEM, WRITER_SYSTEM } from "../agents/prompts.js";
import type { Store } from "../facts/store.js";
import type { GameState, PlayMode, RuntimeSettings, SceneReport, StoryDesign } from "../facts/types.js";
import { createLlm, specFromSettings, type Llm } from "../llm.js";
import { assembleArcPlanPrompt, assembleBootPrompt, assembleDirectorReportPrompt, assembleMemoryDistillPrompt, assembleArcDistillPrompt, assembleOutlineDerivationPrompt, assembleOutlineReviewPrompt, assembleReviewerPrompt, assembleWriterPrompt, draftPrecheckNotes, extractCurrency } from "./context.js";
import { applyCharacterPatches, applyEntityPatches, applyForeshadowOps, applyTransactions, sanitizeReport } from "./settle.js";
import { detectRepetitionLoop, designIssues, outlineCastNote, outlineGateHard, outlineGateNotes, sanitizeDesign } from "./validate.js";
import { initialState as initialGameState, normalizeState } from "./state.js";
import { setActiveContextWindow } from "./context.js";

// ---------------------------------------------------------------------------
// 确定性场景引擎：状态机主循环零 LLM 逻辑，LLM 只在角色调用中发生。
// 每个状态变更后原子落盘 autosave，进程崩溃后可从 current.json 恢复。
// 状态工厂/归一化在 state.ts，确定性校验在 validate.ts。
// ---------------------------------------------------------------------------

/** 存档名白名单（存档/与 分叉入档共用）：字母数字_- 与中文，防路径逃逸 */
const SAVE_NAME_RE = /^[\w一-鿿-]{1,64}$/;

export type EngineEvent =
	| { type: "phase"; phase: GameState["phase"] }
	| { type: "status"; text: string }
	| { type: "idea_user"; text: string }
	| { type: "idea_delta"; text: string }
	| { type: "idea_done"; text: string }
	| { type: "scene_delta"; text: string }
	| { type: "scene_done"; scene: number; title: string; text: string }
	| { type: "review"; pass: boolean; issues: { quote: string; constraint: string; problem: string }[] }
	| { type: "agent_process"; role: "director" | "writer" | "reviewer"; kind: "delta" | "tool"; text: string }
	| { type: "boot_ready"; title: string; premise: string; characters: string[]; arcTitle: string; arcGoal: string; openingBeat: string }
	| { type: "scene_outline"; scene: number; text: string }
	| { type: "outline_updated"; arc: number; title: string; goal: string }
	| { type: "choices"; scene: number; choices: { label: string; description: string; preview?: string }[]; recommended?: number }
	| { type: "arc_boundary"; summary: string }
	| { type: "ended" }
	| { type: "error"; message: string };

export class Engine {
	private state: GameState = initialGameState();
	private currentSteer: ((text: string) => void) | null = null;

	/** 运行时设置（boot 时从工作区加载，设置界面热更新） */
	settings: RuntimeSettings = { scenesPerArc: ENGINE.scenesPerArc, maxArcs: ENGINE.maxArcs, webSearch: true, llm: defaultLlmSettings() };

	constructor(
		public readonly store: Store,
		private llm: Llm,
		public emit: (event: EngineEvent) => void,
	) {}

	/** 按当前模型窗口刷新上下文各层 CAP（取三角色最小窗口，保证任何角色都不溢出） */
	private syncCaps(): void {
		try {
			const wins = (["director", "writer", "reviewer"] as const).map((r) => this.llm.model(r).contextWindow);
			setActiveContextWindow(Math.min(...wins));
		} catch {
			// 模型缺失等异常：保持 16k 基准（capsFor 的默认）
		}
	}

	/** 更新运行时设置：校验→落盘→生效（下一场景循环即用新值）。返回错误信息（null=成功） */
	async updateSettings(patch: Partial<RuntimeSettings>): Promise<string | null> {
		const next = { ...this.settings };
		if (patch.scenesPerArc !== undefined) {
			const n = Math.round(Number(patch.scenesPerArc));
			if (!Number.isFinite(n) || n < 2 || n > 50) return "每弧场景数须为 2-50 的整数";
			next.scenesPerArc = n;
		}
		if (patch.maxArcs !== undefined) {
			const n = Math.round(Number(patch.maxArcs));
			if (!Number.isFinite(n) || n < 1 || n > 20) return "弧数上限须为 1-20 的整数";
			next.maxArcs = n;
		}
		if (patch.webSearch !== undefined) next.webSearch = Boolean(patch.webSearch);
		if (patch.llm !== undefined) {
			const llm = normalizeLlm(patch.llm);
			const err = validateLlm(llm);
			if (err) return err;
			next.llm = llm;
			// 热重建 LLM 接入：下一角色调用即使用新服务商（在途调用仍用旧接入，无害）
			this.llm = createLlm(specFromSettings(llm));
			this.syncCaps();
		}
		this.settings = next;
		await this.store.saveSettings(next);
		this.emit({
			type: "status",
			text: `设置已更新：每弧 ${next.scenesPerArc} 场 · 弧上限 ${next.maxArcs} · 联网查证${next.webSearch ? "开" : "关"}${next.llm ? ` · 模型[${next.llm.provider}:${next.llm.modelId}]` : ""}`,
		});
		return null;
	}

	get gameState(): GameState {
		return this.state;
	}

	/** 引擎是否正在推进剧情（场景/设计流水线在途）：restart/load/fork 应避开 */
	get isBusy(): boolean {
		return this.pipelineBusy;
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
		p.catch((err) => {
			this.pipelineBusy = false; // 出错必须解除互斥，否则 restart/load 被永久挡住
			this.clearControl();
			if (this.aborting || (err instanceof Error && err.message.includes("被中止"))) {
				// 用户主动中断：非错误，回到稳定态即可
				this.aborting = false;
				this.emit({ type: "status", text: "已中断本次生成，进度停留在上一个稳定点。" });
				return;
			}
			this.emit({ type: "error", message: `引擎错误：${err?.message ?? err}` });
		});
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
		this.settings = await this.store.loadSettings();
		this.syncCaps();
		const saved = await this.store.readJson<GameState>("存档/current.json");
		if (saved && saved.phase === "ended") {
			// 上局已完结：以空局进入，但保留完结信息提示
			await this.setPhase("empty");
			this.emit({ type: "status", text: `上一部《${saved.title || "未命名"}》已完结。输入新灵感（或先聊聊）开始下一部。` });
			return;
		}
		await this.restoreOrEmpty(saved);
	}

	/** 从状态快照恢复（boot 与 load 共用）；空快照则进入空局。旧版本存档在此统一归一化 */
	private async restoreOrEmpty(saved: GameState | null): Promise<void> {
		if (saved && saved.phase !== "empty" && saved.phase !== "ended") {
			this.state = normalizeState(saved);
			this.emit({ type: "phase", phase: saved.phase });
			this.emit({ type: "status", text: `已恢复进度：${saved.title || "未命名"}，第 ${saved.sceneIndex} 场` });
			if (saved.phase === "playing" && saved.pendingReport) {
				this.presentChoices(saved.pendingReport);
			} else if (saved.phase === "playing" && saved.substate === "choosing") {
				// 崩溃窗口：选择已被消费（pendingReport=null 已提交）但走向尚未记账——
				// 记录已丢失，按自然延续推进下一场（不重复结算本场景）
				this.emit({ type: "status", text: `上次在选择时中断且走向记录丢失，第 ${saved.sceneIndex} 场后按自然延续推进。` });
				this.void(this.advanceAfterChoice(null));
			} else if (saved.phase === "playing") {
				const labels: Record<string, string> = {
					writing: "执笔写作",
					reviewing: "校对审阅",
					settling: "场景定稿落盘",
				};
				const label = labels[saved.substate ?? ""];
				if (label) {
					this.emit({ type: "status", text: `上次在第 ${saved.sceneIndex + 1} 场的${label}中中断，本场景将重新生成。` });
				}
				this.void(this.runScene());
			} else if (saved.phase === "bootstrapping") {
				// 设计流程中断：premise 还在，自动重新设计（storyId 不变，继续写同一个故事存档）
				if (saved.premise?.trim()) {
					this.emit({ type: "status", text: "上次开局设计被中断，正在重新设计……" });
					await this.setPhase("empty");
					this.void(this.startPremise(saved.premise));
				} else {
					this.emit({ type: "status", text: "上次开局被中断且灵感记录为空，输入新灵感重新开始。" });
					await this.setPhase("empty");
				}
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

	/** 存档位列表（不含 autosave 的 current.json；parent 构成存档树） */
	async listSaves(): Promise<{ name: string; title: string; phase: string; sceneIndex: number; updatedAt: string; parent: string | null }[]> {
		// 降级是有意为之：存档目录可能尚未创建（全新世界），此时视为无存档，非吞错
		const files = await this.store.listDir("存档").catch(() => [] as string[]);
		const out: { name: string; title: string; phase: string; sceneIndex: number; updatedAt: string; parent: string | null }[] = [];
		for (const f of files.filter((x) => x.endsWith(".json") && x !== "current.json")) {
			const s = await this.store.readJson<GameState>(`存档/${f}`);
			if (s) out.push({ name: f.replace(/\.json$/, ""), title: s.title ?? "", phase: s.phase ?? "", sceneIndex: s.sceneIndex ?? 0, updatedAt: s.updatedAt ?? "", parent: s.saveParent ?? null });
		}
		return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
	}

	/** 读档：把存档快照恢复为当前进度（ended 存档按原样恢复供回看） */
	async load(name: string): Promise<void> {
		if (this.pipelineBusy) {
			this.emit({ type: "error", message: "引擎正在推进剧情（写作/校对/结算中），请稍后再读档。" });
			return;
		}
		if (!SAVE_NAME_RE.test(name)) {
			this.emit({ type: "error", message: "存档名只能含中文、字母、数字、_ 或 -，长度 ≤64" });
			return;
		}
		const saved = await this.store.readJson<GameState>(`存档/${name}.json`);
		if (!saved) {
			this.emit({ type: "error", message: `存档「${name}」不存在` });
			return;
		}
		saved.saveParent = name; // 记录谱系：此后 /save 的新存档在树上挂在 name 之下
		if (!saved.ideaMsgs) saved.ideaMsgs = [];
		this.currentSteer = null;
		this.ideaBusy = false;
		if (saved.phase === "ended") {
		this.state = normalizeState(saved);
		this.emit({ type: "phase", phase: "ended" });
			this.emit({ type: "status", text: `已读档：《${saved.title || "未命名"}》（已完结，可回看；/restart 开新故事）` });
			return;
		}
		await this.restoreOrEmpty(saved);
	}

	/** 灵感对话互斥锁：上一轮回复未结束前忽略新输入 */
	private ideaBusy = false;

	/** 场景/设计流水线在途标志：runScene 入口置位，到达等待玩家的节点（choosing/ended）或出错时清除 */
	private pipelineBusy = false;

	/** d20 判定硬预算：每场重置（约束在代码，不在 prompt） */
	private diceBudget = { used: 0, max: 3 };

	/** 当前在途 LLM 调用的中止句柄（runAgent onStart 挂入，正常结束/出错即清除） */
	private currentAbort: (() => void) | null = null;

	/** 用户主动中断标志：让 void() 把中止识别为正常操作而非引擎错误 */
	private aborting = false;

	/** 开局模板（premise_chat 阶段累积，构建后用于 Director 设计） */
	private template: Partial<import("../facts/types.js").PremiseTemplate> = {};

	/** 中断当前生成：流式调用以 aborted 收尾，引擎回到上一个稳定态（中断点由存档恢复机制兜底） */
	abortGeneration(): boolean {
		if (!this.currentAbort) return false;
		this.aborting = true;
		const abort = this.currentAbort;
		this.currentAbort = null;
		abort();
		this.emit({ type: "status", text: "正在中断生成……" });
		return true;
	}

	/** runAgent 的 onStart 统一挂钩：登记 steer/abort 句柄 */
	private grabControl() {
		return (control: { steer: (text: string) => void; abort: () => void }) => {
			this.currentSteer = control.steer;
			this.currentAbort = control.abort;
		};
	}

	/** 调用结束（正常/异常）后清句柄并复位中断标志 */
	private clearControl(): void {
		this.currentSteer = null;
		this.currentAbort = null;
		this.aborting = false;
	}

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
				onStart: this.grabControl(),
			});
			const reply = result.text.trim() || "（导播走神了一下，再说一遍？）";
			this.state.ideaMsgs.push({ role: "assistant", text: reply });
			await this.commit();
			this.emit({ type: "idea_done", text: reply });
		} finally {
			this.ideaBusy = false;
		}
	}

	// ---------------------------------------------------------------------------
	// 开局模板多轮对话：结构化收集故事前提，Director 据此生成完整设计
	// ---------------------------------------------------------------------------

	/** 开局模板字段列表（按对话顺序收集） */
	private static readonly TEMPLATE_FIELDS = [
		{ key: "genre", label: "故事类型", hint: "如：都市异能、历史、科幻、奇幻、悬疑、爱情" },
		{ key: "protagonist", label: "主角设定", hint: "名字、性格、背景、能力、动机" },
		{ key: "worldSetting", label: "世界观", hint: "时代、地点、社会结构、特殊规则、魔法体系..." },
		{ key: "tone", label: "故事基调", hint: "轻松幽默、悬疑紧张、史诗宏大、黑暗沉重、温馨治愈..." },
		{ key: "firstArcGoal", label: "第一弧目标", hint: "主角要达成什么？面临什么挑战？" },
		{ key: "conflictSource", label: "冲突来源", hint: "外部威胁、内部矛盾、谜题、成长考验..." },
		{ key: "audience", label: "目标读者", hint: "影响写作风格和内容尺度（如：青少年、成人、网文读者）" },
	] as const;

	/** 当前模板对话记录 */
	private premiseMsgs: { role: "user" | "assistant"; text: string }[] = [];

	/** 模板对话互斥锁 */
	private premiseBusy = false;

	/** 当前填写到哪个字段（0-based，-1 表示已完成） */
	private templateFieldIndex = -1;

	/** 多轮对话收集开局模板：逐字段引导，直到模板完成 */
	async chatPremise(text: string): Promise<void> {
		if (this.state.phase !== "empty" && this.state.phase !== "premise_chat") return;
		if (this.premiseBusy) {
			this.emit({ type: "status", text: "导播正在回复，稍等它说完……" });
			return;
		}
		this.premiseBusy = true;
		try {
			if (this.state.phase === "empty") {
				await this.setPhase("premise_chat");
				this.templateFieldIndex = 0;
				// 首次进入：发送欢迎消息和第一个字段引导
				const firstField = Engine.TEMPLATE_FIELDS[0];
				const welcome = `【开局模板】我需要了解你的故事构想，一共 ${Engine.TEMPLATE_FIELDS.length} 个问题，逐个回答即可。\n\n第一个问题：${firstField.label}\n（${firstField.hint}）`;
				this.premiseMsgs.push({ role: "assistant", text: welcome });
				this.emit({ type: "idea_done", text: welcome });
				return;
			}

			// 记录用户回答
			this.premiseMsgs.push({ role: "user", text });

			// 尝试从回答中提取当前字段的值
			const currentField = Engine.TEMPLATE_FIELDS[this.templateFieldIndex];
			if (currentField) {
				(this.template as any)[currentField.key] = text.trim();
			}

			// 移动到下一个字段
			this.templateFieldIndex++;

			// 检查是否所有字段都已完成
			if (this.templateFieldIndex >= Engine.TEMPLATE_FIELDS.length) {
				// 模板完成：显示摘要并询问是否开始设计
				const summary = this.buildTemplateSummary();
				const completionMsg = `【模板完成】你的故事构想：\n\n${summary}\n\n输入「开始」生成完整开局设计；或输入修改意见调整模板。`;
				this.premiseMsgs.push({ role: "assistant", text: completionMsg });
				this.emit({ type: "idea_done", text: completionMsg });
				this.templateFieldIndex = -1; // 标记完成
				return;
			}

			// 引导下一个字段
			const nextField = Engine.TEMPLATE_FIELDS[this.templateFieldIndex];
			if (!nextField) {
				this.templateFieldIndex = -1;
				return;
			}
			const progress = `[${this.templateFieldIndex + 1}/${Engine.TEMPLATE_FIELDS.length}]`;
			const guide = `${progress} 下一个问题：${nextField.label}\n（${nextField.hint}）`;
			this.premiseMsgs.push({ role: "assistant", text: guide });
			this.emit({ type: "idea_done", text: guide });

			await this.commit();
		} finally {
			this.premiseBusy = false;
		}
	}

	/** 构建模板摘要（Markdown 格式） */
	private buildTemplateSummary(): string {
		const fields = Engine.TEMPLATE_FIELDS;
		return fields.map((f) => {
			const value = (this.template as any)[f.key] ?? "（未填写）";
			return `**${f.label}**：${value}`;
		}).join("\n");
	}

	/** 从模板构建开局：将模板转为一句话前提，调用 startPremise */
	async buildFromPremise(): Promise<void> {
		if (this.state.phase !== "premise_chat") return;

		// 检查模板是否完整
		const requiredFields = Engine.TEMPLATE_FIELDS;
		const missing = requiredFields.filter((f) => !(this.template as any)[f.key]?.trim());
		if (missing.length > 0) {
			this.emit({ type: "error", message: `模板未完成：${missing.map((f) => f.label).join("、")} 未填写` });
			return;
		}

		// 构建一句话前提
		const premise = [
			this.template.genre,
			`主角${this.template.protagonist}`,
			this.template.worldSetting,
			`基调${this.template.tone}`,
			this.template.firstArcGoal,
		].join("，");

		// 保存模板到 store（备查）
		await this.store.writeJson("设定/开局模板.json", this.template);

		// 调用现有的 startPremise
		await this.startPremise(premise);
	}

	/** 模板修改：允许用户直接修改模板字段 */
	async modifyTemplate(field: string, value: string): Promise<void> {
		if (this.state.phase !== "premise_chat") return;
		const validField = Engine.TEMPLATE_FIELDS.find((f) => f.key === field);
		if (!validField) {
			this.emit({ type: "error", message: `未知字段：${field}。可修改字段：${Engine.TEMPLATE_FIELDS.map((f) => f.key).join("、")}` });
			return;
		}
		(this.template as any)[field] = value.trim();
		const confirmMsg = `已更新「${validField.label}」：${value.trim()}`;
		this.emit({ type: "status", text: confirmMsg });
		await this.commit();
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
				onStart: this.grabControl(),
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
			tools: [...sharedReadTools(this.store), ...(this.settings.webSearch ? [webSearchTool(), saveHistoryNotesTool(this.store)] : []), designStoryTool(this.store, collector)],
			prompt: assembleBootPrompt(premise),
			onProcess: this.proc("director", true),
			onStart: this.grabControl(),
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
			tools: [...sharedReadTools(this.store), ...(this.settings.webSearch ? [webSearchTool(), saveHistoryNotesTool(this.store)] : []), designStoryTool(this.store, collector)],
			prompt: `读者对现有开局设计提出了修改意见：「${feedback}」\n\n请调用 read_bible 查看现有设定后，调用 design_story 重新提交完整开局设计（在原有基础上按意见调整）。`,
			onProcess: this.proc("director", true),
			onStart: this.grabControl(),
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
				onStart: this.grabControl(),
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
	 * 跟踪最优大纲：如果多轮都不完美，选取通过硬 gate 且审核意见最少的那一轮。
	 */
	private async deriveOutline(): Promise<void> {
		this.emit({ type: "status", text: "导播正在根据现有剧情推演本场景大纲……" });
		const knownNames = (await this.store.loadCharacters()).map((c) => c.name);
		const lastChoice = await this.lastChoiceText();
		// 上一稿的校对疑义在此消费：写手不打回重写，矛盾靠推演下一场时修正
		const carryIssues = this.state.draftIssues;
		this.state.draftIssues = undefined;
		let issues: { quote: string; constraint: string; problem: string }[] = [];
		let outline = "";
		// 最优大纲跟踪：记录通过硬 gate 的最优候选（审核意见最少）
		let bestOutline = "";
		let bestIssueCount = Infinity;
		let bestNotes: string[] | undefined;
		for (let round = 0; ; round++) {
			const dCollector: ToolCollector = {};
			await runAgent({
				role: "director",
				llm: this.llm,
				system: OUTLINE_SYSTEM,
				tools: [...sharedReadTools(this.store), sceneOutlineTool(this.store, dCollector)],
				prompt: await assembleOutlineDerivationPrompt(this.store, this.state, round > 0 ? issues : undefined, carryIssues),
				onProcess: this.proc("director", true),
				onStart: this.grabControl(),
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
					this.emit({ type: "status", text: `大纲预检 ${round + 1} 轮仍不达标，使用安全回退大纲。` });
					outline = bestOutline || "自然延续上一场结尾，让情节有机推进";
					issues = bestNotes ? [] : issues;
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
				tools: [verdictTool(vCollector)], // 约束数据已全部内联，不开放检索工具（省工具环往返）
				prompt: await assembleOutlineReviewPrompt(this.store, this.state, outline, notes),
				onProcess: this.proc("reviewer", true),
			});
			const verdict = vCollector.verdict;
			if (!verdict || verdict.pass) {
				if (round > 0) this.emit({ type: "status", text: `大纲修订 ${round} 轮后通过审核。` });
				break;
			}
			issues = verdict.issues;
			// 更新最优候选：通过硬 gate 的大纲中，审核意见最少的优先进入
			if (issues.length < bestIssueCount) {
				bestOutline = outline;
				bestIssueCount = issues.length;
				bestNotes = issues.map((i) => `- ${i.problem}（修改方向：${i.constraint}）`);
			}
			if (round >= 2) {
				// 3 轮都不完美：选用最优候选而非最后一轮的失败稿
				if (bestOutline && bestIssueCount < issues.length) {
					this.emit({ type: "status", text: `大纲审核 3 轮仍有疑义，选用第 ${bestIssueCount === 0 ? "通过" : "最优"} 候选（${bestIssueCount} 条意见）交写手。` });
					outline = bestOutline;
					issues = [];
				} else {
					this.emit({ type: "status", text: `大纲审核 3 轮仍有疑义，带意见直接交写手（意见会传入写作上下文）。` });
				}
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
		this.pipelineBusy = true;

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

		// 1) Writer 写稿（流式）——写手只出终稿，不进打回-重写循环
		this.diceBudget = { used: 0, max: 3 };
		await this.setSubstate("writing");
		let draft = await this.callWriter();
		if (detectRepetitionLoop(draft).length > 0) {
			// 复读是生成事故而非质量判断：整稿重摇一次，重摇稿仍是终稿
			this.emit({ type: "status", text: "检测到复读循环，重新生成本场景……" });
			draft = await this.callWriter();
		}

		// 2) Reviewer 校对（只诊断，不打回）与 Director 场景报告**并行**：两者只消费同一份终稿，互不依赖
		await this.setSubstate("reviewing");
		const loopIssues = detectRepetitionLoop(draft);
		const reviewP = loopIssues.length > 0 ? Promise.resolve({ pass: false, issues: loopIssues } as const) : this.review(draft);
		const reportP = this.directorReport(draft);
		// reportP 在下方 (4) 才 await；此 catch 仅覆盖「(4) 之前就已失败」的窗口，
		// 防止没人接收的 rejection 被静默吞掉。正常路径下 reportSettled 已置位，
		// 仍由 (4) 的 await 原样抛出，失败行为不变。
		let reportSettled = false;
		reportP.catch((err: unknown) => {
			if (reportSettled) return;
			this.emit({ type: "error", message: `导播场景报告失败：${err instanceof Error ? err.message : String(err)}` });
		});
		const verdict = await reviewP;
		this.state.draftIssues = verdict.pass ? undefined : verdict.issues.map((i) => `- ${i.problem}（约束：${i.constraint}）`);
		if (!verdict.pass) {
			this.emit({ type: "status", text: `校对发现 ${verdict.issues.length} 处疑义，按最终稿呈现；遗留问题已带入下一场推演。` });
		}
		await this.commit();

		// 3) 定稿落盘 + 呈现
		await this.setSubstate("settling");
		this.state.sceneIndex += 1;
		const title = `场景${this.state.sceneIndex}`;
		await this.store.saveSceneText(this.state.sceneIndex, title, draft);
		await this.commit();
		this.emit({ type: "scene_done", scene: this.state.sceneIndex, title, text: draft });

		// 4) 收取并行启动的场景报告（摘要/状态/伏笔/走向候选；落盘前过确定性门禁）
		reportSettled = true;
		const rawReport = await reportP;
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
			this.pipelineBusy = false; // 到达等待玩家的节点，解除互斥
			this.clearControl();
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
		// 先清选择并提交，再推进：中途崩溃最多丢一次走向记录，不会重复入账
		this.state.pendingReport = null;
		await this.commit();
		await this.advanceAfterChoice(choice);
	}

	private async advanceAfterChoice(choice: string | null): Promise<void> {
		if (this.state.phase !== "playing") return;
		if (choice) {
			const source = this.state.mode === "auto" ? "auto" : "player";
			await this.store.appendChoice(this.state.sceneIndex, choice, source);
		}

		// 弧边界判断（弧长由 scenesPerArc 决定；拍子不再预排）
		if (this.state.arcBeatIndex >= this.settings.scenesPerArc) {
			await this.setPhase("arc_boundary");
			await this.runArcBoundary();
			return;
		}
		this.state.arcBeatIndex += 1;
		await this.commit();
		await this.runScene();
	}

	private async runArcBoundary(): Promise<void> {
		this.pipelineBusy = true; // 恢复路径不经 runScene 直达此处，需自行置位
		const arcNo = this.state.arcCount;
		this.emit({ type: "status", text: `第 ${arcNo} 弧完结，导播正在收束……` });
		// 弧摘要（一次性补全调用，不走 agent 工具环；闭区间语义覆盖本弧最后一场）
		const summaries = await this.store.recentSummaries(this.state.sceneIndex, this.settings.scenesPerArc + 2);
		const arcSummaryText = `## 弧「${this.state.arc?.title ?? ""}」总结\n${summaries.map((s) => `场景${s.scene}：${s.summary}`).join("\n")}`;
		await this.store.saveArcSummary(arcSummaryText);
		this.emit({ type: "arc_boundary", summary: `已写入弧摘要（${summaries.length} 个场景）。` });

		// 记忆蒸馏（幂等：不达标即跳过，0 成本）
		await this.distillMemories();

		// 伏笔一致性检查：弧收束时盘点未回收伏笔，警告导播与读者
		const openForeshadows = (await this.store.loadForeshadows()).filter((f) => f.status === "open");
		if (openForeshadows.length > 0) {
			const list = openForeshadows.map((f) => `「${f.id}」${f.description}（埋于场景${f.plantedAtScene}）`).join("、");
			this.emit({ type: "status", text: `本弧仍有 ${openForeshadows.length} 条未回收伏笔：${list}——续弧时应优先推进或收束。` });
		}

		// 弧边界规划：续弧或完结（导播决定；弧数上限强制收束）
		if (arcNo >= this.settings.maxArcs) {
			this.emit({ type: "status", text: `已达弧数上限（${this.settings.maxArcs}），故事在此收束。` });
			await this.finishStory();
			return;
		}
		this.emit({ type: "status", text: "导播正在判断故事命运：续弧还是完结……" });
		const collector: ToolCollector = {};
		await runAgent({
			role: "director",
			llm: this.llm,
			system: ARC_PLAN_SYSTEM,
			tools: [arcPlanTool(collector)], // 判断材料已全部内联，单次提交
			prompt: await assembleArcPlanPrompt(this.store, this.state),
			onProcess: this.proc("director", true),
			onStart: this.grabControl(),
		});
		const plan = collector.arcPlan;
		if (plan?.decision === "continue" && plan.title?.trim() && plan.goal?.trim()) {
			const next = arcNo + 1;
			await this.store.saveArc(next, { title: plan.title.trim(), goal: plan.goal.trim() });
			this.state.arcCount = next;
			this.emit({ type: "outline_updated", arc: next, title: plan.title.trim(), goal: plan.goal.trim() });
			await this.commit();
			await this.beginArc(next); // → runScene 接手 busy
			return;
		}
		if (plan?.decision === "finish") {
			this.emit({ type: "status", text: `导播决定收束：${plan.reason ?? "核心冲突已解决"}` });
			if (openForeshadows.length > 0) {
				this.emit({ type: "status", text: `注意：仍有 ${openForeshadows.length} 条伏笔未回收（${openForeshadows.map((f) => f.id).join("、")}），将在结局中留白。` });
			}
		} else {
			this.emit({ type: "status", text: "弧边界规划未产出有效续弧方案，按完结处理。" });
		}
		await this.finishStory();
	}

	private async finishStory(): Promise<void> {
		await this.setPhase("ended");
		this.pipelineBusy = false;
		this.clearControl();
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
				onStart: this.grabControl(),
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

	private async callWriter(): Promise<string> {
		const prompt = await assembleWriterPrompt(this.store, this.state);

		this.emit({ type: "status", text: "执笔中……" });
			const result = await runAgent({
				role: "writer",
				llm: this.llm,
				system: WRITER_SYSTEM,
				tools: [...sharedReadTools(this.store), d20CheckTool(this.store, this.state.sceneIndex + 1, this.diceBudget)],
				prompt,
			onDelta: (t) => this.emit({ type: "scene_delta", text: t }),
			onProcess: this.proc("writer", false),
			onStart: this.grabControl(),
		});
		this.clearControl();
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
			tools: [verdictTool(collector)], // 约束数据已全部内联，不开放检索工具（省工具环往返）
			prompt: await assembleReviewerPrompt(this.store, this.state, draft, notes),
			onProcess: this.proc("reviewer", true),
			onStart: this.grabControl(),
		});
		this.clearControl();
		const verdict = collector.verdict;
		if (!verdict) {
			this.emit({ type: "status", text: "校对未返回结论，按通过处理。" });
			return { pass: true, issues: [] };
		}
		this.emit({ type: "review", pass: verdict.pass, issues: verdict.issues });
		return verdict;
	}

	private async directorReport(sceneText: string): Promise<SceneReport | null> {
		this.emit({ type: "status", text: "导播更新状态与走向候选……" });
		const collector: ToolCollector = {};
		await runAgent({
			role: "director",
			llm: this.llm,
			system: REPORT_SYSTEM,
			tools: [sceneReportTool(collector)], // 快照/经济/伏笔已内联进 prompt，单次提交
			prompt: await assembleDirectorReportPrompt(this.store, this.state, sceneText),
			onProcess: this.proc("director", true),
			onStart: this.grabControl(),
		});
		return collector.report ?? null;
	}

	private async persistReport(raw: SceneReport): Promise<SceneReport> {
		// 报告门禁：未知角色补丁/流水/实体丢弃、金额钳制、choices 复验、摘要截断（全部确定性）
		const cards = await this.store.loadCharacters();
		const entities = await this.store.loadEntities();
		const { report, warnings } = sanitizeReport(raw, cards.map((c) => c.name), entities.map((e) => e.name));
		for (const w of warnings) this.emit({ type: "status", text: `报告门禁：${w}` });
		await this.store.saveSceneSummary(this.state.sceneIndex, report);
		await applyCharacterPatches(this.store, report.characterUpdates);
		await applyEntityPatches(this.store, report.entityUpdates ?? []);
		const foreshadowWarnings = await applyForeshadowOps(this.store, report.foreshadowOps, this.state.sceneIndex);
		for (const w of foreshadowWarnings) this.emit({ type: "status", text: `伏笔提醒：${w}` });
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
		if (!SAVE_NAME_RE.test(name)) {
			this.emit({ type: "error", message: "存档名只能含中文、字母、数字、_ 或 -，长度 ≤64" });
			return;
		}
		await this.store.writeJson(`存档/${name}.json`, this.state);
		this.emit({ type: "status", text: `已存档：${name}` });
	}

	async restart(): Promise<void> {
		if (this.pipelineBusy) {
			this.emit({ type: "error", message: "引擎正在推进剧情（写作/校对/结算中），请稍后再重启。" });
			return;
		}
		this.state = initialGameState();
		await this.commit();
		this.emit({ type: "status", text: "已重置。输入故事灵感开始新故事。" });
	}
}

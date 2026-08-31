import { ENGINE } from "../config.js";
import { listEconomyTemplates } from "../economy/templates.js";
import type { Store } from "../facts/store.js";
import type { GameState } from "../facts/types.js";

// ---------------------------------------------------------------------------
// 上下文组装：Writer/Reviewer 每轮看到的上下文由这里确定性拼装，
// 永不把全文塞进 prompt。记忆分五层：总纲 → 卷/弧摘要 → 近期场景摘要 →
// 上一场景尾部 → 在场角色卡 + 未回收伏笔。
// 预算制：各层设字符上限（中文 ≈1 字 1 token），超限从最远处截断并标注，
// 防止上下文溢出小窗口，也防止 LLM 对被截断处产生"遗忘幻觉"。
// ---------------------------------------------------------------------------

// 各层字符上限基准（按 16k contextWindow 校准；中文 ≈1 字 1 token）
const BASE_CAP = {
	masterOutline: 1200, // 总纲
	arcSummary: 1200, // 此前各弧摘要
	recentSummaries: 1400, // 近期场景摘要（总长）
	sceneTail: 800, // 上一场景尾部（previousSceneTail 已按此截）
	characterCard: 600, // 单个角色卡（含状态 JSON）
	foreshadows: 500, // 未回收伏笔
	economy: 500, // 经济体系
	choices: 240, // 读者上次选择
} as const;

export type Caps = Record<keyof typeof BASE_CAP, number>;

/** 由模型窗口推导各层上限：scale 夹在 [0.5, 4]，防小窗口溢出、大窗口铺张。
 *  16k 时与历史硬编码值完全一致（行为等价）。非法输入回退 16k 基准。 */
export function capsFor(contextWindow: number): Caps {
	const win = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 16384;
	const scale = Math.min(4, Math.max(0.5, win / 16384));
	const out = {} as Caps;
	for (const k of Object.keys(BASE_CAP) as (keyof typeof BASE_CAP)[]) {
		out[k] = Math.round(BASE_CAP[k] * scale);
	}
	return out;
}

const DEFAULT_CAPS = capsFor(16384);

/** 当前生效上限：engine 在 boot/updateSettings 时按实际模型窗口刷新 */
let activeCaps: Caps = DEFAULT_CAPS;

/** 按当前模型 contextWindow 刷新各层上限（engine 调用；不传则回 16k 基准） */
export function setActiveContextWindow(contextWindow: number): void {
	activeCaps = Number.isFinite(contextWindow) && contextWindow > 0 ? capsFor(contextWindow) : DEFAULT_CAPS;
}

/** 读取当前生效的各层上限 */
function CAP(): Caps {
	return activeCaps;
}

/** 超限截断：保留头部（时间线靠后的层由调用方保证已取"最近"），并标注省略 */
function clip(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max) + "\n……（更早的内容已省略）";
}

/** 世界实体状态段（写手/校对/推演共用；宏观事实由代码管理，模型只能引用） */
export async function entitySection(store: Store): Promise<string | null> {
	const entities = await store.loadEntities();
	if (entities.length === 0) return null;
	return entities
		.map((e) => {
			const st = Object.entries(e.state).map(([k, v]) => `${k}=${v}`).join("，") || "（无动态状态）";
			return `- ${e.name}（${e.type}）：${e.description}。当前状态：${st}`;
		})
		.join("\n");
}

/** 史料库段：联网查证固化的现实知识（历史/现实题材的事实锚点） */
export async function historySection(store: Store, cap = 800): Promise<string | null> {
	const notes = await store.listHistoryNotes();
	if (notes.length === 0) return null;
	return clip(notes.map((n) => n.content.trim()).join("\n\n"), cap);
}

export async function assembleWriterPrompt(store: Store, state: GameState): Promise<string> {
	const parts: string[] = [];

	const masterOutline = await store.readText("大纲/总纲.md");
	if (masterOutline) parts.push(`## 故事总纲\n${clip(masterOutline, CAP().masterOutline)}`);

	const arcSummary = await store.readText("记忆/弧摘要.md");
	if (arcSummary) parts.push(`## 此前各弧摘要\n${clip(arcSummary, CAP().arcSummary)}`);

	if (state.arc) parts.push(`## 本弧目标（方向约束，不要在这一场全部完成）\n${state.arc.goal}`);

	parts.push(
		`## 本场景大纲（导播推演、已经校对通过；据此展开叙事，节点顺序是大纲骨架，呈现方式自由）\n${state.currentOutline ?? "自然延续上一场结尾"}`,
	);
	if (state.outlineNotes) {
		parts.push(`## 大纲审核意见（写叙事时必须吸收，但不要在正文里复述这些意见）\n${state.outlineNotes}`);
	}

	const summaries = await store.recentSummaries(state.sceneIndex, ENGINE.recentSummaries);
	if (summaries.length > 0) {
		// 预算内从最新的往回装，装不下的更早摘要丢弃
		const lines: string[] = [];
		let used = 0;
		for (let i = summaries.length - 1; i >= 0; i--) {
			const s = summaries[i]!;
			const line = `- 场景${s.scene}「${s.title}」：${clip(s.summary, 300)}`;
			if (used + line.length > CAP().recentSummaries) break;
			lines.unshift(line);
			used += line.length;
		}
		parts.push(`## 近期场景摘要\n${lines.join("\n")}`);
	}

	const tail = await store.previousSceneTail(state.sceneIndex, ENGINE.previousTailChars);
	if (tail) parts.push(`## 上一场景结尾（承接其气氛与动作，不要重复）\n...${tail}`);

	const cards = await store.loadCharacters();
	if (cards.length > 0) {
		// 上下文瘦身：只带本场大纲点名的角色卡（写手被禁止新增具名角色，大纲外的卡是纯开销）；
		// 大纲一个名字都没点到时全量带上兜底
		const outline = state.currentOutline ?? "";
		const named = cards.filter((c) => outline.includes(c.name));
		const chosen = named.length >= 2 ? named : cards;
		parts.push(
			`## 角色档案（含当前状态快照）\n${chosen
				.map((c) => {
					const emo = c.state.emotions?.length ? `\n最近情感轨迹：${c.state.emotions.slice(-4).join("；")}` : "";
					return `### ${c.name}\n${clip(c.basics, 300)}\n当前状态：${clip(JSON.stringify(c.state), CAP().characterCard)}${emo}`;
				})
				.join("\n\n")}`,
		);
	}

	const economy = await store.loadEconomy();
	if (economy) parts.push(`## 经济体系（涉及金钱、交易、谋生时必须遵守；余额是引擎结算的事实，不可凭空变多或清零）\n${clip(economy, CAP().economy)}`);

	const foreshadows = (await store.loadForeshadows()).filter((f) => f.status === "open");
	if (foreshadows.length > 0) {
		parts.push(`## 未回收伏笔（可在本场景自然推进，但不可凭空说破）\n${foreshadows.map((f) => `- [${f.id}] ${f.description}`).join("\n")}`);
	}

	if (state.pendingReport === null && state.phase === "playing" && state.arcBeatIndex > 1) {
		// 承接读者上一场的决定
		const history = await store.readText("记忆/选择历史.jsonl");
		const lastLine = history?.trim().split("\n").pop();
		if (lastLine) {
			try {
				const entry = JSON.parse(lastLine) as { scene: number; choice: string; source: string };
				parts.push(`## 读者在场景 ${entry.scene} 后的选择（必须承接）\n${entry.choice}（来源：${entry.source === "player" ? "读者亲自选择" : "自动推进"}）`);
			} catch {
				// 忽略损坏行
			}
		}
	}

	return parts.join("\n\n") + "\n\n现在，写出当前场景的正文。";
}

export async function assembleReviewerPrompt(store: Store, state: GameState, draft: string, notes: string[] = []): Promise<string> {
	// 拼装顺序＝缓存友好：稳定段（规则/经济/角色卡/摘要）在前，易变段（预检提示/草稿）贴尾
	const parts: string[] = ["## 活跃约束清单"];

	const rules = await store.readText("设定/规则.md");
	if (rules) parts.push(`### 世界规则\n${rules}`);

	const economy = await store.loadEconomy();
	if (economy) parts.push(`### 经济体系（约束：收支与消费必须与之相符）\n${clip(economy, CAP().economy)}`);

	const cards = await store.loadCharacters();
	if (cards.length > 0) {
		parts.push(
			`### 角色状态快照（约束：位置/身体状况/所知信息/财务）\n${cards
				.map((c) => {
					const finance = c.state.finance ? `；财务(余额=${c.state.finance.balance ?? 0}${c.state.finance.income ? `，收入=${c.state.finance.income}` : ""}${c.state.finance.debts?.length ? `，负债=${c.state.finance.debts.join("、")}` : ""})` : "";
					return `- ${c.name}：位置=${c.state.location ?? "?"}；状况=${c.state.condition ?? "?"}；所知=${JSON.stringify(c.state.knowledge ?? [])}${finance}`;
				})
				.join("\n")}`,
		);
	}

	const foreshadows = (await store.loadForeshadows()).filter((f) => f.status === "open");
	if (foreshadows.length > 0) {
		parts.push(`### 未回收伏笔（约束：不可凭空说破）\n${clip(foreshadows.map((f) => `- [${f.id}] ${f.description}`).join("\n"), CAP().foreshadows)}`);
	}

	const summaries = await store.recentSummaries(state.sceneIndex, ENGINE.recentSummaries);
	if (summaries.length > 0) {
		parts.push(`### 近期剧情摘要（约束：不得矛盾）\n${clip(summaries.map((s) => `- 场景${s.scene}：${s.summary}`).join("\n"), CAP().recentSummaries)}`);
	}

	// d20 判定日志：草稿对成败的叙述必须与骰子结果一致
	const dice = await store.recentDiceChecks(5);
	if (dice.length > 0) {
		parts.push(
			`### 最近判定结果（约束：草稿中对应行动的成败必须与此一致，禁止叙述出与结果相反的走向）\n${dice
				.map((d) => `- 场景${d.scene} ${d.character}〔${d.attribute}〕d20(${d.roll})${d.mod >= 0 ? "+" : ""}${d.mod}=${d.total} vs DC${d.dc} → ${d.outcome}（${d.reason}）`)
				.join("\n")}`,
		);
	}

	if (notes.length > 0) {
		parts.push(`### 确定性预检提示（程序检查出的疑点，请逐一核实；核实为误报可忽略）\n${notes.map((n, i) => `${i + 1}. ${n}`).join("\n")}`);
	}

	parts.push(`## 待校对草稿（第 ${state.sceneIndex} 场）\n\n${draft}`);
	parts.push("请校对上述草稿，完成后调用 submit_verdict 提交结论。");
	return parts.join("\n\n");
}

/** 场景报告：内联角色快照/经济/伏笔，导播无需查证即可一次提交（省去工具环往返） */
export async function assembleDirectorReportPrompt(store: Store, state: GameState, sceneText: string): Promise<string> {
	const parts: string[] = [
		`第 ${state.sceneIndex} 场（弧「${state.arc?.title ?? ""}」第 ${state.arcBeatIndex} 拍）的定稿正文如下。请通读后调用 save_scene_report 提交场景报告（摘要、角色状态补丁、伏笔操作、下一场景走向候选）。`,
	];

	// 内联约束数据：characterUpdates 的名字、transactions 的名字都必须出自快照（门禁会丢弃未登记名）
	const cards = await store.loadCharacters();
	if (cards.length > 0) {
		parts.push(
			`## 角色状态快照（characterUpdates 的 name 必须出自这里）\n${cards
				.map((c) => {
					const finance = c.state.finance ? `；余额=${c.state.finance.balance ?? 0}` : "";
					return `- ${c.name}：位置=${c.state.location ?? "?"}；状况=${c.state.condition ?? "?"}${finance}`;
				})
				.join("\n")}`,
		);
	}

	const economy = await store.loadEconomy();
	if (economy) parts.push(`## 经济体系（涉及收支时逐笔写入 transactions）\n${clip(economy, CAP().economy)}`);

	const foreshadows = (await store.loadForeshadows()).filter((f) => f.status === "open");
	if (foreshadows.length > 0) {
		parts.push(`## 未回收伏笔\n${foreshadows.map((f) => `- [${f.id}] ${f.description}`).join("\n")}`);
	}

	parts.push(`## 场景正文\n\n${sceneText}`);

	parts.push(
		`记住：choices 是给读者的走向候选，要彼此走向不同且至少一个有风险或代价，每项附 preview（30-50 字下一场开头画面预览）；characterUpdates 附 emotions 情感事件；收支的关系后果（赊账→债务伏笔、大额→态度变化）写进 foreshadowOps 或 relationships；推荐序号供自动模式使用。\n若本场景发生了金钱/资源的收支（买入、支付、报酬、被抢、赢利……），必须在 transactions 中逐笔列出（正=收入，负=支出），引擎将据此结算余额并记账；不要把收支只写在摘要里。`,
	);
	return parts.join("\n\n");
}

export function assembleBootPrompt(premise: string): string {
	const templates = listEconomyTemplates()
		.map((t) => `- ${t.id}（${t.name}；计价：${t.currency}）`)
		.join("\n");
	return `读者给出的故事灵感：
「${premise}」

请设计这个故事的开局：调用 design_story 工具提交书名、premise、世界规则、经济体系（选 economy.templateId，从下方可用模板中挑最贴题材的一个）、3-8 个世界实体（城市/势力/资源等宏观对象）、3-6 个主要角色（含初始状态）、第一弧目标（一句话）与开场拍（第一场怎么开场）。要求：题材鲜明、冲突有递进、开场拍即入戏。

## 可用经济模板
${templates}

## 现实背景研究（题材涉及真实历史/地域/技术时必做）
先用 web_search 查证关键史实（时代物价、技术水平、政治格局、衣食住行细节，可多次搜索），再用 save_history_notes 把对剧情有约束力的事实固化进史料库，最后再提交设计。纯虚构世界可跳过研究。

注意：arc 只填 title 和 goal，**不要预排章节列表**——后续每一场都会根据剧情进展逐场推演。`;
}

/** 逐场推演：给导播的"场大纲"生成上下文（读既有剧情 + 读者选择；带返工意见时是修订轮；draftIssues 是上一稿校对遗留疑义） */
export async function assembleOutlineDerivationPrompt(store: Store, state: GameState, issues?: { quote: string; constraint: string; problem: string }[], draftIssues?: string[]): Promise<string> {
	const revise = issues && issues.length > 0;
	const parts: string[] = [
		revise
			? `第 ${state.sceneIndex + 1} 场（弧「${state.arc?.title ?? ""}」弧内第 ${state.arcBeatIndex} 拍）的场大纲被校对打回，请修订后重新调用 save_scene_outline 提交。`
			: `第 ${state.sceneIndex + 1} 场（弧「${state.arc?.title ?? ""}」弧内第 ${state.arcBeatIndex} 拍）即将开写。请根据现有内容推演本场的场大纲，调用 save_scene_outline 提交（150-300 字，3-6 个关键节点，最后单列结尾钩子）。`,
	];

	if (revise) {
		parts.push(`## 校对打回意见（逐条修复）\n${issues.map((i, n) => `${n + 1}. ${i.constraint}：${i.problem}`).join("\n")}`);
	}

	if (draftIssues && draftIssues.length > 0) {
		parts.push(`## 上一稿遗留疑义（校对不打回重写，这些矛盾要在本场推演中规避或修正）\n${draftIssues.join("\n")}`);
	}

	if (state.arc) parts.push(`## 本弧目标（方向约束，本场只需向它推进一步）\n${state.arc.goal}`);

	const settings = await store.loadSettings();
	const summaries = await store.recentSummaries(state.sceneIndex, settings.scenesPerArc);
	if (summaries.length > 0) {
		const lines: string[] = [];
		let used = 0;
		for (let i = summaries.length - 1; i >= 0; i--) {
			const s = summaries[i]!;
			const line = `- 场景${s.scene}「${s.title}」：${clip(s.summary, 300)}`;
			if (used + line.length > CAP().recentSummaries) break;
			lines.unshift(line);
			used += line.length;
		}
		parts.push(`## 已发生剧情（最近在后）\n${lines.join("\n")}`);
	}

	// 读者的最新选择必须承接
	const history = await store.readText("记忆/选择历史.jsonl");
	const lastLine = history?.trim().split("\n").pop();
	if (lastLine) {
		try {
			const entry = JSON.parse(lastLine) as { scene: number; choice: string; source: string };
			parts.push(`## 读者在场景 ${entry.scene} 后的选择（必须承接）\n${entry.choice}（来源：${entry.source === "player" ? "读者亲自选择" : "自动推进"}）`);
		} catch {
			// 忽略损坏行
		}
	}

	const foreshadows = (await store.loadForeshadows()).filter((f) => f.status === "open");
	if (foreshadows.length > 0) {
		parts.push(`## 未回收伏笔（推演时可自然推进其一，不可凭空说破）\n${clip(foreshadows.map((f) => `- [${f.id}] ${f.description}`).join("\n"), CAP().foreshadows)}`);
	}

	parts.push(
		revise
			? "修订要求：逐条解决打回意见，保留原大纲中仍然成立的节点。"
			: "推演要求：与已发生剧情因果相连（不要平行新开线索，除非弧目标需要）；冲突有增量（不要重复上一场的冲突形态）；结尾留钩子。",
	);
	return parts.join("\n\n");
}

/** 大纲审核：给校对的"审大纲"上下文（审的是计划，不是正文；notes 是确定性预检疑点，贴尾以保稳定前缀） */
export async function assembleOutlineReviewPrompt(store: Store, state: GameState, outline: string, notes: string[] = []): Promise<string> {
	const parts: string[] = ["## 待审核场大纲（尚未写成正文；请审核这个计划是否可以交给写手）", outline];
	const rules = await store.readText("设定/规则.md");
	if (rules) parts.push(`### 世界规则\n${clip(rules, 1000)}`);
	const economy = await store.loadEconomy();
	if (economy) parts.push(`### 经济体系（大纲涉及收支时核对）\n${clip(economy, CAP().economy)}`);

	const cards = await store.loadCharacters();
	if (cards.length > 0) {
		parts.push(
			`### 角色状态快照\n${cards
				.map((c) => {
					const finance = c.state.finance ? `；财务(余额=${c.state.finance.balance ?? 0})` : "";
					return `- ${c.name}：位置=${c.state.location ?? "?"}；状况=${c.state.condition ?? "?"}；所知=${JSON.stringify(c.state.knowledge ?? [])}${finance}`;
				})
				.join("\n")}`,
		);
	}

	const foreshadows = (await store.loadForeshadows()).filter((f) => f.status === "open");
	if (foreshadows.length > 0) {
		parts.push(`### 未回收伏笔\n${clip(foreshadows.map((f) => `- [${f.id}] ${f.description}`).join("\n"), CAP().foreshadows)}`);
	}

	const summaries = await store.recentSummaries(state.sceneIndex, ENGINE.recentSummaries);
	if (summaries.length > 0) {
		parts.push(`### 近期剧情摘要\n${clip(summaries.map((s) => `- 场景${s.scene}：${s.summary}`).join("\n"), CAP().recentSummaries)}`);
	}

	const history = await store.readText("记忆/选择历史.jsonl");
	const lastLine = history?.trim().split("\n").pop();
	if (lastLine) {
		try {
			const entry = JSON.parse(lastLine) as { scene: number; choice: string };
			parts.push(`### 读者在场景 ${entry.scene} 后的选择\n${entry.choice}`);
		} catch {
			// 忽略损坏行
		}
	}

	if (notes.length > 0) {
		parts.push(`### 确定性预检提示（程序检查出的疑点，请逐一核实；核实为误报可忽略）\n${notes.map((n, i) => `${i + 1}. ${n}`).join("\n")}`);
	}

	parts.push(
		"审核维度（只审计划，不审文笔）：1）因果连续——每个节点是否从已发生剧情自然推出？2）承接——读者的选择后果是否体现？3）角色——大纲中的角色行动是否符合其状态快照（位置/所知/财务）？4）规则与经济——是否违反世界规则或经济逻辑？5）增量——冲突形态是否与上一场重复？\n" +
			"完成后调用 submit_verdict 提交：pass 为是否可交给写手；issues 逐条给出（quote 填大纲中的原句，problem 说明矛盾与修改方向）。",
	);
	return parts.join("\n\n");
}

/** 弧边界规划：给导播的续弧/收束判断材料（全部内联，零查证往返） */
export async function assembleArcPlanPrompt(store: Store, state: GameState): Promise<string> {
	const parts: string[] = [
		`故事《${state.title}》的第 ${state.arcCount} 弧「${state.arc?.title ?? ""}」刚完结（弧目标：${state.arc?.goal ?? ""}）。请调用 plan_next_arc 提交决定：continue 开下一弧，或 finish 收束全篇。`,
	];

	parts.push(`## 故事 premise（最终承诺的锚点）\n${state.premise}`);

	const arcSummary = await store.readText("记忆/弧摘要.md");
	if (arcSummary) parts.push(`## 历弧摘要（含刚完结弧）\n${clip(arcSummary, 1500)}`);

	const foreshadows = (await store.loadForeshadows()).filter((f) => f.status === "open");
	parts.push(
		foreshadows.length > 0
			? `## 未回收伏笔（续弧时至少一条应进入新弧目标；全部可收束时才应 finish）\n${foreshadows.map((f) => `- [${f.id}] ${f.description}`).join("\n")}`
			: "## 未回收伏笔\n（无）",
	);

	const cards = await store.loadCharacters();
	if (cards.length > 0) {
		parts.push(
			`## 角色现状\n${cards
				.map((c) => `- ${c.name}：位置=${c.state.location ?? "?"}；状况=${c.state.condition ?? "?"}`)
				.join("\n")}`,
		);
	}

	const settings = await store.loadSettings();
	parts.push(`已达弧数上限：${settings.maxArcs}（第 ${settings.maxArcs} 弧结束时必须 finish）。`);
	return parts.join("\n\n");
}

/**
 * 记忆蒸馏（弧边界触发）：
 * 1) 弧摘要整体压缩——保硬事实（人物关系/经济状况/未解之谜/世界规则变化），保序但合并重复；
 * 2) 角色记忆压缩——远期所知并入人物小传，knowledge 只保留近况。
 */
export function assembleArcDistillPrompt(arcSummaryText: string): string {
	return `【记忆蒸馏】以下是多段弧摘要的累积文本。请把它蒸馏成一篇 ≤900 字的「前情提要」，要求：
- 保留硬事实：主要人物的生死/下落、关键关系与恩怨、重要经济状况（谁欠谁、谁暴富）、未解之谜与未回收的重大伏笔、世界规则的重大变化；
- 合并重复与琐碎过程，时间顺序保持可辨；
- 语言为陈述性短段，不要小说笔法。
只输出蒸馏后的文本本身，不要任何说明或标题。原文：

${arcSummaryText}`;
}

export async function assembleMemoryDistillPrompt(store: Store, state: GameState): Promise<string> {
	const cards = await store.loadCharacters();
	return `【记忆蒸馏】故事已进行 ${state.sceneIndex} 场。以下角色的长期记忆需要压缩（保留近期，远期并入人物小传）。调用 save_memory_distill 工具提交全部角色的修订结果。

${cards
	.map(
		(c) =>
			`### ${c.name}\n人物小传：${clip(c.basics, 400)}\n所知信息（旧→新）：\n${(c.state.knowledge ?? []).map((k) => `- ${k}`).join("\n") || "（无）"}`,
	)
	.join("\n\n")}

要求：每位角色 knowledge 精简到 ≤10 条（从最新往回保留；旧的、已被剧情消化的事实并入 basics 小传，各角色 basics 控制在 250 字内）。不要遗漏任何角色。`;
}

// ---------------------------------------------------------------------------
// 确定性预检：从经济设定文本提取计价单位，从草稿扫出金额数字，供校对核对余额
// ---------------------------------------------------------------------------

/** 从 设定/经济.md 文本解析计价单位（saveDesignBible 写入的「## 计价单位」节） */
export function extractCurrency(economyText: string | null): string | null {
	if (!economyText) return null;
	const m = economyText.match(/##\s*计价单位\s*\n(.+)/);
	const currency = m?.[1]?.trim();
	return currency || null;
}

/**
 * 草稿金额预检：扫出「数字 + 货币名」的金额表述，与角色余额一起交校对核对。
 * 金额是 LLM 幻觉高发区（凭空变多、与余额脱节），数字本身由代码提取，不依赖模型自觉。
 */
export function draftPrecheckNotes(draft: string, currency: string | null): string[] {
	if (!currency || !draft.includes(currency)) return [];
	const notes: string[] = [];
	const seen = new Set<string>();
	const esc = currency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`(\\d[\\d,，]*(?:\\.\\d+)?)\\s*${esc}`, "g");
	for (const m of draft.matchAll(re)) {
		const amount = m[1] ?? "";
		const ctx = draft.slice(Math.max(0, (m.index ?? 0) - 15), (m.index ?? 0) + (m[0]?.length ?? 0) + 15).replace(/\n/g, " ");
		const key = amount;
		if (seen.has(key)) continue;
		seen.add(key);
		notes.push(`草稿出现金额「${m[0] ?? ""}」（上下文：…${ctx}…）——请核对该数目与相关角色的当前余额相符、收支来源合理。`);
		if (notes.length >= 5) break;
	}
	return notes;
}

// ---------------------------------------------------------------------------
// 事实层类型：所有持久化状态的结构定义。
// 约定：引擎需要程序化解析的内容以 JSON 存储（角色状态块、弧拍子、伏笔台账），
// 供人阅读的内容以 Markdown 存储（总纲、场景正文、场景摘要）。文件即唯一事实源。
// ---------------------------------------------------------------------------

/** 引擎阶段（只前进，回退通过读档实现） */
export type Phase = "empty" | "idea_chat" | "bootstrapping" | "confirm_bible" | "playing" | "arc_boundary" | "ended";

export type PlayMode = "auto" | "manual";

/**
 * playing 阶段的子状态（持久化到 autosave，崩溃后可精确告知中断点）。
 * writing/reviewing/rewriting 中断 → 场景将重新生成；choosing 中断 → choices 事件重放。
 */
export type PlayingSubstate = "outlining" | "writing" | "reviewing" | "rewriting" | "settling" | "choosing";

/** 角色当前状态快照（随剧情推进由 Director 更新） */
export interface CharacterState {
	location?: string;
	condition?: string;
	/** 角色已知悉的信息（用于防止"角色知道了不该知道的事"） */
	knowledge?: string[];
	/** 对其他角色的关系/态度 */
	relationships?: Record<string, string>;
	/** 财务快照：balance 由引擎按收支流水结算，Director 不要直接改 */
	finance?: Finance;
	/** 情感轨迹：本角色经历的情感事件（一行一条，最新在后），由 Director 每场补丁追加 */
	emotions?: string[];
	/** 属性面板（键须来自世界的属性表；值 1-18，引擎钳制；10 为普通成年人水准） */
	stats?: Record<string, number>;
	/** 属性成长事件（升级/受伤致残等），由 Director 补丁附注 */
	statNotes?: string[];
}

/** 角色财务：balance 是引擎结算的数字事实 */
export interface Finance {
	balance?: number;
	/** 收入来源描述，如「夜班工资」「情报贩子抽成」 */
	income?: string;
	/** 负债/欠款描述 */
	debts?: string[];
}

export interface CharacterCard {
	name: string;
	/** 基础设定（长期不变） */
	basics: string;
	/** 当前状态快照 */
	state: CharacterState;
}

/** 场景拍子：本场景要推进什么（不再预排，逐场推演生成） */
export interface ArcOutline {
	title: string;
	/** 本弧的一句话目标（方向性约束，不是章节列表） */
	goal: string;
}

/** 伏笔操作 */
export interface ForeshadowOp {
	action: "plant" | "advance" | "resolve";
	id?: string;
	description?: string;
	note?: string;
}

export interface ForeshadowEntry {
	id: string;
	description: string;
	/** 埋设于第几场 */
	plantedAtScene: number;
	status: "open" | "resolved";
	notes?: string[];
}

/** 账本流水（记忆/账本.jsonl，由引擎结算写入） */
export interface LedgerEntry {
	scene: number;
	name: string;
	change: number;
	reason: string;
	balanceAfter: number;
}

/** d20 判定记录（记忆/判定日志.jsonl，由引擎掷骰写入） */
export interface DiceCheck {
	scene: number;
	character: string;
	attribute: string;
	dc: number;
	roll: number;
	mod: number;
	total: number;
	outcome: "大成功" | "成功" | "失败" | "大失败";
	reason: string;
}

export interface Choice {
	label: string;
	description: string;
	/** 可选：以该选择为前提的下一场开头预览（30-50 字画面梗概，帮读者决策） */
	preview?: string;
}

/** Director 每场景结束后的结构化报告（通过 save_scene_report 工具提交） */
export interface SceneReport {
	title: string;
	summary: string;
	/** 在场角色的状态补丁（浅合并到现有 state） */
	characterUpdates: { name: string; patch: CharacterState }[];
	foreshadowOps: ForeshadowOp[];
	/** 下一场景的 2-4 个走向候选 */
	choices: Choice[];
	/** auto 模式下推荐的选择（1-based） */
	recommendedChoice?: number;
	/** 本场景的收支流水：引擎据此结算角色余额并写账本 */
	transactions?: { name: string; change: number; reason: string }[];
}

/** Reviewer 裁决（通过 submit_verdict 工具提交） */
export interface Verdict {
	pass: boolean;
	issues: { quote: string; constraint: string; problem: string }[];
}

/** Director 开局设计（通过 design_story 工具提交） */
export interface StoryDesign {
	title: string;
	premise: string;
	worldRules: string;
	/** 经济体系：代码管理的账本以此为准（currency 用于账本与校对） */
	economy: { currency: string; overview: string };
	/** 世界属性表（5-6 条，贴合题材；角色 stats 的合法键） */
	attributes: string[];
	characters: { name: string; basics: string; initialState: CharacterState }[];
	/** 弧只定目标，不预排拍子（拍子逐场推演） */
	arc: ArcOutline;
	/** 第一场怎么开场（唯一预排的拍子） */
	openingBeat: string;
}

/** 引擎全局状态（小而完整，序列化到存档；大事实都在文件里） */
export interface GameState {
	phase: Phase;
	mode: PlayMode;
	title: string;
	premise: string;
	/** 故事唯一标识：开局时生成，决定独立存档文件名（存档/故事-<storyId>.json） */
	storyId?: string;
	/** 全局场景计数（跨弧累计，从 1 开始） */
	sceneIndex: number;
	/** 当前弧内拍子游标（1-based） */
	arcBeatIndex: number;
	arc: ArcOutline | null;
	arcCount: number;
	/** 当前场景写稿-校验轮次（checkpoint 恢复用） */
	attempt: number;
	/** 场景定稿后的挂起选择（等待玩家/auto 决定） */
	pendingReport: SceneReport | null;
	/** 灵感酝酿阶段的对话记录（empty/idea_chat 阶段累积，构建后保留备查） */
	ideaMsgs: { role: "user" | "assistant"; text: string }[];
	/** playing 阶段的子状态（崩溃恢复时标注中断点；非 playing 阶段为 undefined） */
	substate?: PlayingSubstate;
	/** 当前场景的大纲（每场开写前由导播推演、校对审核，定稿后清空） */
	currentOutline?: string;
	/** 大纲审核意见（写手须吸收；随大纲一起清空） */
	outlineNotes?: string;
	updatedAt: string;
}

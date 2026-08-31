import {
	createModels,
	createProvider,
	lazyStream,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { stream as openaiCompletionsStream, streamSimple as openaiCompletionsStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { LLM_PROVIDER, LOCAL_LLM, SENSENOVA, ROLE_MODELS, requireApiKey, type RoleName } from "./config.js";
import type { LlmSettings } from "./facts/types.js";
import { withResilience } from "./llm-resilience.js";

function localModel(
	role: RoleName,
	modelId: string = LOCAL_LLM.modelId,
	baseUrl: string = LOCAL_LLM.baseUrl,
	temperature: number = ROLE_MODELS[role].temperature,
): Model<Api> {
	return {
		id: modelId,
		name: `llama.cpp/${modelId}`,
		api: "openai-completions",
		provider: LOCAL_LLM.providerId,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: LOCAL_LLM.contextWindow,
		maxTokens: LOCAL_LLM.maxTokens,
		samplingParams: { temperature, top_p: 0.95 },
	};
}

/** 构造一个通用 OpenAI 兼容模型的元数据（cost 仅用于用量统计展示，非计费依据） */
function openAiModel(id: string, baseUrl: string, contextWindow = 128000, maxTokens = 8192): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "openai",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
}

/** 构造一个商汤 SenseNova 模型的元数据 */
function sensenovaModel(id: string, name: string, contextWindow: number, maxTokens: number): Model<Api> {
	return {
		id,
		name,
		api: "openai-completions",
		provider: SENSENOVA.providerId,
		baseUrl: SENSENOVA.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
}

const SENSENOVA_MODELS: Model<Api>[] = [
	sensenovaModel("SenseChat-5", "SenseChat-5", 128000, 8192),
	sensenovaModel("SenseNova-V6.5-Turbo", "SenseNova V6.5 Turbo", 128000, 8192),
];

/** 构建 LLM 所用的解析规格（来自环境变量或设置界面） */
export interface LlmSpec {
	provider: "sensenova" | "local" | "openai";
	baseUrl: string;
	apiKey: string;
	modelId: string;
	/** 按角色覆盖模型/温度（可选；缺省回退全局与 ROLE_MODELS） */
	roles?: LlmSettings["roles"];
}

/** 由设置界面的 LLM 配置推导解析规格 */
export function specFromSettings(llm: LlmSettings): LlmSpec {
	return { provider: llm.provider, baseUrl: llm.baseUrl, apiKey: llm.apiKey, modelId: llm.modelId, roles: llm.roles };
}

/** 角色温度：设置覆盖优先，回退 ROLE_MODELS 代码默认 */
function temperatureFor(s: LlmSpec, role: RoleName): number {
	return s.roles?.[role]?.temperature ?? ROLE_MODELS[role].temperature;
}

export type StreamFn = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => ReturnType<typeof openaiCompletionsStreamSimple>;

export interface Llm {
	model(role: RoleName): Model<Api>;
	streamFn: StreamFn;
}

/** 由环境变量推导规格（CLI 入口使用；设置界面走 specFromSettings） */
function specFromEnv(): LlmSpec {
	if (LLM_PROVIDER === "local") {
		return { provider: "local", baseUrl: LOCAL_LLM.baseUrl, apiKey: "", modelId: LOCAL_LLM.modelId };
	}
	requireApiKey();
	return { provider: "sensenova", baseUrl: SENSENOVA.baseUrl, apiKey: SENSENOVA.apiKey, modelId: ROLE_MODELS.director.modelId };
}

/** 按规格构建 OpenAI 兼容 provider（sensenova / openai 通用，local 走直连分支） */
function buildOnlineProvider(spec: LlmSpec): { models: ReturnType<typeof createModels>; providerModels: Model<Api>[] } {
	const providerModels: Model<Api>[] =
		spec.provider === "sensenova"
			? SENSENOVA_MODELS
			: // openai 兼容：全局模型 + 角色覆盖模型（同 id 去重），保证角色覆盖可命中
				[...new Set([spec.modelId, ...Object.values(spec.roles ?? {}).map((r) => r?.modelId ?? "").filter(Boolean)])].map(
					(id) => openAiModel(id, spec.baseUrl),
				);
	const provider = createProvider({
		id: spec.provider,
		name: spec.provider === "sensenova" ? "商汤 SenseNova" : "OpenAI 兼容服务",
		baseUrl: spec.baseUrl,
		auth: {
			apiKey: {
				name: "API Key",
				resolve: async () => {
					const key = spec.apiKey || (spec.provider === "sensenova" ? SENSENOVA.apiKey : "");
					return key ? { auth: { apiKey: key }, source: "settings" } : undefined;
				},
			},
		},
		models: providerModels,
		api: { "openai-completions": { stream: openaiCompletionsStream, streamSimple: openaiCompletionsStreamSimple } },
	});
	const models = createModels();
	models.setProvider(provider);
	return { models, providerModels };
}

/** 角色模型查找（基于商汤预设模型表，mock 与兜底用） */
function roleModel(role: RoleName): Model<Api> {
	const found = SENSENOVA_MODELS.find((m) => m.id === ROLE_MODELS[role].modelId) ?? SENSENOVA_MODELS[0];
	if (!found) throw new Error(`未配置的模型: ${ROLE_MODELS[role].modelId}`);
	return found;
}

/** 按规格构建接入：local 直连 llama-server；sensenova/openai 走注册 provider。
 *  不传 spec 时由环境变量推导（CLI 入口）；Web 模式下每名由设置界面的 llm 配置驱动。 */
export function createLlm(spec?: LlmSpec): Llm {
	const s = spec ?? specFromEnv();
	if (s.provider === "local") {
		// llama-server 是单模型服务、不校验鉴权；绕过注册表直连 OpenAI 兼容端点，
		// 按角色注入不同采样温度（samplingParams 随 model 对象携带）
		return {
			model: (role) => localModel(role, s.modelId, s.baseUrl, temperatureFor(s, role)),
			streamFn: (model, context, options) =>
				openaiCompletionsStreamSimple(model as Model<"openai-completions">, context, { ...options, apiKey: "local" }),
		};
	}
	const { models, providerModels } = buildOnlineProvider(s);
	// 角色模型：设置覆盖优先；sensenova 回退按角色预设表，openai 回退全局模型
	const roleModelId = (role: RoleName): string => {
		const override = s.roles?.[role]?.modelId;
		if (override) return override;
		return s.provider === "sensenova" ? ROLE_MODELS[role].modelId : s.modelId;
	};
	// 在线模型叠加两级超时 + 指数退避重试；本地分支（streamFn 直连）不走此逻辑。
	const resilientStreamFn = withResilience((model, context, options) => models.streamSimple(model, context, options));
	return {
		model: (role) => {
			const id = roleModelId(role);
			const found = providerModels.find((m) => m.id === id);
			if (!found) throw new Error(`未配置的模型: ${id}`);
			// 温度随 model 对象下发（pi 按 Model.samplingParams 合并请求）；openai 兼容服务首次获得按角色温度
			return { ...found, samplingParams: { temperature: temperatureFor(s, role), top_p: 0.95 } };
		},
		streamFn: resilientStreamFn,
	};
}

// ---------------------------------------------------------------------------
// Mock 模式：无 API Key 时验证引擎全流程。根据 prompt 中的角色标记返回
// 预排内容（正文 / 工具调用），走完整的 agent 循环与工具执行路径。
// ---------------------------------------------------------------------------

const MOCK_PROSE = [
	"暮色像一层薄纱，缓缓覆盖了这座城。长街尽头的灯笼次第亮起，光影在青石板上摇曳。",
	"他站在檐下，指节因用力而微微发白。远处传来的脚步声越来越近，每一步都像踩在他的心跳上。",
	"风忽然停了。那种被人注视的感觉再次爬上后颈——不是错觉，从来没有错过。",
	"「你终于来了。」黑暗里有人轻声说，声音陌生而熟悉。故事在这一刻，悄悄转过了路口。",
];

function mockMessage(content: AssistantMessage["content"]): AssistantMessage {
	const now = Date.now();
	return {
		role: "assistant" as const,
		content,
		api: "openai-completions" as const,
		provider: "mock",
		model: "mock-1",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop" as const,
		timestamp: now,
	};
}

/** mock 裁决计数：第 1 次（大纲审核首轮）打回，其余通过 */
let mockVerdictCalls = 0;

/** 测试钩子：mock writer 收到的完整 prompt（E2E 断言上下文内容用，如"必须含上一场摘要"） */
export const mockWriterPrompts: string[] = [];

function mockStreamFn(role: RoleName): StreamFn {
	return (model, context) => {
		// Agent 可能以字符串或内容块数组两种形式传 user 消息，都要兼容
		const extractText = (content: unknown): string => {
			if (typeof content === "string") return content;
			if (Array.isArray(content)) return content.filter((b) => (b as { type: string }).type === "text").map((b) => (b as { text?: string }).text ?? "").join("");
			return "";
		};
		const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
		const prompt = extractText(lastUser?.content);

		// 工具结果已在上下文末尾 → 返回纯文本收尾，避免 mock 无限调用工具
		const lastMsg = context.messages[context.messages.length - 1];
		if (lastMsg?.role === "toolResult") {
			// 设计阶段的研究类工具结果：不收尾，落回正常分支（下一次会提交 design_story）
			const isResearch =
				JSON.stringify((lastMsg as { toolCallId?: string }).toolCallId ?? "").includes("mock-call-websearch") ||
				JSON.stringify((lastMsg as { toolCallId?: string }).toolCallId ?? "").includes("mock-call-history");
			if (!isResearch) {
				const doneText = "（mock）工具调用已完成。";
				const done = mockMessage([{ type: "text", text: doneText }]);
				return lazyStream(
					model,
					async () =>
						(async function* () {
							yield { type: "start" as const, partial: done };
							yield { type: "text_delta" as const, contentIndex: 0, delta: doneText, partial: done };
							yield { type: "done" as const, reason: "stop" as const, message: done };
						})(),
				);
			}
		}

		const iter = (async function* () {
			if (role === "director") {
				// 设计阶段的联网研究：首次返回 web_search + save_history_notes 调用（之后走正常设计）
				const calledSearch = context.messages.some(
					(m) => m.role === "assistant" && JSON.stringify((m as { content?: unknown }).content ?? "").includes("web_search"),
				);
				if (prompt.includes("web_search") && !calledSearch) {
					const msg = mockMessage([
						{
							type: "toolCall",
							id: "mock-call-websearch",
							name: "web_search",
							arguments: { query: "（mock）现代都市 工薪阶层 月均支出 物价" },
						},
						{
							type: "toolCall",
							id: "mock-call-history",
							name: "save_history_notes",
							arguments: {
								title: "（mock）现代都市物价与民生",
								content: "（mock）移动支付覆盖绝大多数消费场景；普通工薪月支出以房租为大头；外卖一餐约 20-40 元。",
							},
						},
					]);
					yield { type: "start" as const, partial: msg };
					yield { type: "done" as const, reason: "toolUse" as const, message: msg };
					return;
				}
				// 灵感对话：纯文本回复，不调用工具
				if (prompt.includes("【灵感对话】")) {
					const reply = "（mock）这个灵感有意思——主角是孤胆英雄还是小人物卷局？我建议把冲突落在「身份暴露的一夜」，基调偏冷。你想更爽还是更虐？";
					let base = mockMessage([{ type: "text", text: "" }]);
					yield { type: "start" as const, partial: base };
					yield { type: "text_start" as const, contentIndex: 0, partial: base };
					for (let i = 0; i < reply.length; i += 12) {
						base = { ...base, content: [{ type: "text", text: reply.slice(0, i + 12) }] };
						yield { type: "text_delta" as const, contentIndex: 0, delta: reply.slice(i, i + 12), partial: base };
					}
					const done = mockMessage([{ type: "text", text: reply }]);
					yield { type: "text_end" as const, contentIndex: 0, content: reply, partial: done };
					yield { type: "done" as const, reason: "stop" as const, message: done };
					return;
				}
				// 逐场推演：返回 save_scene_outline 工具调用
				if (prompt.includes("save_scene_outline")) {
					const msg = mockMessage([
						{
							type: "toolCall",
							id: "mock-call-outline",
							name: "save_scene_outline",
							arguments: {
								outline: "（mock）1）主角循线索逼近神秘人藏身处，遭到反跟踪；\n2）神秘人主动现身，抛出芯片的第一条线索；\n3）两人短暂交锋，主角被迫交换情报；\n4）结尾钩子：主角发现手机被远程抹除。",
							},
						},
					]);
					yield { type: "start" as const, partial: msg };
					yield { type: "done" as const, reason: "toolUse" as const, message: msg };
					return;
				}
				// 记忆蒸馏（弧边界）：返回纯文本蒸馏结果
				if (prompt.includes("【记忆蒸馏】")) {
					const reply = "（mock）前情提要：主角与神秘人的博弈升级，账上已欠打车费若干；芯片之谜未解，F001 伏笔悬置。";
					const done = mockMessage([{ type: "text", text: reply }]);
					return lazyStream(
						model,
						async () =>
							(async function* () {
								yield { type: "start" as const, partial: done };
								yield { type: "text_delta" as const, contentIndex: 0, delta: reply, partial: done };
								yield { type: "done" as const, reason: "stop" as const, message: done };
							})(),
					);
				}
				// 角色记忆蒸馏：返回 save_memory_distill 工具调用
				if (prompt.includes("save_memory_distill")) {
					const msg = mockMessage([
						{
							type: "toolCall",
							id: "mock-call-distill",
							name: "save_memory_distill",
							arguments: {
								characters: [
									{ name: "主角", basics: "（mock）普通上班族卷入芯片事件后，与神秘人多次交锋，欠账与警觉并存。", knowledge: ["神秘人的存在"] },
									{ name: "神秘人", basics: "（mock）来历不明的联络者，行事有组织痕迹。", knowledge: ["主角的秘密"] },
								],
							},
						},
					]);
					yield { type: "start" as const, partial: msg };
					yield { type: "done" as const, reason: "toolUse" as const, message: msg };
					return;
				}
				// 弧边界规划：第 1 弧后续弧（验证多弧续玩），第 2 弧后完结
				if (prompt.includes("plan_next_arc")) {
					const firstArc = /第\s*1\s*弧/.test(prompt);
					const msg = mockMessage([
						{
							type: "toolCall",
							id: "mock-call-arcplan",
							name: "plan_next_arc",
							arguments: firstArc
								? { decision: "continue", title: "（mock）芯片真相", goal: "（mock）主角查明芯片来源并摆脱追杀，与神秘人做个了断。" }
								: { decision: "finish", reason: "（mock）芯片之谜已解，与神秘人的恩怨了结，核心冲突解决。" },
						},
					]);
					yield { type: "start" as const, partial: msg };
					yield { type: "done" as const, reason: "toolUse" as const, message: msg };
					return;
				}
				// 弧大纲修订（reviseArc）
				if (prompt.includes("save_arc_revision")) {
					const msg = mockMessage([
						{
							type: "toolCall",
							id: "mock-call-arcrev",
							name: "save_arc_revision",
							arguments: { title: "（mock）第一弧·初遇（修订版）", goal: "（mock）主角查明芯片真相并揭开神秘人身份，增加悬疑元素" },
						},
					]);
					yield { type: "start" as const, partial: msg };
					yield { type: "done" as const, reason: "toolUse" as const, message: msg };
					return;
				}
				// 导演类调用：从 prompt 中提取场景编号等关键信息，回一个结构化报告
				const sceneMatch = prompt.match(/场景(\d+)/);
				const scene = sceneMatch ? Number(sceneMatch[1]) : 1;
				if (prompt.includes("场景报告")) {
					const msg = mockMessage([
						{
							type: "toolCall",
							id: "mock-call-report",
							name: "save_scene_report",
							arguments: {
								title: `第${scene}场`,
								summary: `（mock）第 ${scene} 场摘要：主角在长街遭遇神秘人，冲突升级，埋下新的疑点。`,
								characterUpdates: [{ name: "主角", patch: { location: "长街", knowledge: ["神秘人的存在"], emotions: ["（mock）与神秘人正面遭遇，紧张中带着一丝兴奋"] } }],
								foreshadowOps: [{ action: "plant", id: `F${String(scene).padStart(3, "0")}`, description: "神秘人的真实身份" }],
								choices: [
									{ label: "追上去", description: "追查神秘人的下落", preview: "（mock）你拐进暗巷，脚印在雨里延伸向码头方向。" },
									{ label: "原地观察", description: "按兵不动，看清来者意图", preview: "（mock）你熄了烟退回门洞，对面的影子却先动了。" },
									{ label: "转身离开", description: "暂避锋芒，从长计议", preview: "（mock）你挤上末班公交，车窗上映出一张陌生的脸。" },
								],
								recommendedChoice: 1,
								transactions: [{ name: "主角", change: -80, reason: "（mock）逃离长街的打车费" }],
							entityUpdates: [{ name: "长街", patch: { 气氛: "雨夜戒严" } }],
							},
						},
					]);
					yield { type: "start" as const, partial: msg };
					yield { type: "done" as const, reason: "toolUse" as const, message: msg };
				} else {
					const msg = mockMessage([
						{
							type: "toolCall",
							id: "mock-call-design",
							name: "design_story",
							arguments: {
								title: "长街疑影（mock）",
								premise: "都市夜行人与神秘来客的博弈",
								worldRules: "现代都市，低魔设定，异能罕见且隐秘。",
								economy: {
									templateId: "modern-cn",
									currency: "元（人民币）",
									overview: "（mock）普通工薪月薪约 6000 元；黑市情报按条计价；主角是普通上班族，手头紧，存款只够两个月房租。",
								},
								entities: [
									{ name: "长街", type: "地域", description: "（mock）主角生活的老城区街道，市井气重。", state: { 气氛: "平静", 人口: 12000 } },
									{ name: "神秘人组织", type: "势力", description: "（mock）在长街活动的幕后势力。", state: { 活跃度: 3 } },
								],
								attributes: ["体魄", "敏捷", "头脑", "感知", "意志", "人脉"],
								characters: [
									{
										name: "主角",
										basics: "普通上班族，意外卷入事件。",
										initialState: {
											location: "长街",
											condition: "健康",
											knowledge: [],
											relationships: {},
											stats: { 体魄: 9, 敏捷: 12, 头脑: 11, 感知: 10, 意志: 13, 人脉: 6 },
											finance: { balance: 1200, income: "月薪 3000 信用点", debts: ["下月房租 1500"] },
										},
									},
									{
										name: "神秘人",
										basics: "来历不明，似乎知晓主角的秘密。",
										initialState: { location: "未知", condition: "未知", knowledge: ["主角的秘密"], relationships: {} },
									},
								],
								arc: { title: "第一弧·初遇", goal: "（mock）主角与神秘人的初次交锋，揭开芯片秘密的一角" },
																	openingBeat: "（mock）主角在长街接收匿名包裹，神秘人现身留下警告。",
							},
						},
					]);
					yield { type: "start" as const, partial: msg };
					yield { type: "done" as const, reason: "toolUse" as const, message: msg };
				}
			} else if (role === "reviewer") {
				// 首次裁决打回（验证大纲审核-修订环），其余通过（正文校对只诊断，不打回）
				mockVerdictCalls += 1;
				const pass = mockVerdictCalls > 1;
				const msg = mockMessage([
					{
						type: "toolCall",
						id: "mock-call-verdict",
						name: "submit_verdict",
						arguments: pass
							? { pass: true, issues: [] }
							: { pass: false, issues: [{ quote: "（mock）示例矛盾原文", constraint: "角色状态", problem: "与当前状态快照冲突" }] },
					},
				]);
				yield { type: "start" as const, partial: msg };
				yield { type: "done" as const, reason: "toolUse" as const, message: msg };
			} else {
				// Writer：分批吐正文（收到的完整 prompt 推入测试钩子，供 E2E 断言上下文内容）
				mockWriterPrompts.push(prompt);
				const paragraphs = Array.from({ length: 6 }, (_, i) => MOCK_PROSE[i % MOCK_PROSE.length]);
				const full = paragraphs.join("\n\n");
				const chunk = 24;
				let base: any = undefined;
				for (let i = 0; i < full.length; i += chunk) {
					if (!base) {
						base = mockMessage([{ type: "text", text: "" }]);
						yield { type: "start" as const, partial: base };
						yield { type: "text_start" as const, contentIndex: 0, partial: base };
					}
					base = { ...base, content: [{ type: "text", text: full.slice(0, i + chunk) }] };
					yield { type: "text_delta" as const, contentIndex: 0, delta: full.slice(i, i + chunk), partial: base };
					await new Promise((r) => setTimeout(r, 8));
				}
				const done = mockMessage([{ type: "text", text: full }]);
				yield { type: "text_end" as const, contentIndex: 0, content: full, partial: done };
				yield { type: "done" as const, reason: "stop" as const, message: done };
			}
		})();
		return lazyStream(model, async () => iter);
	};
}

export function createMockLlm(): Llm {
	return { model: roleModel, streamFn: (model, context, options) => mockStreamFn(contextRole(context))(model, context, options) };
}

/** mock 需要知道当前是哪个角色：从 system prompt 的标记行读取 */
function contextRole(context: Context): RoleName {
	const m = context.systemPrompt?.match(/【角色:(\w+)】/);
	const tag = m?.[1];
	if (tag === "director") return "director";
	if (tag === "reviewer") return "reviewer";
	return "writer";
}


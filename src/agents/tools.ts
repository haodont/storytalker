import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Store } from "../facts/store.js";
import type { DiceCheck, SceneReport, StoryDesign, Verdict, WorldEntity } from "../facts/types.js";
import { listEconomyTemplates } from "../economy/templates.js";

/** 一次 agent 运行中，工具提交的结构化产物（引擎从这里读回） */
export interface ToolCollector {
	design?: StoryDesign;
	report?: SceneReport;
	verdict?: Verdict;
	nextOutline?: { outline: string };
	distilled?: { characters: { name: string; basics: string; knowledge: string[] }[] };
	arcRevision?: { title: string; goal: string };
	arcPlan?: { decision: "continue" | "finish"; title?: string; goal?: string; reason?: string };
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

export function sharedReadTools(store: Store): AgentTool[] {
	return [
		{
			name: "read_bible",
			label: "查设定",
			description: "读取故事圣经：世界观/世界规则/地点，或某个角色的完整档案（基础设定+当前状态）",
			parameters: Type.Object({
				target: Type.String({ description: "角色名，或 '世界观' | '规则' | '地点'" }),
			}),
			execute: async (_id, params) => {
				const { target } = params as { target: string };
				const rel =
					target === "世界观" ? "设定/世界观.md" : target === "规则" ? "设定/规则.md" : target === "地点" ? "设定/地点.md" : `设定/角色/${target}.md`;
				const content = await store.readText(rel);
				return text(content ?? `（未找到「${target}」的设定）`);
			},
		},
		{
			name: "search_story",
			label: "搜全文",
			description: "按关键词检索全部已有剧情与设定文件，返回命中行（用于核实细节是否出现过）",
			parameters: Type.Object({
				query: Type.String({ description: "关键词，可用空格分隔多个词" }),
			}),
			execute: async (_id, params) => {
				const { query } = params as { query: string };
				const hits = await store.search(query);
				if (hits.length === 0) return text(`（无「${query}」的检索结果）`);
				return text(hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n"));
			},
		},
		{
			name: "read_foreshadows",
			label: "查伏笔",
			description: "读取伏笔台账：所有已埋设/已回收的伏笔及其状态",
			parameters: Type.Object({}),
			execute: async () => {
				const entries = await store.loadForeshadows();
				if (entries.length === 0) return text("（伏笔台账为空）");
				return text(entries.map((f) => `[${f.id}] ${f.status} 埋于场景${f.plantedAtScene}：${f.description}`).join("\n"));
			},
		},
	];
}

/** Director 专用：design_story（开局设计） */
export function designStoryTool(store: Store, collector: ToolCollector): AgentTool {
	return {
		name: "design_story",
		label: "设计开局",
		description: "提交故事开局设计：书名、premise、世界规则、主要角色（含初始状态）、第一弧目标与开场拍",
		parameters: Type.Object({
			title: Type.String(),
			premise: Type.String({ description: "50 字以内的故事核心梗概" }),
			worldRules: Type.String({ description: "世界规则与核心设定，400 字以内；经济细节写入 economy 字段而非此处" }),
			economy: Type.Object({
				templateId: Type.Optional(
					Type.String({ description: "经济模板 id：从设计任务给出的可用模板列表中选最贴题材的一个；不确定就留空" }),
				),
				currency: Type.String({ description: "这个世界流通的货币/资源的名称，如「银两」「人民币」「罐头」；选了模板则与模板一致" }),
				overview: Type.String({ description: "经济体系概述 150 字以内：人们靠什么谋生、关键资源的稀缺性与归属、贫富与阶层概况、主角的经济状况（缺不缺钱）" }),
			}),
			entities: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({ description: "实体名，如「北京城」「穿越者自治会」「电报局」" }),
						type: Type.Union([
							Type.Literal("势力"), Type.Literal("地域"), Type.Literal("机构"),
							Type.Literal("资源"), Type.Literal("技术"), Type.Literal("其他"),
						]),
						description: Type.String({ description: "这个实体是什么、在故事中的位置，80 字以内" }),
						state: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]), {
							description: "初始动态状态，如 {人口: 800000, 民心: 5, 粮食储备: 「紧张」}",
						}),
					}),
					{ description: "世界实体（3-8 个）：宏观对象如城市、势力、关键资源；角色已有角色卡，不要重复" },
				),
			),
			characters: Type.Array(
				Type.Object({
					name: Type.String(),
					basics: Type.String({ description: "身份、性格、动机、能力，100 字以内" }),
					initialState: Type.Object({
						location: Type.String(),
						condition: Type.String(),
						knowledge: Type.Array(Type.String()),
						relationships: Type.Record(Type.String(), Type.String()),
						stats: Type.Optional(
							Type.Record(Type.String(), Type.Number(), {
								description: "属性面板（键来自 attributes 表）：1-18，10 为普通水准；每个强项配一个弱项",
							}),
						),
						finance: Type.Optional(
							Type.Object({
								balance: Type.Optional(Type.Number({ description: "开场余额（数字，引擎管理）" })),
								income: Type.Optional(Type.String({ description: "收入来源" })),
								debts: Type.Optional(Type.Array(Type.String(), { description: "负债" })),
							}),
						),
					}),
				}),
				{ description: "3-6 个主要角色" },
			),
			arc: Type.Object({
				title: Type.String({ description: "第一弧标题" }),
				goal: Type.String({ description: "本弧的一句话目标（方向性约束，如「主角查明芯片真相并甩掉追杀」）；不要预排章节列表" }),
			}),
			attributes: Type.Array(Type.String(), {
				description: "世界属性表，5-6 条贴合题材（如 体魄/敏捷/头脑/感知/意志/人脉）；角色属性值 1-18，10 为普通水准，主角强项 ≤16 且必须有弱项",
			}),
			openingBeat: Type.String({ description: "第一场怎么开场：60 字以内，写清场景、冲突起点、结尾钩子（唯一预排的拍子）" }),
		}),
		execute: async (_id, raw) => {
			const design = raw as StoryDesign;
			await store.saveDesignBible(design);
			await store.saveArc(1, design.arc);
			collector.design = design;
			return text("已保存开局设计与第一弧目标。");
		},
	};
}

/** Director 专用：save_scene_outline（逐场推演的场大纲） */
export function sceneOutlineTool(store: Store, collector: ToolCollector): AgentTool {
	return {
		name: "save_scene_outline",
		label: "提交场大纲",
		description: "提交根据现有剧情推演出的本场景大纲（节点序列，只此一场，不预排更远）",
		parameters: Type.Object({
			outline: Type.String({ description: "150-300 字：按事件顺序列出本场的 3-6 个关键节点（每个节点一行：发生什么/谁参与/信息增量），最后单列「结尾钩子：…」。必须承接已有剧情与读者的最新选择" }),
		}),
		execute: async (_id, raw) => {
			collector.nextOutline = raw as { outline: string };
			return text("已提交场大纲，待审核。");
		},
	};
}

/**
 * d20 判定（骰子由引擎掷，LLM 只能服从结果）：
 * d20 + 属性修正 vs DC；20=大成功（额外收获），1=大失败（引出新麻烦）。
 * 属性修正 = floor((属性值 - 10) / 2)；角色卡无此属性或无此角色 → 修正 0（普通人/物）。
 */
export function d20CheckTool(store: Store, sceneIndex: number, budget: { used: number; max: number }): AgentTool {
	return {
		name: "d20_check",
		label: "d20 判定",
		description: "成败未定的关键行动掷 d20 判定（结果会改变后续走向、或角色可能付出代价时才用）。结果由引擎掷出、必须服从：大成功=达成且有额外收获；成功=达成；失败=未达成并引出小麻烦；大失败=行动反噬/引出新麻烦。DC 参考：轻易 8 / 普通 12 / 困难 15 / 几乎不可能 18。",
		parameters: Type.Object({
			character: Type.String({ description: "进行判定的角色名（无卡片的普通人/物填「环境」）" }),
			attribute: Type.String({ description: "使用的属性名（须来自世界属性表；不确定就用角色明显强/弱的一项）" }),
			dc: Type.Number({ description: "难度等级 5-25（轻易 8 / 普通 12 / 困难 15 / 几乎不可能 18）" }),
			reason: Type.String({ description: "判定内容一句话，如「撬开后台的门锁」" }),
		}),
		execute: async (_id, params) => {
			if (budget.used >= budget.max) {
				return text(`本场判定次数已用尽（≤${budget.max}）。该行动按常理直接叙述结果，不再掷骰。`);
			}
			const p = params as { character: string; attribute: string; dc: number; reason: string };
			const dc = Math.min(25, Math.max(5, Math.round(Number(p.dc) || 12)));
			const roll = 1 + Math.floor(Math.random() * 20);
			let mod = 0;
			const card = await store.loadCharacter(p.character);
			const stat = card?.state.stats?.[p.attribute];
			if (typeof stat === "number") mod = Math.floor((stat - 10) / 2);
			// 未登记属性提示：写进日志与返回值，校对可据此核对叙述
			let note = "";
			if (!card) note = "（无角色卡，按普通人处理）";
			else if (typeof stat !== "number") note = `（角色卡未登记属性「${p.attribute}」，修正按 0 计）`;
			else {
				const attrs = await store.loadAttributes();
				if (attrs.length > 0 && !attrs.includes(p.attribute)) note = `（属性「${p.attribute}」不在世界属性表中）`;
			}
			const total = roll + mod;
			const outcome: DiceCheck["outcome"] = roll === 20 ? "大成功" : roll === 1 ? "大失败" : total >= dc ? "成功" : "失败";
			budget.used += 1;
			await store.appendDiceCheck({ scene: sceneIndex, character: p.character, attribute: p.attribute, dc, roll, mod, total, outcome, reason: p.reason + note });
			return text(`判定结果：${p.character}〔${p.attribute}〕d20(${roll})${mod >= 0 ? "+" : ""}${mod}=${total} vs DC${dc} → ${outcome}${note}。叙述必须服从此结果。`);
		},
	};
}

/** Director 专用：save_scene_report（场景报告） */
export function sceneReportTool(collector: ToolCollector): AgentTool {
	return {
		name: "save_scene_report",
		label: "提交场景报告",
		description: "提交本场景的结构化报告：摘要、角色状态补丁、伏笔操作、下一场景走向候选",
		parameters: Type.Object({
			title: Type.String(),
			summary: Type.String({ description: "200 字以内，写清信息增量" }),
			characterUpdates: Type.Array(
				Type.Object({
					name: Type.String(),
					patch: Type.Object({
						location: Type.Optional(Type.String()),
						condition: Type.Optional(Type.String()),
						knowledge: Type.Optional(Type.Array(Type.String(), { description: "本场景新增的所知信息" })),
						relationships: Type.Optional(Type.Record(Type.String(), Type.String())),
						emotions: Type.Optional(Type.Array(Type.String(), { description: "本场景的情感事件（一行一条，如「被当众揭穿，羞耻+怨恨」）" })),
					}),
				}),
			),
			foreshadowOps: Type.Array(
				Type.Object({
					action: Type.Union([Type.Literal("plant"), Type.Literal("advance"), Type.Literal("resolve")]),
					id: Type.Optional(Type.String({ description: "advance/resolve 时必填，plant 时可自动生成" })),
					description: Type.Optional(Type.String({ description: "plant 时必填：伏笔内容" })),
					note: Type.Optional(Type.String()),
				}),
			),
			choices: Type.Array(
				Type.Object({
					label: Type.String(),
					description: Type.String(),
					preview: Type.Optional(Type.String({ description: "30-50 字：以该选择为前提的下一场开头画面预览，帮读者决策" })),
				}),
				{ minItems: 2, maxItems: 4 },
			),
			recommendedChoice: Type.Optional(Type.Number({ description: "auto 模式推荐的候选序号（1-based）" })),
			transactions: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({ description: "收支涉及的角色名" }),
						change: Type.Number({ description: "金额：正=收入，负=支出（以 economy.currency 计）" }),
						reason: Type.String({ description: "收支缘由，如「卖掉芯片预付款」「付老鬼情报费」" }),
					}),
					{ description: "本场景发生的收支流水；引擎据此结算角色余额并写账本。场景涉及金钱往来时必填" },
				),
			),
			entityUpdates: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({ description: "实体名（须已在世界实体中注册）" }),
						patch: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]), {
							description: "本场景导致的实体状态变化，如 {民心: -2, 气候: 「大雪封城」}",
						}),
					}),
					{ description: "本场景引起的世界实体状态变化（宏观层面的后果，如物价波动、势力消长）；无则留空" },
				),
			),
		}),
		execute: async (_id, report) => {
			collector.report = report as SceneReport;
			return text("场景报告已提交。");
		},
	};
}

/** Director 专用：save_memory_distill（弧边界的角色记忆蒸馏） */
export function memoryDistillTool(collector: ToolCollector): AgentTool {
	return {
		name: "save_memory_distill",
		label: "提交记忆蒸馏",
		description: "提交全部角色的记忆压缩结果：远期所知并入小传，knowledge 只留近况",
		parameters: Type.Object({
			characters: Type.Array(
				Type.Object({
					name: Type.String(),
					basics: Type.String({ description: "压缩后的人物小传 ≤250 字（含并入的远期经历）" }),
					knowledge: Type.Array(Type.String(), { description: "≤10 条，从最新往回保留" }),
				}),
				{ description: "必须覆盖全部角色" },
			),
		}),
		execute: async (_id, raw) => {
			collector.distilled = raw as { characters: { name: string; basics: string; knowledge: string[] }[] };
			return text("记忆蒸馏结果已提交。");
		},
	};
}

/** Director 专用：plan_next_arc（弧边界：续弧或完结） */
export function arcPlanTool(collector: ToolCollector): AgentTool {
	return {
		name: "plan_next_arc",
		label: "弧边界规划",
		description: "弧收束后提交故事走向决定：continue 设计下一弧（标题+一句话目标），finish 收束全篇（说明悬念如何解决）",
		parameters: Type.Object({
			decision: Type.Union([Type.Literal("continue"), Type.Literal("finish")], {
				description: "continue=核心悬念未了，开下一弧；finish=premise 承诺的冲突已解决，完结",
			}),
			title: Type.Optional(Type.String({ description: "continue 时必填：下一弧标题" })),
			goal: Type.Optional(Type.String({ description: "continue 时必填：下一弧的一句话目标，须从未回收伏笔与本弧结局自然生长" })),
			reason: Type.Optional(Type.String({ description: "finish 时必填：核心悬念如何解决、哪些伏笔收了/留白" })),
		}),
		execute: async (_id, raw) => {
			collector.arcPlan = raw as { decision: "continue" | "finish"; title?: string; goal?: string; reason?: string };
			return text("弧边界规划已提交。");
		},
	};
}

/** Director 专用：save_arc_revision（玩家通过聊天意见修订弧大纲） */
export function arcRevisionTool(store: Store, collector: ToolCollector, arcIndex: number): AgentTool {
	return {
		name: "save_arc_revision",
		label: "提交弧大纲修订",
		description: `提交第 ${arcIndex} 弧修订后的大纲（标题 + 一句话目标），保存后立即生效`,
		parameters: Type.Object({
			title: Type.String({ description: "弧标题；无特殊理由保留原题" }),
			goal: Type.String({ description: "修订后的一句话目标：吸收读者意见，且与已有剧情、已埋伏笔连贯" }),
		}),
		execute: async (_id, raw) => {
			const { title, goal } = raw as { title: string; goal: string };
			await store.saveArc(arcIndex, { title, goal });
			collector.arcRevision = { title, goal };
			return text("弧大纲修订已保存。");
		},
	};
}

/** 通用：web_search（联网查证现实知识；引擎自研，Bing 优先 DuckDuckGo 兜底，零依赖） */
export function webSearchTool(): AgentTool {
	return {
		name: "web_search",
		label: "联网查证",
		description: "搜索真实世界资料（史实、物价、地理、技术水平等），用于让故事贴合现实背景。返回若干条标题+摘要+链接。只用于查证现实知识，不用于虚构剧情。",
		parameters: Type.Object({
			query: Type.String({ description: "搜索词，可用空格分隔关键词，如「清末 1900年 北京 米价 银两」" }),
		}),
		execute: async (_id, params) => {
			const { query } = params as { query: string };
			const results = await webSearch(query);
			if (results === null) return text(`（联网搜索失败：本次查证不可用，请依据你已有的知识继续，并在行文时保持保守）`);
			if (results.length === 0) return text(`（「${query}」无搜索结果）`);
			return text(results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`).join("\n"));
		},
	};
}

interface WebSearchResult { title: string; snippet: string; url: string }

/** 同域名限频（≥1s 间隔，降反爬） */
const lastRequestMs = new Map<string, number>();

function rateLimitHost(host: string): Promise<void> {
	const last = lastRequestMs.get(host) ?? 0;
	const wait = Math.max(0, 1000 - (Date.now() - last));
	lastRequestMs.set(host, Date.now());
	return new Promise((r) => setTimeout(r, wait));
}

const stripTags = (s: string) =>
	s
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/<[^>]*$/g, "")
		.trim();

async function webSearch(query: string): Promise<WebSearchResult[] | null> {
	// 双源互备：Bing 优先，DDG 兜底；主源失败/超时自动切换，总预算由各自 9s 超时封顶
	const [bing, ddg] = await Promise.all([
		trySearch(
			`https://cn.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&count=8`,
			/<li class="b_algo"[\s\S]*?<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>([\s\S]*?)<\/li>/g,
			/<p[^>]*>([\s\S]*?)<\/p>/,
		),
		trySearch(
			`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
			/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="result__a"|<\/div>\s*<\/div>\s*<\/div>|$)/g,
			/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/,
		),
	]);
	// 失败可见性：任一源失败都留痕（console），双源全败返回 null（工具会提示 LLM 保守行文）
	if (bing && bing.length > 0) return bing;
	if (ddg && ddg.length > 0) return ddg;
	if (bing === null && ddg === null) {
		console.error("[webSearch] 双源均失败（Bing/DDG），query=", query.slice(0, 60));
	} else if ((bing?.length ?? 0) === 0 && (ddg?.length ?? 0) === 0) {
		console.warn("[webSearch] 双源连通但解析结果为空（页面结构可能已变），query=", query.slice(0, 60));
	}
	return null;
}

async function trySearch(url: string, itemRe: RegExp, snippetRe: RegExp): Promise<WebSearchResult[] | null> {
	const host = new URL(url).host;
	await rateLimitHost(host); // 同域名限频，降反爬
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 9000);
	try {
		const res = await fetch(url, {
			headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "accept-language": "zh-CN,zh;q=0.9" },
			signal: ctrl.signal,
		});
		clearTimeout(timer);
		if (!res.ok) {
			console.error(`[webSearch] ${host} HTTP ${res.status}`);
			return null;
		}
		const html = await res.text();
		const out: WebSearchResult[] = [];
		for (const m of html.matchAll(itemRe)) {
			const url2 = (m[1] ?? "").trim();
			const title = stripTags(m[2] ?? "");
			const seg = m[3] ?? "";
			const sn = seg.match(snippetRe);
			const snippet = stripTags(sn?.[1] ?? seg).slice(0, 220);
			if (title && url2.startsWith("http")) out.push({ title, snippet, url: url2 });
			if (out.length >= 6) break;
		}
		return out;
	} catch (err) {
		clearTimeout(timer);
		const aborted = err instanceof Error && err.name === "AbortError";
		console.error(`[webSearch] ${host} ${aborted ? "超时(9s)" : `异常 ${err instanceof Error ? err.message : String(err)}`}`);
		return null;
	}
}

/** 通用：save_history_notes（把查证到的史实固化进史料库，供后续所有场景参照） */
export function saveHistoryNotesTool(store: Store): AgentTool {
	return {
		name: "save_history_notes",
		label: "存史料",
		description: "把联网查证到的史实/背景知识（物价、技术、政治格局、生活细节…）保存进故事史料库。设计开局时应尽量把关键史实固化下来，后续场景写作将自动参照。",
		parameters: Type.Object({
			title: Type.String({ description: "史料标题，如「清末物价与民生」" }),
			content: Type.String({ description: "史料要点，分条陈述，300-800 字；写对剧情有约束力的事实，不要小说笔法" }),
		}),
		execute: async (_id, params) => {
			const { title, content } = params as { title: string; content: string };
			const slug = title.replace(/[^\w一-鿿-]/g, "").slice(0, 24) || "笔记";
			await store.writeText(`设定/史料-${slug}.md`, `# ${title}

${content}
`);
			return text(`史料已保存：设定/史料-${slug}.md`);
		},
	};
}

/** Reviewer 专用：submit_verdict（裁决） */
export function verdictTool(collector: ToolCollector): AgentTool {
	return {
		name: "submit_verdict",
		label: "提交校对裁决",
		description: "提交校对结论：pass 为是否通过；issues 中每个问题必须附草稿原文引用",
		parameters: Type.Object({
			pass: Type.Boolean(),
			issues: Type.Array(
				Type.Object({
					quote: Type.String({ description: "从草稿中摘出的原文" }),
					constraint: Type.String({ description: "违反的约束，如「角色状态：主角 location」" }),
					problem: Type.String({ description: "具体矛盾点" }),
				}),
			),
		}),
		execute: async (_id, verdict) => {
			collector.verdict = verdict as Verdict;
			return text("裁决已提交。");
		},
	};
}

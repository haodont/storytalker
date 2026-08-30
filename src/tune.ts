// Prompt 调优台：本地小模型上批量对比 Writer/Reviewer 的 prompt 变体。
//   npm run tune
// 用法：改下方 WRITER_VARIANTS / REVIEWER_VARIANTS，跑一次看指标与全文输出（tune-out/<时间戳>/）。
// 前提：本地 llama-server 已启动（.env 的 LOCAL_BASE_URL；9B ≈72 tok/s，单用例十几秒）。

import { promises as fs } from "node:fs";
import path from "node:path";
import { Store } from "./facts/store.js";
import type { GameState } from "./facts/types.js";
import { detectRepetitionLoop } from "./engine/engine.js";
import { assembleWriterPrompt, assembleReviewerPrompt } from "./engine/context.js";
import { runAgent } from "./agents/agents.js";
import { WRITER_SYSTEM, REVIEWER_SYSTEM } from "./agents/prompts.js";
import { createLlm, createMockLlm } from "./llm.js";

// ============================ 变体定义（改这里） ============================

const WRITER_VARIANTS: { name: string; system: string }[] = [
	{ name: "baseline", system: WRITER_SYSTEM },
	{
		name: "v-hook-force",
		system: WRITER_SYSTEM + "\n- 最后一句话必须是一个悬而未决的钩子（新信息/意外动作/不祥细节），禁止收束感、禁止总结性语句。",
	},
	{
		name: "v-lean-prose",
		system: WRITER_SYSTEM + "\n- 心理描写全场景不得超过两句；信息通过动作与对话呈现，不用形容词堆砌；句长错落，连续三句等长视为违规。",
	},
	{
		name: "v-sensory",
		system: WRITER_SYSTEM + "\n- 每个场景至少落实两种非视觉感官（声音/气味/触感/温度），具体到物，不许写「空气中弥漫着…」这类套话；情绪一律不直接命名，只写身体反应与动作。",
	},
	{
		name: "v-dialogue-drive",
		system: WRITER_SYSTEM + "\n- 关键信息增量优先通过对白给出，叙述只负责动作与镜头；独白和心理活动全场景合计不超过两句；每段对白要能看出说话人身份差异（用词、句长、口癖）。",
	},
	{
		name: "v-cold-open",
		system: WRITER_SYSTEM + "\n- 第一句必须是人物动作或对白，禁止以天气、环境、时间开场；前情通过只言片语带出，不做回顾式铺垫；结尾停在钩子上。",
	},
	{
		name: "v-tension-line",
		system: WRITER_SYSTEM + "\n- 全场景维持一条可见的威胁线：每 3-4 段让威胁具体化一次（声音逼近/时限/目击者）；角色每次行动都要付出小代价；结尾钩子必须是威胁的升级而非悬念的重复。",
	},
];

const REVIEWER_VARIANTS: { name: string; system: string }[] = [
	{ name: "baseline", system: REVIEWER_SYSTEM },
	{
		name: "v-three-lens",
		system: REVIEWER_SYSTEM + "\n只按三个镜头逐项过一遍草稿：①位置镜头（每个出场角色的上一位置）②所知镜头（每句话的信息来源）③钱包镜头（每笔消费与余额）。镜头外的问题一律不报。",
	},
	{
		name: "v-quote-first",
		system: REVIEWER_SYSTEM + "\n先摘出所有与「角色状态快照」字面冲突的句子，再判断是否真矛盾；宁可少报不可误报，无把握直接 pass。",
	},
	{
		name: "v-location-walk",
		system: REVIEWER_SYSTEM + "\n校验第一步：先从「角色状态快照」中逐角色抄下其位置字段，再在草稿中找到该角色出现的首个场景核对地点；未交代移动过程而位置突变，必须作为 issue 报出（constraint 写「角色状态：location」），不许以「可能赶路了」放行。",
	},
	{
		name: "v-lens-strict",
		system: REVIEWER_SYSTEM + "\n只按三个镜头逐项过一遍草稿：①位置镜头（先从角色状态快照抄下每个角色的位置，再核对草稿中该角色出现的首个场景；未交代移动而位置突变必须报出，不许以「可能赶路了」放行）②所知镜头（每句话的信息来源）③钱包镜头（每笔消费与余额）。镜头外的问题一律不报。",
	},
	{
		name: "v-checklist-echo",
		system: REVIEWER_SYSTEM + "\n先在 JSON 之前用纯文本输出核对清单：逐角色抄状态快照的位置与所知、列出草稿中的每笔消费与当前余额——抄完清单再给裁决 JSON。清单里对不上的条目必须出现在 issues 中。",
	},
	{
		name: "v-sentence-scan",
		system: REVIEWER_SYSTEM + "\n把草稿按句编号逐句过：每句标注「触犯：<约束名>」或「ok」，扫完全部句子后才允许给出裁决；issues 必须引用被标记句子的原文。",
	},
	{
		name: "v-adversarial",
		system: REVIEWER_SYSTEM + "\n默认这份草稿至少藏了 3 处与约束清单的矛盾（位置/所知/经济是高危区），你的任务是全部找出；每找到一处要引用原文并说明违反的约束。找不满 3 处时，逐条说明你排查过哪些约束、为何排除。",
	},
];

// ============================ 固定夹具（不要改） ============================

const WORKSPACE = "tune-workspace";
const OUT_DIR = "tune-out";

/** 注入 3 处矛盾的坏草稿：①位置错（快照在长街，无移动直接跳到奥米加大楼底层）②说破伏笔 ③经济穿帮 */
const BAD_DRAFT = `雨还没停，林默躲进奥米加大楼底层的无人便利店，暖黄的灯光下把芯片贴在收银台边缘的读卡器上。
屏幕跳出一行字：「伊甸园计划， seventh batch——你就是第七批的观察对象之一。」他这才明白，神秘人根本不是追杀者，而是奥米加派来的联络员，代号 K-73。
店员打了个哈欠。林默刷了 5000 信用点，买下货架上最贵的防水外套和两罐热咖啡，转身走进雨里。这一夜，长街的灯还亮着，可他知道自己再也回不去了。`;

async function buildFixture(): Promise<{ store: Store; state: GameState }> {
	await fs.rm(WORKSPACE, { recursive: true, force: true });
	const store = new Store(WORKSPACE);
	await store.ensureWorkspace();

	await store.saveDesignBible({
		title: "长街疑影",
		premise: "都市夜行人与神秘来客的博弈",
		worldRules: "现代都市，低魔设定，异能罕见且隐秘。奥米加科技垄断神经接口产业。",
		economy: { currency: "信用点", overview: "普通工薪月薪约 3000 信用点；黑市情报按条计价；主角手头紧，存款只够两个月房租。" },
		attributes: ["体魄", "敏捷", "头脑", "感知", "意志", "人脉"],
		characters: [
			{ name: "主角", basics: "普通上班族，意外卷入事件。", initialState: { location: "长街", condition: "健康", knowledge: ["神秘人的存在"], relationships: {}, stats: { 体魄: 9, 敏捷: 12, 头脑: 11, 感知: 10, 意志: 13, 人脉: 6 }, finance: { balance: 400, income: "月薪 3000 信用点", debts: ["下月房租 1500"] } } },
			{ name: "神秘人", basics: "来历不明，似乎知晓主角的秘密。", initialState: { location: "未知", condition: "未知", knowledge: ["主角的秘密"], relationships: {} } },
		],
		arc: { title: "第一弧·初遇", goal: "主角与神秘人的初次交锋，揭开芯片秘密的一角" },
		openingBeat: "主角在长街接收匿名包裹，神秘人现身留下警告。",
	});

	await store.saveSceneText(1, "场景1", "暮色像一层薄纱，缓缓覆盖了这座城。长街尽头的灯笼次第亮起，他捏着那枚芯片站在檐下，远处脚步声越来越近。「你终于来了。」黑暗里有人轻声说。");
	await store.saveSceneSummary(1, {
		title: "第1场",
		summary: "主角在长街接收匿名包裹并遭遇神秘人，对方留下警告后消失；主角得知芯片与「神秘人」有关，埋下疑点。",
		characterUpdates: [],
		foreshadowOps: [{ action: "plant", id: "F001", description: "神秘人的真实身份" }],
		choices: [{ label: "追上去", description: "追查神秘人的下落" }],
		recommendedChoice: 1,
		transactions: [{ name: "主角", change: -80, reason: "逃离长街的打车费" }],
	});
	await store.saveForeshadows([{ id: "F001", description: "神秘人的真实身份", plantedAtScene: 1, status: "open", notes: [] }]);
	await store.appendChoice(1, "原地观察——按兵不动，看清来者意图", "player");

	const state: GameState = {
		phase: "playing",
		mode: "auto",
		title: "长街疑影",
		premise: "都市夜行人与神秘来客的博弈",
		sceneIndex: 1,
		arcBeatIndex: 2,
		arc: { title: "第一弧·初遇", goal: "主角与神秘人的初次交锋，揭开芯片秘密的一角" },
		arcCount: 1,
		attempt: 0,
		pendingReport: null,
		ideaMsgs: [],
		currentOutline: "1）主角决定原地观察，神秘人却在暗处主动接近；\n2）神秘人抛出关于芯片的第一条线索，暗示「伊甸园」；\n3）主角试图反问，对方以警告回应后隐入雨中；\n结尾钩子：主角发现自己的手机被远程激活。",
		updatedAt: new Date().toISOString(),
	};
	return { store, state };
}

// ============================ 执行 ============================

async function main(): Promise<void> {
	const mock = process.argv.includes("--mock");
	const llm = mock ? createMockLlm() : createLlm();
	const { store, state } = await buildFixture();
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir = path.join(OUT_DIR, stamp);
	await fs.mkdir(outDir, { recursive: true });
	const summary: string[] = [];

	// ---- Writer 变体 ----
	const writerPrompt = await assembleWriterPrompt(store, state);
	console.log("\n═══ Writer 变体对比 ═══\n");
	for (const v of WRITER_VARIANTS) {
		const t0 = Date.now();
		const result = await runAgent({ role: "writer", llm, system: v.system, tools: [], prompt: writerPrompt });
		const secs = (Date.now() - t0) / 1000;
		const draft = result.text.trim();
		const repeats = detectRepetitionLoop(draft).length;
		const tps = result.tokens.output > 0 ? (result.tokens.output / secs).toFixed(1) : "?";
		const line = `[${v.name}] ${secs.toFixed(1)}s  ${tps} tok/s  ${draft.length} 字  复读块=${repeats}`;
		console.log(line);
		summary.push(line);
		await fs.writeFile(path.join(outDir, `writer-${v.name}.md`), `<!-- ${line} -->\n\n${draft}\n`, "utf8");
	}

	// ---- Reviewer 变体（同一坏稿：注入 位置/伏笔/经济 三处矛盾） ----
	const reviewerPrompt = await assembleReviewerPrompt(store, state, BAD_DRAFT);
	console.log("\n═══ Reviewer 变体对比（坏稿注入：①位置错 ②说破伏笔 ③经济穿帮）═══\n");
	for (const v of REVIEWER_VARIANTS) {
		const t0 = Date.now();
		const result = await runAgent({ role: "reviewer", llm, system: v.system, tools: [], prompt: reviewerPrompt });
		const secs = (Date.now() - t0) / 1000;
		// 无工具直连时 mock/模型以文本回话；让模型把结论写在文本里（调优台不做工具环）
		const text = result.text.trim();
		const caughtLocation = /位置|便利店|长街/.test(text) && !/pass[：:]?\s*true/i.test(text);
		const caughtForeshadow = /伏笔|说破|身份/.test(text) && !/pass[：:]?\s*true/i.test(text);
		const caughtEconomy = /经济|余额|5000|消费/.test(text) && !/pass[：:]?\s*true/i.test(text);
		const caught = [caughtLocation, caughtForeshadow, caughtEconomy].filter(Boolean).length;
		const line = `[${v.name}] ${secs.toFixed(1)}s  捕获 ${caught}/3（位置${caughtLocation ? "✓" : "✗"} 伏笔${caughtForeshadow ? "✓" : "✗"} 经济${caughtEconomy ? "✓" : "✗"}）`;
		console.log(line);
		summary.push(line);
		await fs.writeFile(path.join(outDir, `reviewer-${v.name}.md`), `<!-- ${line} -->\n\n${text}\n`, "utf8");
	}

	console.log(`\n—— 汇总 ——\n${summary.join("\n")}`);
	console.log(`\n全文输出：${outDir}/`);
	await fs.rm(WORKSPACE, { recursive: true, force: true });
	process.exit(0);
}

main().catch((err) => {
	console.error("调优失败:", err);
	process.exit(1);
});

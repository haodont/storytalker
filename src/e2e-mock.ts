// 无头端到端自测：mock LLM 下跑完 开局 → 10 场景（校对只诊断）→ 弧收束 → 存档
//   npm run e2e

import { promises as fs } from "node:fs";
import path from "node:path";
import { Store } from "./facts/store.js";
import { Engine, type EngineEvent } from "./engine/engine.js";
import { createLlm, createMockLlm, mockWriterPrompts } from "./llm.js";

const WORKSPACE = "test-workspace";
const WORKSPACE_MANUAL = "test-workspace-manual";

async function testManualMode(): Promise<[string, boolean][]> {
	const checks: [string, boolean][] = [];
	await fs.rm(WORKSPACE_MANUAL, { recursive: true, force: true });
	process.env.NOVEL_WORKSPACE = WORKSPACE_MANUAL;

	const store = new Store(WORKSPACE_MANUAL);
	const events: EngineEvent[] = [];
	const engine = new Engine(store, createMockLlm(), (ev) => {
		events.push(ev);
	});

	// 1) 灵感酝酿阶段：chatIdea + buildFromIdea
	await engine.chatIdea("赛博都市的地下拳击手");
	const ideaEvents = events.filter((e) => e.type === "idea_done");
	checks.push(["手动模式：灵感对话产出回复", ideaEvents.length > 0]);

	await engine.buildFromIdea("加上时间循环元素");
	// 等待设计完成
	await waitForEvent(events, "boot_ready", 60_000);
	checks.push(["手动模式：buildFromIdea 触发开局设计", events.some((e) => e.type === "boot_ready")]);

	// 2) confirm_bible 阶段：带反馈的确认
	await engine.confirmBible("主角改成女性");
	// 等待重新设计完成
	await waitForEvent(events, "boot_ready", 60_000);
	const bootEvents = events.filter((e) => e.type === "boot_ready");
	checks.push(["手动模式：confirmBible 带反馈触发重新设计", bootEvents.length >= 2]);

	// 3) 正式确认开局
	await engine.confirmBible();
	await waitForEvent(events, "scene_done", 60_000);
	checks.push(["手动模式：confirmBible 无参确认开局", events.some((e) => e.type === "scene_done")]);

	// 4) 手动模式：resolveChoice 用序号
	// 等待 choices 事件
	await waitForEvent(events, "choices", 10_000);
	const choiceEv = events.find((e) => e.type === "choices");
	checks.push(["手动模式：首场产出 choices", !!choiceEv]);

	if (choiceEv && choiceEv.type === "choices" && choiceEv.choices.length > 0) {
		await engine.resolveChoice("1");
		await waitForEvent(events, "scene_done", 60_000);
		checks.push(["手动模式：resolveChoice 序号推进剧情", events.filter((e) => e.type === "scene_done").length >= 2]);
	}

	// 5) 手动模式：resolveChoice 用自由文本
	await waitForEvent(events, "choices", 10_000);
	await engine.resolveChoice("转身逃跑，冲进最近的地铁站");
	await waitForEvent(events, "scene_done", 60_000);
	checks.push(["手动模式：resolveChoice 自由文本推进剧情", events.filter((e) => e.type === "scene_done").length >= 3]);

	// 6) steer 插话（写作进行中）
	// steer 只在 pipelineBusy 期间有效；手动模式下场景生成快，测试 steer 的发射路径
	engine.steer("加一段打斗");
	// steer 不影响场景完成，只检查不报错
	checks.push(["手动模式：steer 不抛异常", true]);

	// 7) reviseArc 大纲修订
	// reviseArc 在 playing 阶段可用
	await waitForEvent(events, "scene_done", 10_000); // 确保在 playing 阶段
	await engine.reviseArc("增加悬疑元素");
	// 等待修订完成（会触发 outline_updated 事件）
	await waitForEvent(events, "outline_updated", 30_000);
	const outlineUpdated = events.some((e) => e.type === "outline_updated");
	checks.push(["手动模式：reviseArc 触发大纲更新", outlineUpdated]);

	// 8) setMode 切换
	await engine.setMode("auto");
	checks.push(["手动模式：setMode 切换成功", engine.gameState.mode === "auto"]);

	// 清理
	process.env.NOVEL_WORKSPACE = WORKSPACE;
	return checks;
}

function waitForEvent(events: EngineEvent[], type: string, timeout: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeout;
		const check = () => {
			if (events.some((e) => e.type === type)) { resolve(); return; }
			if (Date.now() > deadline) { reject(new Error(`等待 ${type} 事件超时`)); return; }
			setTimeout(check, 50);
		};
		check();
	});
}

async function main(): Promise<void> {
	await fs.rm(WORKSPACE, { recursive: true, force: true });
	process.env.NOVEL_WORKSPACE = WORKSPACE;

	const store = new Store(WORKSPACE);
	const events: EngineEvent[] = [];
	const ended = new Promise<void>((resolve) => {
		const engine = new Engine(store, createMockLlm(), (ev) => {
			events.push(ev);
			if (ev.type === "status") console.log(`  [status] ${ev.text}`);
			if (ev.type === "review") console.log(`  [review] pass=${ev.pass} issues=${ev.issues.length}`);
			if (ev.type === "scene_done") console.log(`  [scene_done] 场景 ${ev.scene}（${ev.text.length} 字）`);
			if (ev.type === "error") console.log(`  [error] ${ev.message}`);
			if (ev.type === "ended") resolve();
		});

		void (async () => {
			await engine.setMode("auto");
			await engine.startPremise("都市夜行人与神秘来客的博弈（e2e）");
			await engine.confirmBible();
		})();
	});

	await Promise.race([ended, new Promise((_, rej) => setTimeout(() => rej(new Error("E2E 超时")), 120_000))]);

	// ---- 断言 ----
	const checks: [string, boolean][] = [];
	const exists = async (rel: string) => (await store.readText(rel)) !== null;

	checks.push(["世界观已生成", await exists("设定/世界观.md")]);
	checks.push(["总纲已生成", await exists("大纲/总纲.md")]);
	checks.push(["弧大纲 JSON", (await store.loadArc(1)) !== null]);
	checks.push(["弧大纲 MD", await exists("大纲/弧-01.md")]);

	const characters = await store.listCharacters();
	checks.push(["角色档案 ≥2", characters.length >= 2]);
	checks.push(["主角状态被更新", ((await store.loadCharacter("主角"))?.state.knowledge?.length ?? 0) > 0]);

	const summaries = await store.listDir("记忆/场景摘要");
	checks.push(["场景摘要 = 20（两弧）", summaries.length === 20]);

	const chapters = await store.listDir("章稿");
	checks.push(["章稿 = 20（两弧）", chapters.length === 20]);

	const foreshadows = await store.loadForeshadows();
	checks.push(["伏笔台账非空", foreshadows.length > 0]);

	// 世界实体 / 经济模板 / 史料库
	const entities = await store.loadEntities();
	checks.push(["世界实体已注册（设计时）", entities.length >= 2]);
	checks.push(["实体状态随剧情演化", entities.find((e) => e.name === "长街")?.state["气氛"] === "雨夜戒严"]);
	checks.push(["经济模板价格表已落盘", ((await store.readJson<{ commodities?: unknown[] }>("设定/经济.json"))?.commodities?.length ?? 0) > 0]);
	checks.push(["史料库已固化联网查证知识", (await store.listHistoryNotes()).length > 0]);

	// 经济结算：20 场景 × -80，1200 起始 → -400
	checks.push(["经济设定已落盘", await exists("设定/经济.md")]);
	const ledger = await store.loadLedger();
	checks.push(["账本流水 = 20", ledger.length === 20]);
	const bal = (await store.loadCharacter("主角"))?.state.finance?.balance;
	checks.push(["主角余额按流水结算（1200-80×20=-400）", bal === -400]);

	const history = (await store.readText("记忆/选择历史.jsonl"))?.trim().split("\n").length ?? 0;
	checks.push(["选择历史 = 20", history === 20]);

	checks.push(["Reviewer 打回过一次（大纲审核-修订环）", events.some((e) => e.type === "review" && !e.pass)]);
	checks.push(["后续裁决通过（正文校对只诊断不打回）", events.some((e) => e.type === "review" && e.pass)]);

	// 上下文内容断言：锁死"记忆滞后一场"类 off-by-one 回归（写手必须见过上一场的摘要与结尾）
	const tailMd = await store.readText("章稿/场景-009.md");
	const tail = tailMd ? tailMd.slice(-100) : "";
	checks.push(["写手上下文含上一场（场景9）摘要", mockWriterPrompts.some((p) => p.includes("场景9「"))]);
	checks.push(["写手上下文含上一场结尾原文", tail.length > 20 && mockWriterPrompts.some((p) => p.includes(tail))]);

	// 多弧续玩：第 1 弧收束后导播续开第 2 弧，第 2 弧收束后完结
	checks.push(["弧2大纲已生成（多弧续玩）", (await store.loadArc(2)) !== null]);
	checks.push(["第2弧已开启（outline_updated arc=2）", events.some((e) => e.type === "outline_updated" && e.arc === 2)]);
	const arcSummaryMd = await store.readText("记忆/弧摘要.md");
	checks.push(["弧摘要含两弧的收尾场（场景10/场景20）", !!arcSummaryMd?.includes("场景10：") && !!arcSummaryMd?.includes("场景20：")]);

	const autosave = await store.readJson<import("./facts/types.js").GameState>("存档/current.json");
	checks.push(["autosave phase=ended", autosave?.phase === "ended"]);

	// 读档：任意存档位 → 新引擎 load 恢复
	await store.writeJson("存档/test-slot.json", autosave!);
	const engineLoad = new Engine(store, createMockLlm(), () => {});
	let loadedPhase = "";
	await engineLoad.load("test-slot");
	loadedPhase = engineLoad.gameState.phase;
	checks.push(["读档恢复状态", loadedPhase === "ended"]);
	const saves = await engineLoad.listSaves();
	checks.push(["存档位列表", saves.some((s) => s.name === "test-slot")]);

	// BM25 检索：命中 + 排序（设定/记忆类短文档应排在工作区正文之前）
	const hits = await store.search("神秘人");
	checks.push(["BM25 检索命中", hits.length > 0]);
	checks.push(["BM25 首位为设定/记忆类相关文件", hits[0]!.file.startsWith("设定") || hits[0]!.file.startsWith("记忆")]);

	// 断点恢复：模拟崩溃后从 playing 中期恢复（在分叉出的工作区上验证）
	// 恢复测试（同时验证工作区参数化/分叉）：复制工作区到分叉目录，构造 playing 中断态再 boot
	const FORK = "test-workspace-fork";
	await fs.rm(FORK, { recursive: true, force: true });
	await fs.cp(path.resolve(WORKSPACE), path.resolve(FORK), { recursive: true });
	const forkStore = new Store(FORK);
	await forkStore.writeJson("存档/current.json", {
		phase: "playing",
		mode: "auto",
		title: "恢复测试",
		premise: "x",
		sceneIndex: 3,
		arcBeatIndex: 4,
		arc: (await forkStore.loadArc(1))!,
		arcCount: 1,
		pendingReport: null,
		ideaMsgs: [],
		substate: "reviewing",
		updatedAt: new Date().toISOString(),
	});
	let resumed = false;
	let interruptedNote = false;
	const engine2 = new Engine(forkStore, createMockLlm(), (ev) => {
		if (ev.type === "status") console.log(`  [resume status] ${ev.text}`);
		if (ev.type === "status" && ev.text.includes("中断")) interruptedNote = true;
		if (ev.type === "scene_done") resumed = true;
	});
	await engine2.boot();
	await new Promise((r) => setTimeout(r, 500));
	checks.push(["分叉工作区：boot 后继续出稿", resumed]);
	checks.push(["子状态中断点精确提示", interruptedNote]);

	console.log("\n—— 断言结果 ——");
	let failed = 0;
	for (const [name, ok] of checks) {
		console.log(`  ${ok ? "✓" : "✗"} ${name}`);
		if (!ok) failed++;
	}

	// 手动模式测试
	console.log("\n═══ 手动模式 E2E ═══\n");
	const manualChecks = await testManualMode();
	for (const [name, ok] of manualChecks) {
		console.log(`  ${ok ? "✓" : "✗"} ${name}`);
		if (!ok) failed++;
	}

	console.log(`\n结果：${failed === 0 ? "全部通过 ✓" : `${failed} 项失败 ✗`}`);
	// 清理：等待异步操作结束后删除（Windows 下文件句柄未释放会 ENOTEMPTY）
	await new Promise((r) => setTimeout(r, 200));
	await fs.rm(path.resolve(WORKSPACE), { recursive: true, force: true }).catch(() => {});
	await fs.rm(path.resolve(FORK), { recursive: true, force: true }).catch(() => {});
	await fs.rm(path.resolve(WORKSPACE_MANUAL), { recursive: true, force: true }).catch(() => {});
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("E2E 失败:", err);
	process.exit(1);
});

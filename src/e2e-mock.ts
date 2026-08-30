// 无头端到端自测：mock LLM 下跑完 开局 → 10 场景（含校验重写环）→ 弧收束 → 存档
//   npm run e2e

import { promises as fs } from "node:fs";
import path from "node:path";
import { Store } from "./facts/store.js";
import { Engine, type EngineEvent } from "./engine/engine.js";
import { createMockLlm } from "./llm.js";

const WORKSPACE = "test-workspace";

async function main(): Promise<void> {
	await fs.rm(WORKSPACE, { recursive: true, force: true });
	process.env.NOVEL_WORKSPACE = WORKSPACE;

	const store = new Store(WORKSPACE);
	const events: EngineEvent[] = [];
	const ended = new Promise<void>((resolve) => {
		const engine = new Engine(store, createMockLlm(), (ev) => {
			events.push(ev);
			if (ev.type === "status") console.log(`  [status] ${ev.text}`);
			if (ev.type === "review") console.log(`  [review] attempt=${ev.attempt} pass=${ev.pass} issues=${ev.issues.length}`);
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
	checks.push(["场景摘要 = 10", summaries.length === 10]);

	const chapters = await store.listDir("章稿");
	checks.push(["章稿 = 10", chapters.length === 10]);

	const foreshadows = await store.loadForeshadows();
	checks.push(["伏笔台账非空", foreshadows.length > 0]);

	// 经济结算：10 场景 × -80，1200 起始 → 400
	checks.push(["经济设定已落盘", await exists("设定/经济.md")]);
	const ledger = await store.loadLedger();
	checks.push(["账本流水 = 10", ledger.length === 10]);
	const bal = (await store.loadCharacter("主角"))?.state.finance?.balance;
	checks.push(["主角余额按流水结算（1200-80×10=400）", bal === 400]);

	const history = (await store.readText("记忆/选择历史.jsonl"))?.trim().split("\n").length ?? 0;
	checks.push(["选择历史 = 10", history === 10]);

	checks.push(["Reviewer 首稿拦截生效", events.some((e) => e.type === "review" && !e.pass)]);
	checks.push(["重写后通过", events.some((e) => e.type === "review" && e.pass)]);

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
		attempt: 0,
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

	console.log(`\n结果：${failed === 0 ? "全部通过 ✓" : `${failed} 项失败 ✗`}`);
	await fs.rm(path.resolve(WORKSPACE), { recursive: true, force: true });
	await fs.rm(path.resolve(FORK), { recursive: true, force: true });
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("E2E 失败:", err);
	process.exit(1);
});

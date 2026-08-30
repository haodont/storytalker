// 本地模型内容试跑：LLM_PROVIDER=local 下跑 开局设计 → 第一个场景（含校对），
// 打印全程输出用于评估模型写作质量。用法：npm run try:local

import { promises as fs } from "node:fs";
import { Store } from "./facts/store.js";
import { Engine, type EngineEvent } from "./engine/engine.js";
import { createLlm } from "./llm.js";

const WORKSPACE = "try-workspace";

async function main(): Promise<void> {
	await fs.rm(WORKSPACE, { recursive: true, force: true });
	const store = new Store(WORKSPACE);

	const engine = new Engine(store, createLlm(), (ev: EngineEvent) => {
		switch (ev.type) {
			case "status":
				console.log(`\n[${ev.text}]`);
				break;
			case "scene_delta":
				process.stdout.write(ev.text);
				break;
			case "scene_done":
				console.log(`\n\n========== 第 ${ev.scene} 场定稿（${ev.text.length} 字）==========\n${ev.text}\n`);
				break;
			case "boot_ready": {
				console.log(`\n《${ev.title}》 ${ev.premise}`);
				console.log(ev.characters.map((c) => `  · ${c}`).join("\n"));
				console.log(`第一弧「${ev.arcTitle}」目标：${ev.arcGoal}`);
				console.log(`开场拍：${ev.openingBeat}`);
				break;
			}
			case "review":
				console.log(`[校对] pass=${ev.pass} issues=${ev.issues.length}${ev.pass ? "" : " → " + ev.issues.map((i) => i.problem).join("；")}`);
				break;
			case "choices":
				console.log(`[走向候选] ${ev.choices.map((c, i) => `${i + 1}. ${c.label}`).join("  ")}`);
				break;
			case "error":
				console.error(`[错误] ${ev.message}`);
				break;
		}
	});

	engine.setMode("auto");
	const premise = process.argv[2] ?? "深山客栈的暴雪夜，住进了六位互不相识的旅人";
	console.log(`题材：「${premise}」\n`);
	await engine.startPremise(premise);
	await engine.confirmBible();

	// 等第一个场景定稿 + 场景报告（走向候选）即止
	await new Promise<void>((resolve) => {
		const timer = setInterval(() => {
			const s = engine.gameState;
			if (s.sceneIndex >= 1 && s.pendingReport) {
				clearInterval(timer);
				resolve();
			}
		}, 300);
		setTimeout(() => {
			clearInterval(timer);
			resolve();
		}, 15 * 60_000);
	});

	console.log("\n—— 试跑结束，工作区保留在 try-workspace/ 供查看 ——");
	process.exit(0);
}

main().catch((err) => {
	console.error("试跑失败:", err?.message ?? err);
	process.exit(1);
});

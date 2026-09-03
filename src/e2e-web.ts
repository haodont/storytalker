// Web 模式无头自测：起真实 HTTP 服务（mock LLM），走 HTTP 接口跑完一整局
//   npm run e2e:web

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager, startWebServer, type WebHub } from "./web/server.js";

// 每次运行用独立临时工作区：上轮残留不会污染本轮，清理失败也不会阻断本轮
const WORKSPACE = await fs.mkdtemp(path.join(tmpdir(), "storytalker-e2e-"));
const PORT = 34771;
const TOKEN = "test-token";
const base = `http://127.0.0.1:${PORT}`;

async function main(): Promise<void> {
	const sessions = new SessionManager(WORKSPACE, TOKEN, true);
	const hub = await sessions.get("main");
	await startWebServer(sessions, PORT);

	const results: string[] = [];
	const check = (name: string, ok: boolean) => {
		results.push(`${ok ? "✓" : "✗"} ${name}`);
		return ok;
	};

	// 1) 页面可达
	const page = await fetch(`${base}/`);
	check("阅读页 200", page.status === 200 && (await page.text()).includes("互动小说"));

	// 2) 无 token 401
	const anon = await fetch(`${base}/api/state`);
	check("无 token 被拒 401", anon.status === 401);

	// 3) 错误 token 401
	const bad = await fetch(`${base}/api/state?token=wrong`);
	check("错误 token 被拒 401", bad.status === 401);

	const auth = (p: string) => `${base}${p}${p.includes("?") ? "&" : "?"}token=${TOKEN}`;

	// 4) 提交灵感 → 灵感对话（idea_chat）→ 构建开局 → confirm_bible
	await (await fetch(auth("/api/input"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "都市夜行人与神秘来客（web e2e）" }) })).json();
	await waitFor(() => phaseOf(hub) === "idea_chat");
	check("灵感阶段进入 idea_chat", phaseOf(hub) === "idea_chat");
	await waitFor(() => {
		const evs = (hub.getLog() as { type: string }[]).filter((e) => e.type === "idea_done");
		return evs.length > 0;
	});
	check("导播灵感回复已产出", true);
	await (await fetch(auth("/api/input"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "构建" }) })).json();
	await waitFor(() => phaseOf(hub) === "confirm_bible", 60_000);
	check("构建指令触发开局设计（confirm_bible）", phaseOf(hub) === "confirm_bible");

	// 4.5) 存档 / 分叉（从开局设计阶段分叉，验证分支继承进度）
	await (await fetch(auth("/api/command"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd: "save:web-slot" }) })).json();
	const saves = (await (await fetch(auth("/api/saves"))).json()) as { name: string }[];
	check("存档位列表含新存档", saves.some((s) => s.name === "web-slot"));
	const forkRes = (await (await fetch(auth("/api/command"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd: "fork:fork-e2e" }) })).json()) as { ok: boolean; message?: string };
	check("分叉新会话", forkRes.ok === true);
	const sess = (await (await fetch(auth("/api/sessions"))).json()) as string[];
	check("会话列表含分支", sess.includes("fork-e2e"));
	const worlds = (await (await fetch(auth("/api/worlds"))).json()) as { id: string; title: string; phase: string }[];
	check("世界列表含 main 与分支", worlds.some((w) => w.id === "main") && worlds.some((w) => w.id === "fork-e2e" && w.phase === "confirm_bible"));
	const forkSaves = (await (await fetch(auth("/api/saves") + "&session=fork-e2e")).json()) as { name: string; parent: string | null }[];
	check("存档列表带谱系字段", Array.isArray(forkSaves) && forkSaves.every((s) => typeof s.name === "string" && (s.parent === null || typeof s.parent === "string")));
	const forkState = (await (await fetch(auth("/api/state") + "&session=fork-e2e")).json()) as { state: { phase: string; sceneIndex: number } };
	check("分支继承进度", forkState.state.phase === "confirm_bible");
	const evilFork = await fetch(auth("/api/command"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd: "fork:../evil" }) });
	check("非法分支名被拒", evilFork.status === 200 && !((await evilFork.json()) as { ok: boolean }).ok);

	// 5) 自动模式 + 确认开局 → 跑完全局
	await (await fetch(auth("/api/command"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd: "mode:auto" }) })).json();
	await (await fetch(auth("/api/command"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd: "accept" }) })).json();
	await waitFor(() => phaseOf(hub) === "ended", 120_000);
	check("故事跑完（ended）", phaseOf(hub) === "ended");

	// 6) 事件流断言
	const events = (await (await fetch(auth("/api/events.json"))).json()) as { type: string; text?: string }[];
	const types = events.map((e) => e.type);
	check("SSE 事件含 scene_done ×20（两弧）", types.filter((t) => t === "scene_done").length === 20);
	check("SSE 事件含 choices", types.includes("choices"));
	check("SSE 事件含 boot_ready", types.includes("boot_ready"));
	// 流式增量应已被合并：全文日志里 scene_delta 条数应远小于逐字数量，
	// 且首条 scene_delta 已合并成大段文本（否则开局事件会被 delta 刷出重放窗口）
	const deltas = events.filter((e) => e.type === "scene_delta") as { text?: string }[];
	check("日志 delta 已合并（条数受控）", deltas.length > 0 && deltas.length < 60);
	check("日志 delta 合并后含整段正文", deltas.some((d) => (d.text ?? "").length > 200));

	// 7) 白名单文件接口
	const outline = (await (await fetch(auth("/api/file") + `&path=${encodeURIComponent("大纲/弧-01.md")}`)).json()) as { content?: string };
	check("查看弧大纲", typeof outline.content === "string" && outline.content.includes("第一弧"));
	const evil = await fetch(auth("/api/file") + `&path=${encodeURIComponent("../.env")}`);
	check("路径白名单拦截", evil.status === 403);

	// 8) SSE 长连接握手（收到重放数据）
	const sseOk = await new Promise<boolean>((resolve) => {
		const ctrl = new AbortController();
		const timer = setTimeout(() => { ctrl.abort(); resolve(false); }, 5000);
		fetch(auth("/api/events"), { signal: ctrl.signal }).then(async (r) => {
			const reader = r.body!.getReader();
			const { value } = await reader.read();
			clearTimeout(timer); ctrl.abort();
			resolve(new TextDecoder().decode(value).includes("retry:"));
		}).catch(() => { clearTimeout(timer); resolve(false); });
	});
	check("SSE 握手与重放", sseOk);

	// 9) 开局模板多轮对话入口
	//    回归防线：Web 端曾因 phase 死锁完全无法进入该流程——handleInput 只在 phase 已是
	//    premise_chat 时才调 chatPremise，而 premise_chat 只能由 chatPremise 自身设置。
	const newWorld = (await (await fetch(auth("/api/worlds"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "premise-e2e" }) })).json()) as { ok: boolean; message?: string };
	check("新建空白世界", newWorld.ok === true);
	const preCmd = (await (await fetch(auth("/api/command") + "&session=premise-e2e", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd: "premise" }) })).json()) as { ok: boolean; message?: string };
	check("premise 命令可进入模板阶段", preCmd.ok === true);
	const preState = (await (await fetch(auth("/api/state") + "&session=premise-e2e")).json()) as { state: { phase: string } };
	check("模板阶段 phase=premise_chat", preState.state.phase === "premise_chat");
	await (await fetch(auth("/api/input") + "&session=premise-e2e", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "赛博朋克" }) })).json();
	const preLog = (await (await fetch(auth("/api/events.json") + "&session=premise-e2e")).json()) as { type: string; text?: string }[];
	check("模板回答推进到下一字段", preLog.some((e) => e.type === "idea_done" && /\[2\/\d+\]/.test(e.text ?? "")));
	// 非开局阶段须明确报错，不能静默无动作（引擎对越阶段调用是 return，反馈只能在此层补）
	const preLate = (await (await fetch(auth("/api/command"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd: "premise" }) })).json()) as { ok: boolean; message?: string };
	check("非开局阶段拒绝 premise 且给出原因", preLate.ok === false && !!preLate.message);

	console.log("\n—— Web E2E 断言 ——");
	let failed = 0;
	for (const line of results) {
		console.log("  " + line);
		if (line.startsWith("✗")) failed++;
	}
	console.log(`\n结果：${failed === 0 ? "全部通过 ✓" : `${failed} 项失败 ✗`}`);
	await fs.rm(WORKSPACE, { recursive: true, force: true });
	try {
		await fs.rm(WORKSPACE, { recursive: true, force: true });
		await fs.rm(WORKSPACE + "-sessions", { recursive: true, force: true });
	} catch {
		// 清理失败（如安全策略拦截批量删除）不影响结果判定：下次运行会用新的临时目录
	}
	process.exit(failed === 0 ? 0 : 1);
}

function phaseOf(hub: WebHub): string {
	return hub.getState().phase;
}

async function waitFor(cond: () => boolean, timeout = 20_000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error("等待超时");
		await new Promise((r) => setTimeout(r, 150));
	}
}

main().catch((err) => {
	console.error("Web E2E 失败:", err);
	process.exit(1);
});

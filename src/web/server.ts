import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Engine, type EngineEvent } from "../engine/engine.js";
import { Store } from "../facts/store.js";
import type { Llm } from "../llm.js";

// ---------------------------------------------------------------------------
// Web 服务：零依赖（node:http）。单玩家个人服务器。
//   GET  /                阅读页
//   GET  /api/events      SSE 实时事件流（连接即重放最近事件）
//   GET  /api/events.json 完整事件日志（供测试/调试）
//   GET  /api/state       引擎状态快照
//   POST /api/input       玩家输入（灵感/反馈/选择/插话，按当前阶段路由）
//   POST /api/command     命令：accept / mode:auto|manual / save:名 / restart
//   GET  /api/file?path=  白名单文件查看（大纲/世界观/伏笔台账）
// 鉴权：WEB_TOKEN 环境变量；未设置则启动时随机生成并打印。SSE 走 ?token=，其余走 Bearer。
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_LOG = 600;
const FILE_WHITELIST = ["大纲/总纲.md", "大纲/弧-01.md", "设定/世界观.md", "设定/规则.md", "设定/经济.md", "设定/属性.json", "记忆/伏笔台账.json", "记忆/弧摘要.md", "记忆/账本.jsonl", "记忆/判定日志.jsonl"];

/** 会话 id 合法字符（用作目录名，防路径逃逸） */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * 会话管理：main 会话用基础工作区，其余会话在 <工作区>-sessions/<id>（与主工作区平级，
 * 放内部会让 fork 变成"复制到自己内部"）。分叉 = 复制整个工作区目录（文件即事实源，
 * 目录即平行宇宙）+ 可选读入某存档为当前进度。
 */
export class SessionManager {
	private sessions = new Map<string, WebHub>();
	private booting = new Map<string, Promise<WebHub>>();
	private readonly sessionsRoot: string;

	constructor(
		private readonly baseRoot: string,
		private readonly token: string,
		private readonly llm: Llm,
	) {
		const abs = path.resolve(baseRoot);
		this.sessionsRoot = path.join(path.dirname(abs), path.basename(abs) + "-sessions");
	}

	sessionRoot(id: string): string {
		return id === "main" ? this.baseRoot : path.join(this.sessionsRoot, id);
	}

	/** 获取会话（首次创建时等待进度恢复完成，避免与后续输入竞争状态） */
	async get(id: string): Promise<WebHub> {
		const existing = this.booting.get(id);
		if (existing) return existing;
		const hub = new WebHub(new Engine(new Store(this.sessionRoot(id)), this.llm, () => {}), this.token);
		this.sessions.set(id, hub);
		const booting = hub.boot().then(() => hub);
		this.booting.set(id, booting);
		return booting;
	}

	list(): string[] {
		const out = ["main"];
		try {
			for (const name of readdirSync(this.sessionsRoot)) {
				if (SESSION_ID_RE.test(name) && !out.includes(name)) out.push(name);
			}
		} catch {
			// sessions 目录不存在
		}
		return out;
	}

	/** 从 from 会话分叉出 newId；saveName 非空时把该存档设为分支的当前进度 */
	async fork(fromId: string, newId: string, saveName: string | null): Promise<{ ok: boolean; message?: string }> {
		if (!SESSION_ID_RE.test(newId)) return { ok: false, message: "分支名只能含字母数字_-，长度 ≤32" };
		if (newId === "main") return { ok: false, message: "分支名不能是 main" };
		const srcRoot = this.sessionRoot(fromId);
		const dstRoot = this.sessionRoot(newId);
		if (this.booting.has(newId) || this.sessions.has(newId) || existsSync(dstRoot)) {
			return { ok: false, message: `分支「${newId}」已存在` };
		}
		const srcHub = await this.get(fromId);
		await cp(srcRoot, dstRoot, { recursive: true });
		if (saveName) {
			const save = await srcHub.engine.store.readJson<unknown>(`存档/${saveName}.json`);
			if (!save) return { ok: false, message: `存档「${saveName}」不存在` };
			await new Store(dstRoot).writeJson("存档/current.json", save);
		}
		await this.get(newId);
		return { ok: true, message: `已创建分支「${newId}」` };
	}
}

export class WebHub {
	/** 事件日志：连接重放用 */
	private log: EngineEvent[] = [];
	private clients = new Set<ServerResponse>();

	constructor(
		readonly engine: Engine,
		readonly token: string,
	) {
		// 引擎事件 → 日志 + 广播
		const inner = engine.emit.bind(engine);
		engine.emit = (ev: EngineEvent) => {
			inner(ev);
			this.logPush(ev);
			this.broadcast(ev);
		};
	}

	/**
	 * 事件入日志：连续同类流式 delta（正文/灵感/过程思考）合并进上一条，
	 * 避免 600 条日志被逐字 delta 刷爆、刷新重放时丢掉开局卡等早期事件。
	 * 广播仍是逐字实时，不受影响。
	 */
	private logPush(ev: EngineEvent): void {
		const streamKey = (e: EngineEvent | undefined): string | null => {
			if (!e) return null;
			if (e.type === "scene_delta" || e.type === "idea_delta") return e.type;
			if (e.type === "agent_process" && e.kind === "delta") return `agent_process:${e.role}`;
			return null;
		};
		const last = this.log[this.log.length - 1];
		if (streamKey(ev) && streamKey(ev) === streamKey(last)) {
			(last as { text: string }).text += (ev as { text: string }).text;
		} else {
			this.log.push(streamKey(ev) ? { ...ev } : ev);
		}
		if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
	}

	getLog(): readonly EngineEvent[] {
		return this.log;
	}

	getState(): Engine["gameState"] {
		return this.engine.gameState;
	}

	async boot(): Promise<void> {
		await this.engine.boot();
	}

	private broadcast(ev: EngineEvent): void {
		const payload = `data: ${JSON.stringify(ev)}\n\n`;
		for (const res of this.clients) {
			res.write(payload);
		}
	}

	handleSse(res: ServerResponse): void {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		res.write(`retry: 3000\n\n`);
		for (const ev of this.log) {
			res.write(`data: ${JSON.stringify(ev)}\n\n`);
		}
		this.clients.add(res);
		const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
		res.on("close", () => {
			clearInterval(ping);
			this.clients.delete(res);
		});
	}

	async handleInput(body: { text?: string }): Promise<{ ok: boolean; message?: string }> {
		const text = (body.text ?? "").trim();
		if (!text) return { ok: false, message: "输入为空" };
		const s = this.engine.gameState;
		if (s.phase === "empty" || s.phase === "idea_chat") {
			// 「构建：…」= 结束酝酿直接开工；其余输入都是灵感对话
			const buildMatch = text.match(/^构建[:：]?\s*(.*)$/s);
			if (buildMatch) {
				void this.engine.buildFromIdea(buildMatch[1]).catch(() => {});
			} else {
				void this.engine.chatIdea(text).catch(() => {});
			}
			return { ok: true };
		}
		if (s.phase === "confirm_bible") {
			void this.engine.confirmBible(text).catch(() => {});
			return { ok: true };
		}
		if (s.phase === "playing") {
			// 「大纲：…」= 玩家意见 → 导播修订弧大纲（优先于选择/插话路由）
			const outlineMatch = text.match(/^大纲[:：]\s*(.+)$/s);
			if (outlineMatch && outlineMatch[1]) {
				void this.engine.reviseArc(outlineMatch[1].trim()).catch(() => {});
				return { ok: true };
			}
		}
		if (s.phase === "playing" && s.pendingReport) {
			void this.engine.resolveChoice(text).catch(() => {});
			return { ok: true };
		}
		this.engine.steer(text);
		return { ok: true };
	}

	async handleCommand(body: { cmd?: string }): Promise<{ ok: boolean; message?: string }> {
		const raw = body.cmd ?? "";
		// outline:意见 —— 意见文本可含冒号，需按前缀整体截取而非 split
		if (raw.startsWith("outline:")) {
			const feedback = raw.slice("outline:".length).trim();
			if (!feedback) return { ok: false, message: "outline 需要修改意见" };
			await this.engine.reviseArc(feedback);
			return { ok: true };
		}
		const [name, arg] = raw.split(":");
		switch (name) {
			case "accept":
				await this.engine.confirmBible();
				return { ok: true };
			case "build":
				await this.engine.buildFromIdea();
				return { ok: true };
			case "load":
				await this.engine.load(arg || "");
				return { ok: true };
			case "mode":
				if (arg === "auto" || arg === "manual") {
					await this.engine.setMode(arg);
					return { ok: true };
				}
				return { ok: false, message: "mode 需要 auto|manual" };
			case "save":
				await this.engine.save(arg || "slot");
				return { ok: true };
			case "restart":
				await this.engine.restart();
				return { ok: true };
			default:
				return { ok: false, message: `未知命令 ${name}` };
		}
	}
}

export function startWebServer(sessions: SessionManager, port: number): Promise<void> {
	const server = createServer((req, res) => {
		void route(sessions, req, res);
	});
	return new Promise((resolve) => {
		server.listen(port, "0.0.0.0", () => {
			console.log(`Web 服务已启动: http://0.0.0.0:${port}/`);
			resolve();
		});
	});
}

async function route(sessions: SessionManager, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const pathname = url.pathname;

	// 静态页与 token 校验：页面本身放行（token 由前端引导输入），API 一律校验
	if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
		return serveStatic(res, path.join(__dirname, "index.html"), "text/html; charset=utf-8");
	}
	if (req.method === "GET" && pathname === "/app.js") {
		return serveStatic(res, path.join(__dirname, "app.js"), "text/javascript; charset=utf-8");
	}
	if (req.method === "GET" && pathname === "/components.js") {
		return serveStatic(res, path.join(__dirname, "components.js"), "text/javascript; charset=utf-8");
	}
	// 前端开源库（marked / DOMPurify / highlight.js / dayjs / confetti，本地 vendored，不依赖 CDN）
	if (req.method === "GET" && pathname.startsWith("/vendor/")) {
		const file = path.normalize(path.join(__dirname, pathname));
		if (!file.startsWith(path.join(__dirname, "vendor") + path.sep)) return json(res, 403, { ok: false, message: "forbidden" });
		const type = file.endsWith(".css")
			? "text/css; charset=utf-8"
			: file.endsWith(".woff2")
				? "font/woff2"
				: "text/javascript; charset=utf-8";
		return serveStatic(res, file, type);
	}
	// 霞鹜文楷屏幕版字体（开源，按需加载 woff2 子集）
	if (req.method === "GET" && pathname.startsWith("/fonts/")) {
		const file = path.normalize(path.join(__dirname, pathname));
		if (!file.startsWith(path.join(__dirname, "fonts") + path.sep)) return json(res, 403, { ok: false, message: "forbidden" });
		const type = file.endsWith(".css") ? "text/css; charset=utf-8" : file.endsWith(".woff2") ? "font/woff2" : "application/octet-stream";
		return serveStatic(res, file, type);
	}

	const token = url.searchParams.get("token") ?? bearerOf(req);
	if (token !== (await sessions.get("main")).token) {
		return json(res, 401, { ok: false, message: "token 无效" });
	}

	// 会话路由：?session=（默认 main；非法 id 落回 main）
	const sessionId = url.searchParams.get("session") ?? "main";
	const hub = SESSION_ID_RE.test(sessionId) ? await sessions.get(sessionId) : await sessions.get("main");

	if (req.method === "GET" && pathname === "/api/events") {
		return hub.handleSse(res);
	}
	if (req.method === "GET" && pathname === "/api/events.json") {
		return json(res, 200, hub.getLog());
	}
	if (req.method === "GET" && pathname === "/api/state") {
		return json(res, 200, { state: hub.getState(), session: sessionId });
	}
	if (req.method === "GET" && pathname === "/api/saves") {
		return json(res, 200, await hub.engine.listSaves());
	}
	if (req.method === "GET" && pathname === "/api/sessions") {
		return json(res, 200, sessions.list());
	}
	if (req.method === "POST" && pathname === "/api/input") {
		return json(res, 200, await hub.handleInput(await readJson(req)));
	}
	if (req.method === "POST" && pathname === "/api/command") {
		const body = await readJson(req);
		const [name, arg, arg2] = String(body.cmd ?? "").split(":");
		if (name === "fork") {
			return json(res, 200, await sessions.fork(sessionId, arg || `fork-${Date.now() % 100000}`, arg2 || null));
		}
		return json(res, 200, await hub.handleCommand(body));
	}
	if (req.method === "GET" && pathname === "/api/file") {
		const rel = url.searchParams.get("path") ?? "";
		if (!FILE_WHITELIST.includes(rel)) return json(res, 403, { ok: false, message: "path 不在白名单" });
		return json(res, 200, { ok: true, content: await hub.engine.store.readText(rel) });
	}
	return json(res, 404, { ok: false, message: "not found" });
}

function bearerOf(req: IncomingMessage): string | null {
	const h = req.headers.authorization;
	return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
	} catch {
		return {};
	}
}

function json(res: ServerResponse, code: number, body: unknown): void {
	res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

function serveStatic(res: ServerResponse, file: string, type: string): void {
	if (!existsSync(file)) {
		res.writeHead(404).end("not found");
		return;
	}
	res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
	createReadStream(file).pipe(res);
}

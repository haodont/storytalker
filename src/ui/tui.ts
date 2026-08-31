import { Editor, ProcessTerminal, Text, TuiMainScreen, type TUI } from "@earendil-works/pi-tui";
import type { Engine, EngineEvent } from "../engine/engine.js";

// ---------------------------------------------------------------------------
// 终端界面：TuiMainScreen（正文进入终端回滚缓冲，像聊天记录一样滚动阅读）
// 上：状态条（阶段/模式/进度）  中：场景正文流式渲染  下：输入框
// ---------------------------------------------------------------------------

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const editorTheme = {
	borderColor: cyan,
	selectList: {
		selectedPrefix: (t: string) => cyan(t),
		selectedText: (t: string) => bold(t),
		description: dim,
		scrollInfo: dim,
		noMatch: dim,
	},
};

const HELP = `命令：
  /accept            确认开局设计，开始故事
  /build [补充要求]   结束灵感酝酿，正式构建开局
  /mode auto|manual  切换 自动挂机 / 手动选择
  /save <名字>        存档
  /restart           放弃当前故事重新开始
  /outline           查看当前弧大纲
  /bible             查看角色档案
  /quit              退出
灵感酝酿阶段直接打字 = 和导播聊灵感；写作进行中打字 = 给执笔插话（steer）；出现候选走向时输入序号或自由描述你的走向。`;

export function startTui(engine: Engine): { tui: TUI; requestRender: () => void } {
	const terminal = new ProcessTerminal();
	const tui = new TuiMainScreen(terminal);

	const statusText = new Text(dim("启动中……"), 1, 0);
	tui.addChild(statusText);
	tui.addChild(new Text(dim("─".repeat(40)), 1, 0));

	let streamingBlock: Text | null = null;
	let streamBuffer = "";
	let lastStatus = "";

	function newBlock(content = ""): Text {
		const block = new Text(content, 1, 0);
		tui.addChild(block);
		return block;
	}

	function renderStatus(): void {
		const s = engine.gameState;
		const phaseName: Record<string, string> = {
			empty: "等待灵感",
			idea_chat: "灵感酝酿",
			bootstrapping: "导播设计中",
			confirm_bible: "开局待确认",
			playing: `第 ${s.sceneIndex + 1} 场`,
			arc_boundary: "弧收束中",
			ended: "已完结",
		};
		const titleLine = `${bold(s.title || "未命名故事")} ｜ ${phaseName[s.phase] ?? s.phase} ｜ 模式：${s.mode === "auto" ? "自动" : "手动"}（/mode 切换）`;
		statusText.setText(lastStatus ? `${titleLine}\n${dim("● " + lastStatus)}` : titleLine);
		tui.requestRender();
	}

	function handleEvent(ev: EngineEvent): void {
		switch (ev.type) {
			case "phase":
				renderStatus();
				break;
			case "status":
				lastStatus = ev.text;
				renderStatus();
				break;
			case "scene_delta":
				if (!streamingBlock) {
					streamingBlock = newBlock();
					streamBuffer = "";
				}
				streamBuffer += ev.text;
				streamingBlock.setText(streamBuffer + " ▌");
				tui.requestRender();
				break;
			case "idea_user":
				newBlock(`你：${ev.text}`);
				break;
			case "idea_done":
				newBlock(cyan(`顾问：${ev.text}\n`) + dim("继续聊，或 /build 构建开局。\n"));
				break;
			case "scene_done":
				if (streamingBlock) {
					streamingBlock.setText(ev.text);
					streamingBlock = null;
					streamBuffer = "";
				} else {
					newBlock(ev.text);
				}
				newBlock(dim(`\n——— 第 ${ev.scene} 场完 ———\n`));
				renderStatus();
				break;
			case "review":
				if (!ev.pass) {
					newBlock(dim(`【校对】发现 ${ev.issues.length} 处疑义（按终稿呈现，遗留问题带入下一场推演）：`));
					for (const issue of ev.issues.slice(0, 3)) {
						newBlock(dim(`  · 「${issue.quote.slice(0, 40)}…」→ ${issue.problem}`));
					}
				}
				break;
			case "boot_ready": {
				newBlock(
					`${bold("《" + ev.title + "》")}\n\n${ev.premise}\n\n${bold("角色：")}\n${ev.characters.map((c) => `  · ${c}`).join("\n")}\n\n${bold(`第一弧「${ev.arcTitle}」目标：`)}${ev.arcGoal}\n\n${bold("开场拍：")}${ev.openingBeat}\n`,
				);
				renderStatus();
				break;
			}
			case "choices": {
				const lines = ev.choices.map((c, i) => `  [${i + 1}] ${bold(c.label)} —— ${c.description}${c.preview ? `\n       ${dim("预演：" + c.preview)}` : ""}`).join("\n");
				const rec = ev.recommended ? dim(`（自动模式将选 ${ev.recommended}）`) : "";
				newBlock(`\n${bold("接下来——")}${rec}\n${lines}\n\n${dim("输入序号，或直接描述你想要的走向：")}\n`);
				break;
			}
			case "arc_boundary":
				newBlock(dim(ev.summary));
				break;
			case "ended":
				newBlock(bold("\n【本篇完】感谢阅读。/restart 可开启新故事。\n"));
				renderStatus();
				break;
			case "error":
				newBlock(`\x1b[31m✗ ${ev.message}\x1b[0m\n`);
				break;
		}
	}

	const editor = new Editor(tui, editorTheme, { paddingX: 1 });
	editor.onSubmit = (input: string) => {
		const text = input.trim();
		if (!text) return;
		void handleInput(text);
	};
	tui.addChild(editor);
	tui.setFocus(editor);

	async function handleInput(text: string): Promise<void> {
		if (text.startsWith("/")) {
			const [cmd, ...rest] = text.split(/\s+/);
			const arg = rest.join(" ").trim();
			switch (cmd) {
				case "/help":
					newBlock(dim(HELP));
					break;
				case "/accept":
					await engine.confirmBible();
					break;
				case "/build":
					await engine.buildFromIdea(arg || undefined);
					break;
				case "/mode":
					if (arg === "auto" || arg === "manual") void engine.setMode(arg);
					else newBlock(dim("用法：/mode auto 或 /mode manual"));
					break;
				case "/save":
					await engine.save(arg || "slot");
					break;
				case "/restart":
					await engine.restart();
					break;
				case "/outline":
				case "/bible": {
					const rel = cmd === "/outline" ? "大纲/弧-01.md" : "设定/世界观.md";
					const content = await engine.store.readText(rel);
					newBlock(content ?? dim(`（尚未生成：${rel}）`));
					break;
				}
				case "/quit":
					tui.stop();
					process.exit(0);
					break;
				default:
					newBlock(dim(`未知命令 ${cmd}。/help 查看命令。`));
			}
			tui.requestRender();
			return;
		}
		const phase = engine.gameState.phase;
		if (phase === "empty" || phase === "idea_chat") {
			const buildMatch = text.match(/^构建[:：]?\s*(.*)$/s);
			if (buildMatch) {
				await engine.buildFromIdea(buildMatch[1] || undefined);
			} else {
				await engine.chatIdea(text);
			}
		} else if (phase === "confirm_bible") {
			await engine.confirmBible(text);
		} else if (phase === "playing" && engine.gameState.pendingReport) {
			await engine.resolveChoice(text);
		} else {
			engine.steer(text);
		}
		tui.requestRender();
	}

	// 引擎事件 → UI（engine.emit 是同步回调）
	const originalEmit = engine.emit.bind(engine);
	engine.emit = (ev: EngineEvent) => {
		originalEmit(ev);
		handleEvent(ev);
	};

	tui.start();
	renderStatus();
	newBlock(dim(HELP) + "\n");
	return { tui, requestRender: () => tui.requestRender() };
}

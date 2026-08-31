import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { ROLE_MODELS, type RoleName } from "../config.js";
import type { Llm } from "../llm.js";

export interface RunAgentOptions {
	role: RoleName;
	llm: Llm;
	system: string;
	tools: AgentTool[];
	prompt: string;
	/** 正文流式回调（Writer 用） */
	onDelta?: (text: string) => void;
	/** 过程回调：思考文本增量与工具调用（Web 过程面板用） */
	onProcess?: (kind: "delta" | "tool", text: string) => void;
	/** agent 实例就绪后回调（TUI 用于中途 steer 插话 / abort） */
	onStart?: (control: { steer: (text: string) => void; abort: () => void }) => void;
}

export interface RunAgentResult {
	/** 最后一条 assistant 消息的纯文本 */
	text: string;
	/** 本次运行消耗的 token（粗计） */
	tokens: { input: number; output: number };
}

/**
 * 一次性的角色调用：每轮用全新 transcript（上下文由引擎确定性组装，
 * 不依赖 agent 对话历史累积），工具通过 collector 回传结构化产物。
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
	const model = opts.llm.model(opts.role);
	const agent = new Agent({
		streamFn: (m, context, options) => opts.llm.streamFn(m, context, options),
		initialState: {
			systemPrompt: opts.system,
			model,
			tools: opts.tools,
			messages: [],
			thinkingLevel: ROLE_MODELS[opts.role].temperature > 0.8 ? "low" : "off",
		},
	});

	let lastTextLength = 0;
	let lastText = "";
	const usage = { input: 0, output: 0 };
	const seenToolCalls = new Set<string>();

	agent.subscribe((event) => {
		if (event.type === "message_update" && event.message.role === "assistant") {
			const current = event.message.content
				.filter((b) => b.type === "text")
				.map((b) => (b.type === "text" ? b.text : ""))
				.join("");
			if (current.length > lastTextLength) {
				const delta = current.slice(lastTextLength);
				if (opts.onDelta) opts.onDelta(delta);
				if (opts.onProcess) opts.onProcess("delta", delta);
			}
			lastTextLength = current.length;
			lastText = current;
			if (opts.onProcess) {
				for (const b of event.message.content) {
					if (b.type === "toolCall" && !seenToolCalls.has(b.id)) {
						seenToolCalls.add(b.id);
						const args = JSON.stringify(b.arguments ?? {});
						opts.onProcess("tool", `${b.name} ${args.length > 90 ? args.slice(0, 90) + "…" : args}`);
					}
				}
			}
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const u = event.message.usage;
			if (u) {
				usage.input += u.input;
				usage.output += u.output;
			}
		}
	});

	opts.onStart?.({
		steer: (text) => agent.steer({ role: "user", content: text, timestamp: Date.now() }),
		abort: () => agent.abort(),
	});

	await agent.prompt(opts.prompt);

	// 取最后一条 assistant 消息的文本（mock/工具调用场景下 lastText 可能为空）
	const messages = agent.state.messages;
	let finalStop: string | undefined;
	let finalErr: string | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role: string; content: { type: string; text?: string }[]; stopReason?: string; errorMessage?: string };
		if (m.role === "assistant") {
			const t = m.content
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("");
			if (t.trim()) lastText = t;
			finalStop = m.stopReason;
			finalErr = m.errorMessage;
			break;
		}
	}

	// 流式调用被超时/重试耗尽/不可用中止时，底层只回传 stopReason="error" 的最终消息，
	// Agent 不会抛错。此处主动抛出明确错误，使引擎的 void(p) 能捕获并 emit error 事件，
	// 避免整章在“无响应”下静默产出残缺内容。
	if (finalStop === "aborted") {
		throw new Error(`LLM 调用被中止：${finalErr ?? "请求在流式过程中被取消"}`);
	}
	if (finalStop === "error") {
		throw new Error(`LLM 调用失败：${finalErr ?? "未知错误（流式返回 error 终止）"}`);
	}

	return { text: lastText, tokens: usage };
}

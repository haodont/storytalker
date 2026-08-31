import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type Api,
	type SimpleStreamOptions,
	type StreamFunction,
} from "@earendil-works/pi-ai";

/** 与 Agent 约定一致的流式函数签名（模型 / 上下文 / 选项 → 事件流） */
export type StreamFn = StreamFunction<Api, SimpleStreamOptions>;

// ---------------------------------------------------------------------------
// 超时与重试配置
// ---------------------------------------------------------------------------

export interface ResilienceConfig {
	/** 首字节超时：发起请求后多久必须收到第一个事件（覆盖网络挂起） */
	firstByteMs: number;
	/** 整体超时：单次调用（含流式输出）最长允许耗时 */
	overallMs: number;
	/** 最大重试次数（不含首次），429 / 5xx / 网络错误触发 */
	maxRetries: number;
	/** 退避间隔（指数），长度应 ≥ maxRetries；默认 1s → 4s → 15s */
	backoffMs: number[];
}

export const DEFAULT_RESILIENCE: ResilienceConfig = {
	firstByteMs: 30_000,
	overallMs: 300_000,
	maxRetries: 3,
	backoffMs: [1_000, 4_000, 15_000],
};

// ---------------------------------------------------------------------------
// 明确错误类型：供上层区分「超时」与「重试耗尽」
// ---------------------------------------------------------------------------

export class LlmTimeoutError extends Error {
	constructor(
		public readonly phase: "firstByte" | "overall",
		public readonly modelId: string,
		public readonly provider: string,
		public readonly limitMs: number,
	) {
		const label = phase === "firstByte" ? "首字节" : "整体";
		super(
			`LLM 流式调用超时（${label}）：模型 ${modelId}（${provider}）在 ${limitMs}ms 内未响应，已主动中断请求以避免整章卡死。`,
		);
		this.name = "LlmTimeoutError";
	}
}

export class LlmRetryExhaustedError extends Error {
	constructor(
		public readonly modelId: string,
		public readonly attempts: number,
		public readonly lastMessage: string,
	) {
		super(`LLM 调用失败：模型 ${modelId} 已重试 ${attempts} 次仍不可用。最后一次错误：${lastMessage}`);
		this.name = "LlmRetryExhaustedError";
	}
}

// ---------------------------------------------------------------------------
// 重试判定：429 / 5xx / 网络错误可重试；超时优先（由调用方提前中止，不在此判定）
// ---------------------------------------------------------------------------

const NETWORK_HINT = /(fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network error|network_error|connection reset|connection refused|getaddrinfo|timed out)/i;

function isRetryable(errorMessage: string | undefined, status: number | undefined): boolean {
	if (typeof status === "number" && (status === 429 || (status >= 500 && status < 600))) return true;
	const m = errorMessage ?? "";
	if (/\b429\b/.test(m)) return true;
	if (/\b5\d{2}\b/.test(m)) return true; // 500–599
	if (NETWORK_HINT.test(m)) return true;
	return false;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 合并外部（Agent 用户中止）信号与本控制器信号：任一中止即触发本控制器中止 */
function linkAbort(controller: AbortController, parent?: AbortSignal): AbortSignal {
	if (!parent) return controller.signal;
	if (parent.aborted) controller.abort(parent.reason);
	else parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
	return controller.signal;
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function errorAssistantMessage(model: Model<Api>, err: unknown): AssistantMessage {
	const message = err instanceof Error ? err.message : String(err);
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}

/** 用户主动中止时构造的消息（stopReason 与 pi-ai 约定一致，便于 Agent 识别） */
function abortedAssistantMessage(model: Model<Api>, err: unknown): AssistantMessage {
	const message = err instanceof Error ? err.message : String(err);
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "aborted",
		errorMessage: message,
		timestamp: Date.now(),
	};
}

/** 内部控制：单次尝试可重试 */
class RetryableFail extends Error {
	constructor(public readonly lastMsg: string) {
		super("retryable");
	}
}

// ---------------------------------------------------------------------------
// 包装器：为在线模型的每次流式调用叠加两级超时 + 指数退避重试
//
// 行为要点：
// - 本地模型（provider === "local"）直连透传：本地推理不存在网络挂起，不加超时/重试。
// - 超时优先：任一级超时立即中止请求并抛出 LlmTimeoutError（不进入重试）。
// - 单次尝试内边收边缓冲；仅当整次尝试成功才向下游 flush，避免重试时重复吐字。
// - 429 / 5xx / 网络错误按 backoffMs 退避重试；耗尽后抛出 LlmRetryExhaustedError。
// - 用户中止（外部 signal）不被当作失败，原样向下游传递 aborted 事件。
// - 即便内部流因信号中止而永不产出事件（真·网络挂起），外层计时器仍会触发并中断。
// ---------------------------------------------------------------------------

export function withResilience(inner: StreamFn, config?: Partial<ResilienceConfig>): StreamFn {
	const cfg: ResilienceConfig = { ...DEFAULT_RESILIENCE, ...config };

	return (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		// 本地模型：无网络挂起风险，透传。超时逻辑按模型类型区分即体现在此处。
		if (model.provider === "local") {
			return inner(model, context, options);
		}

		const outer = createAssistantMessageEventStream();
		let outerEnded = false;
		const endOuter = (msg: AssistantMessage) => {
			outerEnded = true;
			outer.end(msg);
		};

		type AttemptResult = { kind: "retry"; lastMsg: string } | { kind: "stop" };

		const attemptOnce = async (): Promise<AttemptResult> => {
			let timedOut: false | "firstByte" | "overall" = false;
			let lastStatus: number | undefined;
			const ctrl = new AbortController();
			const signal = linkAbort(ctrl, options?.signal);
			const onResponse = (resp: { status: number; headers: Record<string, string> }, m: Model<Api>) => {
				lastStatus = resp.status;
				options?.onResponse?.(resp, m);
			};

			const firstByteTimer = setTimeout(() => {
				timedOut = "firstByte";
				ctrl.abort();
			}, cfg.firstByteMs);
			const overallTimer = setTimeout(() => {
				timedOut = "overall";
				ctrl.abort();
			}, cfg.overallMs);
			const clearTimers = () => {
				clearTimeout(firstByteTimer);
				clearTimeout(overallTimer);
			};

			const buffer: AssistantMessageEvent[] = [];
			let gotFirstByte = false;
			const userAbortedNow = () => !!options?.signal?.aborted;

			/** 终结本次调用：向下游推送 error 事件并结束流（供 timeout / 用户中止 / 不可重试错误） */
			const terminal = (msg: AssistantMessage, reason: "error" | "aborted"): AttemptResult => {
				clearTimers();
				outer.push({ type: "error", reason, error: msg });
				endOuter(msg);
				return { kind: "stop" };
			};
			const timeoutOut = (phase: "firstByte" | "overall"): AttemptResult =>
				terminal(
					errorAssistantMessage(model, new LlmTimeoutError(phase, model.id, model.provider, phase === "firstByte" ? cfg.firstByteMs : cfg.overallMs)),
					"error",
				);

			try {
				const innerStream = inner(model, context, { ...options, signal, onResponse });
				// 将「信号中止」转为可捕获的拒绝，确保即便内部流永不产出事件也能触发超时
				const abortP = new Promise<never>((_, rej) =>
					ctrl.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")), { once: true }),
				);
				await Promise.race([
					(async () => {
						for await (const ev of innerStream) {
							if (!gotFirstByte) {
								gotFirstByte = true;
								clearTimeout(firstByteTimer); // 收到首字节，取消首字节计时
							}
							if (ev.type === "done") {
								clearTimers();
								for (const b of buffer) outer.push(b);
								outer.push(ev);
								endOuter(ev.message);
								return;
							}
							if (ev.type === "error") {
								if (timedOut) return timeoutOut(timedOut);
								if (userAbortedNow() && ev.reason === "aborted") return terminal(ev.error, "aborted");
								if (isRetryable(ev.error.errorMessage, lastStatus)) {
									clearTimers();
									buffer.length = 0; // 丢弃本失败尝试的缓冲，避免重复吐字
									throw new RetryableFail(ev.error.errorMessage ?? "unknown error");
								}
								return terminal(ev.error, "error");
							}
							// 普通增量事件：先缓冲，整次成功后再 flush
							buffer.push(ev);
						}
						// 内部流异常结束（无 done/error）：当作本次尝试失败
						throw new RetryableFail("流在收到完成事件前结束");
					})(),
					abortP,
				]);
				// 成功分支已在循环内 endOuter 并 return；到此处即为成功收尾
				return { kind: "stop" };
			} catch (err) {
				if (timedOut) return timeoutOut(timedOut);
				if (userAbortedNow()) return terminal(abortedAssistantMessage(model, err instanceof Error ? err : new Error(String(err))), "aborted");
				if (err instanceof RetryableFail) {
					clearTimers();
					return { kind: "retry", lastMsg: err.lastMsg };
				}
				const msg = err instanceof Error ? err.message : String(err);
				if (isRetryable(msg, lastStatus)) {
					clearTimers();
					return { kind: "retry", lastMsg: msg };
				}
				clearTimers();
				return terminal(errorAssistantMessage(model, new Error(msg)), "error");
			}
		};

		const run = async (): Promise<void> => {
			const maxAttempts = cfg.maxRetries + 1;
			let lastErrMsg = "";
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				const r = await attemptOnce();
				if (r.kind === "stop") return; // 成功 / 超时 / 用户中止 / 不可重试错误：均已结束
				lastErrMsg = r.lastMsg; // 可重试失败
				if (attempt < maxAttempts) {
					await sleep(cfg.backoffMs[attempt - 1] ?? cfg.backoffMs[cfg.backoffMs.length - 1] ?? 1000);
					continue;
				}
				// 已达最大尝试次数仍失败 → 明确抛出重试耗尽错误
				const m = errorAssistantMessage(model, new LlmRetryExhaustedError(model.id, cfg.maxRetries, lastErrMsg));
				outer.push({ type: "error", reason: "error", error: m });
				endOuter(m);
				return;
			}
		};

		run().catch((err) => {
			if (outerEnded) return;
			const m = errorAssistantMessage(model, err);
			outer.push({ type: "error", reason: "error", error: m });
			outer.end(m);
		});

		return outer;
	};
}

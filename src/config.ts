import "dotenv/config";

/** LLM 来源：sensenova（商汤云）| local（llama.cpp llama-server，OpenAI 兼容） */
export type ProviderKind = "sensenova" | "local";
export const LLM_PROVIDER: ProviderKind = (process.env.LLM_PROVIDER as ProviderKind) ?? "sensenova";

/** 商汤 SenseNova OpenAI 兼容模式接入参数 */
export const SENSENOVA = {
	providerId: "sensenova",
	baseUrl: "https://api.sensenova.cn/compatible-mode/v2",
	apiKey: process.env.SENSENOVA_API_KEY ?? "",
};

/** 本地 llama.cpp llama-server 参数（LLM_PROVIDER=local 时生效） */
export const LOCAL_LLM = {
	providerId: "local",
	baseUrl: process.env.LOCAL_BASE_URL ?? "http://127.0.0.1:8137/v1",
	modelId: process.env.LOCAL_MODEL_ID ?? "qwen3.5-9b",
	contextWindow: Number(process.env.LOCAL_CONTEXT ?? 16384),
	maxTokens: 4096,
};

export type RoleName = "director" | "writer" | "reviewer";

/** 各角色使用的模型与采样参数（按需调整；local 模式下所有角色共用本地模型） */
export const ROLE_MODELS: Record<RoleName, { modelId: string; temperature: number; maxTokens: number }> = {
	director: { modelId: "SenseChat-5", temperature: 0.7, maxTokens: 8192 },
	writer: { modelId: "SenseChat-5", temperature: 0.9, maxTokens: 8192 },
	reviewer: { modelId: "SenseNova-V6.5-Turbo", temperature: 0.2, maxTokens: 4096 },
};

export const ENGINE = {
	/** 每弧场景数（v1 验证用短篇默认 10） */
	scenesPerArc: 10,
	/** 弧数上限：弧边界导播可续弧，达上限强制收束（防无限续写） */
	maxArcs: Number(process.env.NOVEL_MAX_ARCS ?? 3),
	/** Writer 上下文携带的最近场景摘要数 */
	recentSummaries: 3,
	/** 上一场景原文尾部携带的字符数 */
	previousTailChars: 800,
	/** 工作区路径 */
	workspace: process.env.NOVEL_WORKSPACE ?? "novel-workspace",
};

export function requireApiKey(): string {
	if (!SENSENOVA.apiKey) {
		console.error("缺少 SENSENOVA_API_KEY：请复制 .env.example 为 .env 并填入商汤 API Key。");
		process.exit(1);
	}
	return SENSENOVA.apiKey;
}

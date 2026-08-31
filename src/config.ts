import "dotenv/config";
import type { LlmSettings, LlmProvider, RoleOverride } from "./facts/types.js";

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

/** 各服务商的默认接入参数（设置界面切换服务商时预填） */
export const PROVIDER_DEFAULTS: Record<LlmProvider, { baseUrl: string; modelId: string; needsKey: boolean }> = {
	sensenova: { baseUrl: SENSENOVA.baseUrl, modelId: "SenseChat-5", needsKey: true },
	openai: { baseUrl: "https://api.openai.com/v1", modelId: "gpt-4o-mini", needsKey: true },
	local: { baseUrl: LOCAL_LLM.baseUrl, modelId: LOCAL_LLM.modelId, needsKey: false },
};

/** 由环境变量推导的默认 LLM 配置（LLM_PROVIDER 决定） */
export function defaultLlmSettings(): LlmSettings {
	if (LLM_PROVIDER === "local") {
		return { provider: "local", baseUrl: LOCAL_LLM.baseUrl, apiKey: "", modelId: LOCAL_LLM.modelId };
	}
	return { provider: "sensenova", baseUrl: SENSENOVA.baseUrl, apiKey: SENSENOVA.apiKey, modelId: ROLE_MODELS.director.modelId };
}

/** 单角色覆盖归一化：非法温度/空模型名直接丢弃该字段（回退全局），不报错 */
function normalizeRoleOverride(o: unknown): RoleOverride | undefined {
	if (!o || typeof o !== "object") return undefined;
	const src = o as { modelId?: unknown; temperature?: unknown };
	const out: RoleOverride = {};
	if (typeof src.modelId === "string" && src.modelId.trim()) out.modelId = src.modelId.trim();
	if (typeof src.temperature === "number" && Number.isFinite(src.temperature) && src.temperature >= 0 && src.temperature <= 2) {
		out.temperature = src.temperature;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** 合并持久化片段与默认值，保证 llm 字段完整（缺字段用提供商默认补齐） */
export function normalizeLlm(p: Partial<LlmSettings> | undefined): LlmSettings {
	const def = defaultLlmSettings();
	const provider: LlmProvider =
		p?.provider === "local" || p?.provider === "openai" || p?.provider === "sensenova" ? p.provider : def.provider;
	const d = PROVIDER_DEFAULTS[provider]!;
	// 角色覆盖：任何角色字段不合法即整体丢弃（存档兼容：宁回退勿报错）
	let roles: LlmSettings["roles"];
	if (p?.roles && typeof p.roles === "object") {
		const src = p.roles as Record<string, unknown>;
		for (const r of ["director", "writer", "reviewer"] as const) {
			const o = normalizeRoleOverride(src[r]);
			if (o) (roles ??= {})[r] = o;
		}
	}
	return {
		provider,
		baseUrl: (p?.baseUrl ?? "").trim() || d.baseUrl,
		apiKey: p?.apiKey ?? def.apiKey,
		modelId: (p?.modelId ?? "").trim() || d.modelId,
		...(roles ? { roles } : {}),
	};
}

/** 校验服务商配置；返回错误信息（null=通过） */
export function validateLlm(l: LlmSettings): string | null {
	if (l.provider !== "sensenova" && l.provider !== "local" && l.provider !== "openai") {
		return "服务商必须是 sensenova / local / openai";
	}
	if (!l.baseUrl?.trim()) return "Base URL 不能为空";
	if (!l.modelId?.trim()) return "模型名不能为空";
	if (l.provider !== "local" && !l.apiKey?.trim()) return "该服务商需要 API Key（可留空回退到环境变量）";
	for (const r of ["director", "writer", "reviewer"] as const) {
		const t = l.roles?.[r]?.temperature;
		if (t !== undefined && (t < 0 || t > 2)) return `${r} 的温度须在 0-2 之间`;
		if (l.roles?.[r]?.modelId !== undefined && !l.roles[r]!.modelId) return `${r} 的覆盖模型名不能为空`;
	}
	return null;
}

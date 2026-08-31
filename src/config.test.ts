// LLM 配置归一化与校验的回归测试（纯函数、零 I/O）
// 覆盖 src/config.ts 的 normalizeLlm / validateLlm —— 设置界面保存前的唯一防线，
// 出错会让非法配置直接落到 设置.json 并在运行时才炸。

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLlm, validateLlm, PROVIDER_DEFAULTS } from "./config.js";
import type { LlmSettings } from "./facts/types.js";

const OPENAI: LlmSettings = {
	provider: "openai",
	baseUrl: "https://api.example.com/v1",
	apiKey: "test-key",
	modelId: "gpt-4o-mini",
};

// -- normalizeLlm：缺字段补齐 ------------------------------------------------

test("normalizeLlm: 空输入补齐成完整配置", () => {
	const out = normalizeLlm(undefined);
	assert.ok(["sensenova", "openai", "local"].includes(out.provider));
	assert.ok(out.baseUrl.length > 0, "baseUrl 不得为空");
	assert.ok(out.modelId.length > 0, "modelId 不得为空");
	assert.equal(typeof out.apiKey, "string");
});

test("normalizeLlm: baseUrl 全空白时回退服务商默认值", () => {
	const out = normalizeLlm({ ...OPENAI, baseUrl: "   " });
	assert.equal(out.baseUrl, PROVIDER_DEFAULTS.openai.baseUrl);
});

test("normalizeLlm: modelId 留空时回退服务商默认值", () => {
	const out = normalizeLlm({ ...OPENAI, modelId: "" });
	assert.equal(out.modelId, PROVIDER_DEFAULTS.openai.modelId);
});

test("normalizeLlm: 非法 provider 回退到默认 provider", () => {
	const out = normalizeLlm({ ...OPENAI, provider: "bogus" as LlmSettings["provider"] });
	assert.ok(["sensenova", "openai", "local"].includes(out.provider));
});

test("normalizeLlm: 显式空 apiKey 被保留（区分「未设置」与「主动清空」）", () => {
	assert.equal(normalizeLlm({ ...OPENAI, apiKey: "" }).apiKey, "");
});

test("normalizeLlm: baseUrl 两端空白被裁剪", () => {
	const out = normalizeLlm({ ...OPENAI, baseUrl: "  https://api.example.com/v1  " });
	assert.equal(out.baseUrl, "https://api.example.com/v1");
});

// -- validateLlm：保存前拦截 --------------------------------------------------

test("validateLlm: 合法的 OpenAI 兼容配置通过", () => {
	assert.equal(validateLlm(OPENAI), null);
});

test("validateLlm: local 服务商允许无 apiKey", () => {
	const out = validateLlm({ provider: "local", baseUrl: "http://127.0.0.1:8137/v1", apiKey: "", modelId: "qwen3.5-9b" });
	assert.equal(out, null);
});

test("validateLlm: 非 local 服务商缺 apiKey 被拒", () => {
	assert.match(validateLlm({ ...OPENAI, apiKey: "  " }) ?? "", /API Key/);
});

test("validateLlm: baseUrl 或 modelId 为空被拒", () => {
	assert.match(validateLlm({ ...OPENAI, baseUrl: " " }) ?? "", /Base URL/);
	assert.match(validateLlm({ ...OPENAI, modelId: " " }) ?? "", /模型名/);
});

test("validateLlm: 非法 provider 被拒", () => {
	assert.match(validateLlm({ ...OPENAI, provider: "bogus" as LlmSettings["provider"] }) ?? "", /服务商/);
});

// -- roles 角色覆盖：归一化与校验（P2-2） --------------------------------------

test("normalizeLlm: 合法角色覆盖保留", () => {
	const out = normalizeLlm({ ...OPENAI, roles: { writer: { modelId: "deepseek-r1", temperature: 1.2 } } });
	assert.equal(out.roles?.writer?.modelId, "deepseek-r1");
	assert.equal(out.roles?.writer?.temperature, 1.2);
});

test("normalizeLlm: 无 roles 输入时输出不含 roles 字段（缺省=回退全局）", () => {
	const out = normalizeLlm({ ...OPENAI });
	assert.equal(out.roles, undefined);
});

test("normalizeLlm: 非法温度丢弃对应字段", () => {
	const out = normalizeLlm({ ...OPENAI, roles: { writer: { temperature: 9.9 }, reviewer: { temperature: -1 } } });
	assert.equal(out.roles?.writer?.temperature, undefined);
	assert.equal(out.roles?.reviewer, undefined);
});

test("normalizeLlm: 空白模型名与垃圾输入整体丢弃", () => {
	const out = normalizeLlm({
		...OPENAI,
		roles: { director: { modelId: "   " }, writer: "垃圾" as unknown as { modelId?: string }, reviewer: null as unknown as { modelId?: string } },
	});
	assert.equal(out.roles, undefined);
});

test("normalizeLlm: 旧存档无 roles 字段可正常归一化（存档兼容）", () => {
	const legacy = { provider: "openai", baseUrl: "https://x/v1", apiKey: "k", modelId: "m" } as LlmSettings;
	const out = normalizeLlm(legacy);
	assert.equal(out.modelId, "m");
	assert.equal(out.roles, undefined);
});

test("validateLlm: 温度越界被拒；合法覆盖通过", () => {
	assert.match(
		validateLlm({ ...OPENAI, roles: { writer: { temperature: 2.5 } } }) ?? "",
		/温度/,
	);
	assert.equal(validateLlm({ ...OPENAI, roles: { writer: { temperature: 2, modelId: "m2" } } }), null);
});

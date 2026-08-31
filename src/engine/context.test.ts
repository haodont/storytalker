// 上下文 CAP 动态化单测：按模型 contextWindow 缩放各层上限。
import { test } from "node:test";
import assert from "node:assert/strict";
import { capsFor } from "./context.js";

const KEYS = ["masterOutline", "arcSummary", "recentSummaries", "sceneTail", "characterCard", "foreshadows", "economy", "choices"] as const;

test("capsFor：16k 基准与历史硬编码值完全一致（行为等价）", () => {
	const c = capsFor(16384);
	assert.equal(c.masterOutline, 1200);
	assert.equal(c.arcSummary, 1200);
	assert.equal(c.recentSummaries, 1400);
	assert.equal(c.sceneTail, 800);
	assert.equal(c.characterCard, 600);
	assert.equal(c.foreshadows, 500);
	assert.equal(c.economy, 500);
	assert.equal(c.choices, 240);
});

test("capsFor：128k 放大 8 倍但被夹在 4 倍上限", () => {
	const c = capsFor(131072);
	assert.equal(c.masterOutline, 4800); // 1200 * 4
	assert.equal(c.recentSummaries, 5600); // 1400 * 4
});

test("capsFor：4k 缩小但被夹在 0.5 倍下限", () => {
	const c = capsFor(4096); // scale=0.25 → 夹到 0.5
	assert.equal(c.masterOutline, 600);
	assert.equal(c.characterCard, 300);
});

test("capsFor：8k 恰好半程缩放", () => {
	const c = capsFor(8192);
	assert.equal(c.masterOutline, 600); // 1200 * 0.5
	assert.equal(c.foreshadows, 250);
});

test("capsFor：总量不超过窗口的 60%（防溢出；仅校验缩放区间内窗口）", () => {
	for (const win of [16384, 32768, 131072]) {
		const c = capsFor(win);
		// 估算单次 writer 上下文峰值：所有层上限之和
		const total = KEYS.reduce((a, k) => a + c[k], 0);
		assert.ok(total <= win * 0.6, `win=${win} total=${total}`);
	}
	// 小窗口被 0.5 下限夹住（保底可用上下文），只断言不高于基准
	assert.ok(KEYS.reduce((a, k) => a + capsFor(4096)[k], 0) <= KEYS.reduce((a, k) => a + capsFor(16384)[k], 0));
});

test("capsFor：非法输入回退 16k 基准", () => {
	for (const bad of [0, -1, Number.NaN]) {
		assert.equal(capsFor(bad).masterOutline, 1200);
	}
});

// 场景报告门禁的回归测试（纯函数、零 I/O）
// sanitizeReport 是「LLM 幻觉落盘前」的最后一道确定性闸门：它失效的后果是
// 未登记角色/实体被凭空写入存档、金额写成天文数字、选项重复或超量。

import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeReport } from "./settle.js";
import type { SceneReport } from "../facts/types.js";

const TX_MAX_ABS = 1_000_000;
const SUMMARY_MAX = 400;

function report(over: Partial<SceneReport> = {}): SceneReport {
	return {
		title: "场景1",
		summary: "摘要",
		characterUpdates: [],
		foreshadowOps: [],
		choices: [{ label: "A", description: "甲" }],
		...over,
	};
}

// -- 幻觉拦截 ---------------------------------------------------------------

test("sanitizeReport: 未登记角色的状态补丁被丢弃", () => {
	const { report: out, warnings } = sanitizeReport(
		report({
			characterUpdates: [
				{ name: "张三", patch: { location: "客栈" } },
				{ name: "凭空出现的路人", patch: { location: "街角" } },
			],
		}),
		["张三"],
	);
	assert.equal(out.characterUpdates.length, 1);
	assert.equal(out.characterUpdates[0]?.name, "张三");
	assert.ok(warnings.some((w) => w.includes("凭空出现的路人")));
});

test("sanitizeReport: 未注册实体的补丁被丢弃", () => {
	const { report: out, warnings } = sanitizeReport(
		report({ entityUpdates: [{ name: "未注册组织", patch: { 势力: 5 } }] }),
		[],
		["青云门"],
	);
	assert.equal(out.entityUpdates?.length, 0);
	assert.ok(warnings.some((w) => w.includes("未注册组织")));
});

test("sanitizeReport: 空补丁的实体也被丢弃（补丁为空等同于无意义写入）", () => {
	const { report: out } = sanitizeReport(report({ entityUpdates: [{ name: "青云门", patch: {} }] }), [], ["青云门"]);
	assert.equal(out.entityUpdates?.length, 0);
});

// -- 金额钳制 ---------------------------------------------------------------

test("sanitizeReport: 超阈值金额被钳制到 ±1e6 并告警", () => {
	const { report: out, warnings } = sanitizeReport(
		report({ transactions: [{ name: "张三", change: 5_000_000, reason: "卖了一根油条" }] }),
		["张三"],
	);
	assert.equal(out.transactions?.[0]?.change, TX_MAX_ABS);
	assert.ok(warnings.some((w) => w.includes("钳制")));
});

test("sanitizeReport: 负数超阈值钳制到 -1e6（保留方向）", () => {
	const { report: out } = sanitizeReport(
		report({ transactions: [{ name: "张三", change: -9_999_999, reason: "赔款" }] }),
		["张三"],
	);
	assert.equal(out.transactions?.[0]?.change, -TX_MAX_ABS);
});

test("sanitizeReport: 非有限金额（NaN/Infinity）被静默丢弃", () => {
	const { report: out } = sanitizeReport(
		report({
			transactions: [
				{ name: "张三", change: Number.NaN, reason: "坏数据" },
				{ name: "张三", change: Number.POSITIVE_INFINITY, reason: "坏数据" },
				{ name: "张三", change: 10, reason: "正常" },
			],
		}),
		["张三"],
	);
	assert.equal(out.transactions?.length, 1);
	assert.equal(out.transactions?.[0]?.change, 10);
});

test("sanitizeReport: 未登记角色的流水被整笔忽略", () => {
	const { report: out, warnings } = sanitizeReport(
		report({ transactions: [{ name: "路人甲", change: 100, reason: "打赏" }] }),
		["张三"],
	);
	assert.equal(out.transactions?.length, 0);
	assert.ok(warnings.some((w) => w.includes("路人甲")));
});

// -- 选项与摘要 -------------------------------------------------------------

test("sanitizeReport: 选项去重、弃空、最多保留 4 个", () => {
	const { report: out } = sanitizeReport(
		report({
			choices: [
				{ label: "A", description: "1" },
				{ label: "A", description: "重复" },
				{ label: "  ", description: "空标签" },
				{ label: "B", description: "2" },
				{ label: "C", description: "3" },
				{ label: "D", description: "4" },
				{ label: "E", description: "5" },
			],
		}),
		[],
	);
	assert.deepEqual(
		out.choices.map((c) => c.label),
		["A", "B", "C", "D"],
	);
});

test("sanitizeReport: 推荐项被钳制进 [1, 选项数]", () => {
	const up = sanitizeReport(report({ recommendedChoice: 99 }), []).report;
	const down = sanitizeReport(report({ recommendedChoice: -5 }), []).report;
	// 只有 1 个选项时上界为 1
	assert.equal(up.recommendedChoice, 1);
	assert.equal(down.recommendedChoice, 1);
});

test("sanitizeReport: 摘要超长被截断到 400 字", () => {
	const { report: out } = sanitizeReport(report({ summary: "字".repeat(1000) }), []);
	assert.equal(out.summary.length, SUMMARY_MAX);
});

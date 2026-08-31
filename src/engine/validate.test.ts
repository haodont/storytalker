// 确定性校验层单测：复读检测 / 大纲门禁 / 设计校验 / 设计修复。
// 这些是"幻觉落盘前"的最后一道代码护栏，用例聚焦边界值与非法值。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	detectRepetitionLoop,
	designIssues,
	outlineCastNote,
	outlineGateHard,
	outlineGateNotes,
	sanitizeDesign,
} from "./validate.js";
import type { StoryDesign } from "../facts/types.js";

function design(overrides: Partial<StoryDesign> = {}): StoryDesign {
	return {
		title: "测试之书",
		premise: "一个普通人的故事",
		worldRules: "规则文本",
		economy: { currency: "两银", overview: "概述文本" },
		attributes: ["力量", "智力", "体质", "魅力"],
		characters: [
			{ name: "甲", basics: "主角", initialState: {} },
			{ name: "乙", basics: "对手", initialState: {} },
		],
		arc: { title: "第一弧", goal: "活下来" },
		openingBeat: "开场拍文本",
		...overrides,
	};
}

test("detectRepetitionLoop：正常文本不报", () => {
	assert.deepEqual(detectRepetitionLoop("这是一段完全正常、没有复读的中文文本，叙事持续推进，情节不断向前发展。"), []);
});

test("detectRepetitionLoop：同块重复 ≥4 次报问题", () => {
	const block = "他站在原地一动不动，目光空洞地望着前方，久久没有说出一个字。"; // ≥24 字
	const draft = block.repeat(4);
	const issues = detectRepetitionLoop(draft);
	assert.equal(issues.length, 1);
	assert.ok(issues[0]!.problem.includes("重复出现"));
});

test("detectRepetitionLoop：过短文本直接跳过", () => {
	assert.deepEqual(detectRepetitionLoop("短"), []);
});

test("outlineGateHard：79 字打回、80 字通过、601 字打回", () => {
	const s79 = "字".repeat(79);
	const s80 = "字".repeat(80);
	const s601 = "字".repeat(601);
	assert.equal(outlineGateHard(s79).length, 1);
	assert.deepEqual(outlineGateHard(s80), []);
	assert.deepEqual(outlineGateHard("字".repeat(600)), []);
	assert.equal(outlineGateHard(s601).length, 1);
});

test("outlineGateNotes：大纲呼应读者选择时不告警，脱节时告警", () => {
	const choice = "跟随商人前往码头";
	const echoing = "主角决定跟随商人前往码头，途中遭遇伏击……";
	assert.deepEqual(outlineGateNotes(echoing, choice), []);
	const disjoint = "主角留在城中调查账本，发现线索指向当铺。";
	assert.equal(outlineGateNotes(disjoint, choice).length, 1);
	assert.deepEqual(outlineGateNotes(disjoint, null), []); // 无上轮选择不告警
});

test("outlineCastNote：有已登记角色出场才返回提示", () => {
	assert.equal(outlineCastNote("路人与主角擦肩", ["沈青梧"]), null);
	assert.ok(outlineCastNote("沈青梧出现在码头", ["沈青梧", "顾长风"])!.includes("沈青梧"));
	assert.equal(outlineCastNote("单字名不入列", ["甲"]), null); // 单字名（<2 字）跳过
});

test("designIssues：完整设计零问题", () => {
	assert.deepEqual(designIssues(design()), []);
});

test("designIssues：空字段逐项报硬伤", () => {
	const issues = designIssues(
		design({
			title: " ",
			premise: "",
			worldRules: "",
			economy: { currency: "", overview: "" },
			characters: [{ name: "甲", basics: "", initialState: {} }],
			attributes: ["力量"],
			arc: { title: "", goal: "" },
			openingBeat: "",
		}),
	);
	assert.ok(issues.length >= 9);
	assert.ok(issues.some((i) => i.includes("书名")));
	assert.ok(issues.some((i) => i.includes("少于 2")));
});

test("designIssues：属性表越界（3 条 / 9 条）报错", () => {
	assert.ok(designIssues(design({ attributes: ["力", "智", "体"] })).some((i) => i.includes("4-8")));
	assert.ok(designIssues(design({ attributes: ["一", "二", "三", "四", "五", "六", "七", "八", "九"] })).some((i) => i.includes("4-8")));
});

test("sanitizeDesign：超 8 条属性截断并告警", () => {
	const d = design({ attributes: ["一", "二", "三", "四", "五", "六", "七", "八", "九"] });
	const r = sanitizeDesign(d);
	assert.equal(r.design.attributes.length, 8);
	assert.ok(r.warnings.some((w) => w.includes("截断")));
});

test("sanitizeDesign：stats 键对齐属性表，越界值钳制 1-18，缺省 10", () => {
	const d = design({
		characters: [
			{ name: "甲", basics: "", initialState: { stats: { 力量: 25, 神秘: 7 } } },
			{ name: "乙", basics: "", initialState: {} },
		],
	});
	const r = sanitizeDesign(d);
	const stats = r.design.characters[0]!.initialState.stats!;
	assert.equal(stats["力量"], 18); // 钳制
	assert.equal(stats["智力"], 10); // 对齐属性表补默认
	assert.ok(!("神秘" in stats)); // 非法键丢弃
	assert.ok(r.warnings.some((w) => w.includes("甲") && w.includes("神秘")));
});

test("sanitizeDesign：空属性表原样保留 characters、attributes 置空数组", () => {
	const d = design({ attributes: [] });
	const r = sanitizeDesign(d);
	assert.deepEqual(r.design.attributes, []);
	assert.equal(r.design.characters.length, 2);
	assert.deepEqual(r.warnings, []);
});

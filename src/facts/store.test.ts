// Store 单元测试：原子写/JSON 往返/角色卡钳制/BM25 检索/JSONL 容错。
// 全部走 os.tmpdir() 临时工作区，零 I/O 副作用泄漏。
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "./store.js";
import type { CharacterCard, DiceCheck, LedgerEntry } from "./types.js";

let seq = 0;

async function tmpStore(): Promise<{ store: Store; dir: string }> {
	const dir = path.join(os.tmpdir(), `st-test-${process.pid}-${Date.now()}-${++seq}`);
	const store = new Store(dir);
	await store.ensureWorkspace();
	return { store, dir };
}

async function cleanup(dir: string): Promise<void> {
	await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

test("writeText/readText 往返并可覆盖", async () => {
	const { store, dir } = await tmpStore();
	try {
		await store.writeText("设定/角色/a.md", "第一版");
		assert.equal(await store.readText("设定/角色/a.md"), "第一版");
		await store.writeText("设定/角色/a.md", "第二版");
		assert.equal(await store.readText("设定/角色/a.md"), "第二版");
	} finally {
		await cleanup(dir);
	}
});

test("readText 不存在返回 null（不抛错）", async () => {
	const { store, dir } = await tmpStore();
	try {
		assert.equal(await store.readText("不存在/文件.md"), null);
	} finally {
		await cleanup(dir);
	}
});

test("writeJson/readJson 往返", async () => {
	const { store, dir } = await tmpStore();
	try {
		const v = { a: 1, list: ["x", "y"], nested: { ok: true } };
		await store.writeJson("存档/current.json", v);
		assert.deepEqual(await store.readJson("存档/current.json"), v);
	} finally {
		await cleanup(dir);
	}
});

test("readJson 损坏内容返回 null（容错，不抛错）", async () => {
	const { store, dir } = await tmpStore();
	try {
		await store.writeText("坏.json", "{ 不是合法 JSON !!!");
		assert.equal(await store.readJson("坏.json"), null);
	} finally {
		await cleanup(dir);
	}
});

test("readJson 不存在返回 null", async () => {
	const { store, dir } = await tmpStore();
	try {
		assert.equal(await store.readJson("无.json"), null);
	} finally {
		await cleanup(dir);
	}
});

test("appendLine 多次追加按序保留", async () => {
	const { store, dir } = await tmpStore();
	try {
		await store.appendLine("记忆/账本.jsonl", "第一行");
		await store.appendLine("记忆/账本.jsonl", "第二行");
		assert.equal(await store.readText("记忆/账本.jsonl"), "第一行\n第二行\n");
	} finally {
		await cleanup(dir);
	}
});

test("listDir 排序返回；目录不存在返回空数组", async () => {
	const { store, dir } = await tmpStore();
	try {
		await store.writeText("章稿/场景-002.md", "b");
		await store.writeText("章稿/场景-001.md", "a");
		assert.deepEqual(await store.listDir("章稿"), ["场景-001.md", "场景-002.md"]);
		assert.deepEqual(await store.listDir("无此目录"), []);
	} finally {
		await cleanup(dir);
	}
});

test("clampStats 越界钳制 1-18、非有限值丢弃、小数取整", () => {
	const out = Store.clampStats({ 力量: 250, 智力: -5, 魅力: 9.6, 幸运: Number.NaN })!;
	assert.equal(out["力量"], 18);
	assert.equal(out["智力"], 1);
	assert.equal(out["魅力"], 10);
	assert.ok(!("幸运" in out));
	assert.equal(Store.clampStats(undefined), undefined);
});

test("saveCharacter 防超模：属性写入前被钳制到 1-18", async () => {
	const { store, dir } = await tmpStore();
	try {
		const card: CharacterCard = {
			name: "主角",
			basics: "一名普通旅人",
			state: { location: "城门", stats: { 力量: 99, 体质: 0.4 } },
		};
		await store.saveCharacter(card);
		const loaded = (await store.loadCharacter("主角"))!;
		assert.ok(loaded);
		assert.equal(loaded.basics, "一名普通旅人");
		assert.equal(loaded.state.stats?.["力量"], 18);
		assert.equal(loaded.state.stats?.["体质"], 1);
	} finally {
		await cleanup(dir);
	}
});

test("loadCharacter 不存在返回 null", async () => {
	const { store, dir } = await tmpStore();
	try {
		assert.equal(await store.loadCharacter("路人甲"), null);
	} finally {
		await cleanup(dir);
	}
});

test("loadCharacter 状态块损坏时回退空状态（{}）", async () => {
	const { store, dir } = await tmpStore();
	try {
		await store.writeText(
			"设定/角色/坏.md",
			"# 坏\n\n## 基础设定\n设定文本\n\n## 当前状态\n<!--STATE-->\n{ 损坏的 JSON\n<!--/STATE-->\n",
		);
		const c = (await store.loadCharacter("坏"))!;
		assert.ok(c);
		assert.deepEqual(c.state, {});
	} finally {
		await cleanup(dir);
	}
});

test("listCharacters 只列 .md 且去掉扩展名", async () => {
	const { store, dir } = await tmpStore();
	try {
		await store.saveCharacter({ name: "甲", basics: "", state: {} });
		await store.saveCharacter({ name: "乙", basics: "", state: {} });
		await store.writeText("设定/角色/杂项.txt", "非角色文件");
		assert.deepEqual((await store.listCharacters()).sort(), ["乙", "甲"].sort());
	} finally {
		await cleanup(dir);
	}
});

test("recentDiceChecks 截断最近 n 条并跳过损坏行", async () => {
	const { store, dir } = await tmpStore();
	try {
		const entries: DiceCheck[] = [
			{ scene: 1, character: "主角", attribute: "力量", dc: 10, roll: 5, mod: 0, total: 5, outcome: "成功", reason: "破门前冲撞" },
			{ scene: 2, character: "主角", attribute: "智力", dc: 12, roll: 15, mod: 0, total: 15, outcome: "失败", reason: "辨认笔迹" },
			{ scene: 3, character: "主角", attribute: "敏捷", dc: 8, roll: 3, mod: 0, total: 3, outcome: "成功", reason: "翻墙" },
		];
		for (const e of entries) await store.appendDiceCheck(e);
		await store.appendLine("记忆/判定日志.jsonl", "这行是坏的");
		const last2 = await store.recentDiceChecks(2);
		assert.equal(last2.length, 2);
		assert.equal(last2[1]?.scene, 3);
	} finally {
		await cleanup(dir);
	}
});

test("appendLedger/loadLedger 往返；空批次不写文件", async () => {
	const { store, dir } = await tmpStore();
	try {
		const e: LedgerEntry = { scene: 1, name: "主角", change: -3, reason: "早点摊买黑面包", balanceAfter: 17 };
		await store.appendLedger([e]);
		assert.deepEqual(await store.loadLedger(), [e]);
		await store.appendLedger([]); // 空批次：无操作不报错
		assert.equal((await store.loadLedger()).length, 1);
	} finally {
		await cleanup(dir);
	}
});

test("search 中文 bigram 命中（无词典依赖）", async () => {
	const { store, dir } = await tmpStore();
	try {
		await store.writeText("章稿/场景-001.md", "夜色渐深，沈青梧推开客栈的木门，檐下灯笼摇晃。");
		await store.writeText("设定/世界观.md", "故事发生在江南水乡，漕运兴盛。");
		const hits = await store.search("客栈");
		assert.ok(hits.length >= 1);
		assert.ok(hits[0]!.file.endsWith("场景-001.md"));
	} finally {
		await cleanup(dir);
	}
});

test("search ASCII 整词与空查询", async () => {
	const { store, dir } = await tmpStore();
	try {
		await store.writeText("设定/世界观.md", "The guild uses silver marks as currency.");
		const hits = await store.search("guild");
		assert.ok(hits.length >= 1);
		assert.deepEqual(await store.search("   "), []); // 空查询
	} finally {
		await cleanup(dir);
	}
});

test("writeText 后检索索引增量更新（新词立即可搜）", async () => {
	const { store, dir } = await tmpStore();
	try {
		await store.writeText("章稿/场景-001.md", "开篇：平静的小镇。");
		assert.deepEqual(await store.search("玄铁剑"), []);
		await store.writeText("章稿/场景-002.md", "他抽出玄铁剑，寒光一闪。");
		const hits = await store.search("玄铁剑");
		assert.ok(hits.length >= 1);
	} finally {
		await cleanup(dir);
	}
});

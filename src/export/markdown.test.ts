// 导出组装单测：MD / HTML 输出结构与转义。
import { test } from "node:test";
import assert from "node:assert/strict";
import { exportMarkdown, exportHtml } from "./markdown.js";

const scenes = [
	{ scene: 1, title: "城门初遇", text: "暮色里，沈青梧推开木门。\n\n风从巷口灌进来。" },
	{ scene: 2, title: "客栈夜话", text: "「你终于来了。」黑暗里有人轻声说。" },
];

test("exportMarkdown：空书返回 null", () => {
	assert.equal(exportMarkdown("书", []), null);
});

test("exportMarkdown：书名 + 分场景标题与正文", () => {
	const md = exportMarkdown("《风起》", scenes)!;
	assert.ok(md.includes("# 《风起》"));
	assert.ok(md.includes("## 城门初遇"));
	assert.ok(md.includes("暮色里，沈青梧推开木门。"));
	assert.ok(md.includes("## 客栈夜话"));
});

test("exportHtml：无场景返回 null，正文按段落包 p 标签", () => {
	assert.equal(exportHtml("书", []), null);
	const html = exportHtml("《风起》", scenes)!;
	assert.ok(html.startsWith("<!DOCTYPE html>"));
	assert.ok(html.includes("<title>《风起》</title>"));
	assert.ok(html.includes("<h2>城门初遇</h2>"));
	assert.ok(html.includes("<p>暮色里，沈青梧推开木门。</p>"));
	assert.ok(html.includes("<p>风从巷口灌进来。</p>"));
});

test("exportHtml：特殊字符转义（防注入）", () => {
	const html = exportHtml("书 <b>", [{ scene: 1, title: "标题 <x>", text: "正文 & \"引号\"" }])!;
	assert.ok(html.includes("书 &lt;b&gt;"));
	assert.ok(html.includes("标题 &lt;x&gt;"));
	assert.ok(html.includes("正文 &amp; &quot;引号&quot;"));
	assert.ok(!html.includes("<x>"));
});

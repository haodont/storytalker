// ---------------------------------------------------------------------------
// 导出（零依赖）：把整本已写故事组装成可带走的格式。
// 只读工作区，不改任何状态；空书返回 null 由调用方提示。
// ---------------------------------------------------------------------------

/** 组装整本 Markdown：书名 → 分弧分场景正文 */
export function exportMarkdown(title: string, scenes: { scene: number; title: string; text: string }[]): string | null {
	if (scenes.length === 0) return null;
	const parts: string[] = [`# ${title || "未命名"}\n`];
	for (const s of scenes) {
		parts.push(`## ${s.title || `场景 ${s.scene}`}\n`);
		parts.push(s.text.trim() + "\n");
	}
	return parts.join("\n");
}

/** 组装整本纯文本（TXT，通用记事本可读；每场景以标题行分隔，正文按自然段换行） */
export function exportTxt(title: string, scenes: { scene: number; title: string; text: string }[]): string | null {
	if (scenes.length === 0) return null;
	const parts: string[] = [title || "未命名", ""];
	for (const s of scenes) {
		parts.push((s.title || `场景 ${s.scene}`) + "\n");
		// 正文内联标题残留（场景文件首行 "场景N：标题" 已由 store 剥离，防御性清理其余标题行）
		const text = s.text
			.replace(/^#+ .*$/gm, "")
			.split(/\n{2,}/)
			.map((p) => p.trim())
			.filter(Boolean)
			.join("\n\n");
		parts.push(text, "");
	}
	return parts.join("\n");
}

/** 组装单文件 HTML（阅读友好，可离线打开；样式内联零外链） */
export function exportHtml(title: string, scenes: { scene: number; title: string; text: string }[]): string | null {
	if (scenes.length === 0) return null;
	const esc = (s: string): string =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	const body = scenes
		.map(
			(s) =>
				`<h2>${esc(s.title || `场景 ${s.scene}`)}</h2>\n` +
				`${s.text
					.split(/\n{2,}/)
					.map((p) => `<p>${esc(p.trim())}</p>`)
					.join("\n")}`,
		)
		.join("\n");
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title || "未命名")}</title>
<style>
  body { max-width: 42em; margin: 2.5em auto; padding: 0 1.2em; font: 17px/1.9 "LXGW WenKai", "PingFang SC", "Microsoft YaHei", serif; color: #2b2b2b; background: #faf8f2; }
  h1 { text-align: center; font-size: 1.9em; margin-bottom: 1.8em; }
  h2 { margin-top: 2.4em; border-bottom: 1px solid #d8d2c2; padding-bottom: .3em; font-size: 1.25em; }
  p { margin: .9em 0; text-indent: 2em; }
</style>
</head>
<body>
<h1>${esc(title || "未命名")}</h1>
${body}
</body>
</html>`;
}

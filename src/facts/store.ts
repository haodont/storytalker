import { promises as fs } from "node:fs";
import path from "node:path";
import type { ArcOutline, CharacterCard, CharacterState, DiceCheck, ForeshadowEntry, LedgerEntry, RuntimeSettings, SceneReport, StoryDesign, WorldEntity } from "./types.js";
import { ENGINE, normalizeLlm } from "../config.js";
import { findEconomyTemplate } from "../economy/templates.js";

// ---------------------------------------------------------------------------
// 工作区布局（文件即唯一事实源）
//
// novel-workspace/
//   设定/世界观.md  设定/规则.md  设定/角色/<名>.md  设定/地点.md
//   大纲/总纲.md    大纲/弧-01.md  大纲/弧-01.json
//   记忆/场景摘要/场景-001.md  记忆/弧摘要.md  记忆/伏笔台账.json  记忆/选择历史.jsonl
//   章稿/场景-001.md
//   存档/current.json  存档/<名>.json
// ---------------------------------------------------------------------------

export class Store {
	constructor(readonly root: string) {}

	// -- 基础原语 -------------------------------------------------------------

	private abs(...parts: string[]): string {
		return path.join(this.root, ...parts);
	}

	async readText(rel: string): Promise<string | null> {
		try {
			return await fs.readFile(this.abs(rel), "utf8");
		} catch {
			return null;
		}
	}

	/** 原子写入：唯一 tmp 名 + rename；Windows 下 rename 覆盖可能被文件占用，
	 *  短暂重试后降级为直接覆盖（保数据落盘，放弃原子性） */
	private tmpSeq = 0;

	async writeText(rel: string, text: string): Promise<void> {
		const target = this.abs(rel);
		await fs.mkdir(path.dirname(target), { recursive: true });
		this.searchCache?.set(rel, text);
		this.reindexFile(rel, text);
		const tmp = `${target}.${process.pid}.${++this.tmpSeq}.tmp`;
		await fs.writeFile(tmp, text, "utf8");
		for (let attempt = 0; ; attempt++) {
			try {
				await fs.rename(tmp, target);
				return;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (attempt < 4 && (code === "EPERM" || code === "EACCES")) {
					await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
					continue;
				}
				if (code === "EPERM" || code === "EACCES") {
					await fs.copyFile(tmp, target);
					await fs.rm(tmp, { force: true });
					return;
				}
				throw err;
			}
		}
	}

	async writeJson(rel: string, value: unknown): Promise<void> {
		await this.writeText(rel, JSON.stringify(value, null, 2));
	}

	async readJson<T>(rel: string): Promise<T | null> {
		const text = await this.readText(rel);
		if (text === null) return null;
		try {
			return JSON.parse(text) as T;
		} catch {
			return null;
		}
	}

	async appendLine(rel: string, line: string): Promise<void> {
		const target = this.abs(rel);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.appendFile(target, line + "\n", "utf8");
	}

	async listDir(rel: string): Promise<string[]> {
		try {
			const entries = await fs.readdir(this.abs(rel));
			return entries.sort();
		} catch {
			return [];
		}
	}

	// -- 工作区初始化 ----------------------------------------------------------

	async ensureWorkspace(): Promise<void> {
		for (const dir of ["设定/角色", "大纲", "记忆/场景摘要", "章稿", "存档"]) {
			await fs.mkdir(this.abs(dir), { recursive: true });
		}
	}

	// -- 设定（Story Bible） ----------------------------------------------------

	private static stateBlock(state: CharacterState): string {
		return `## 当前状态\n<!--STATE-->\n${JSON.stringify(state, null, 2)}\n<!--/STATE-->\n`;
	}

	private static parseState(md: string): CharacterState {
		const m = md.match(/<!--STATE-->\n?([\s\S]*?)\n?<!--\/STATE-->/);
		if (!m?.[1]) return {};
		try {
			return JSON.parse(m[1]) as CharacterState;
		} catch {
			return {};
		}
	}

	async saveCharacter(card: CharacterCard): Promise<void> {
		// 防超模：任何补丁路径写入的属性都钳制在 1-18
		const state: CharacterState = { ...card.state, stats: Store.clampStats(card.state.stats) };
		const md = `# ${card.name}\n\n## 基础设定\n${card.basics}\n\n${Store.stateBlock(state)}`;
		await this.writeText(`设定/角色/${card.name}.md`, md);
	}

	async loadCharacter(name: string): Promise<CharacterCard | null> {
		const md = await this.readText(`设定/角色/${name}.md`);
		if (md === null) return null;
		const basics = md.split(/\n## 基础设定\n/)[1]?.split(/\n## /)[0]?.trim() ?? "";
		return { name, basics, state: Store.parseState(md) };
	}

	async listCharacters(): Promise<string[]> {
		const files = await this.listDir("设定/角色");
		return files.filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
	}

	async loadCharacters(names?: string[]): Promise<CharacterCard[]> {
		const list = names ?? (await this.listCharacters());
		const cards = await Promise.all(list.map((n) => this.loadCharacter(n)));
		return cards.filter((c): c is CharacterCard => c !== null);
	}

	async saveDesignBible(design: StoryDesign): Promise<void> {
		await this.writeText("设定/世界观.md", `# 世界观\n\n## 故事 premise\n${design.premise}\n\n${design.worldRules}\n`);
		await this.writeText("设定/规则.md", `# 世界规则\n\n${design.worldRules}\n`);
		// 经济：模板基准价表（若选用）是代码锚点，进 md 供上下文引用
		const tpl = design.economy.templateId ? findEconomyTemplate(design.economy.templateId) : undefined;
		const priceLines = tpl ? tpl.commodities.map((c) => `- ${c.name}：${c.basePrice}（${c.unit}）`).join("\n") : "";
		const wageLines = tpl ? tpl.wages.map((w) => `- ${w.name}：月 ${w.monthly}`).join("\n") : "";
		await this.writeText(
			"设定/经济.md",
			`# 经济体系\n\n## 计价单位\n${design.economy.currency}\n\n## 概述\n${design.economy.overview}\n` +
				(tpl ? `\n## 物价基准（${tpl.name}；引擎锚点，禁止凭空偏离）\n${priceLines}\n\n## 收入基准\n${wageLines}\n\n## 模板要点\n${tpl.notes}\n` : ""),
		);
		if (tpl) {
			await this.writeJson("设定/经济.json", { templateId: tpl.id, currency: design.economy.currency, commodities: tpl.commodities, wages: tpl.wages });
		}
		// 世界实体：宏观对象注册（设计即固定，状态随剧情演化）
		await this.saveEntities(design.entities ?? []);
		await this.writeJson("设定/属性.json", { attributes: design.attributes });
		await this.writeText("大纲/总纲.md", `# ${design.title}\n\n## 故事梗概\n${design.premise}\n`);
		for (const c of design.characters) {
			await this.saveCharacter({ name: c.name, basics: c.basics, state: { ...c.initialState, stats: Store.clampStats(c.initialState.stats) } });
		}
		await this.writeText("设定/地点.md", "# 地点\n\n（Director 在剧情展开时补充）\n");
		await this.writeJson("设定/开场拍.json", { openingBeat: design.openingBeat });
	}

	/** 属性钳制：任何属性值锁定在 1-18（10 为普通水准），防角色超模 */
	static clampStats(stats?: Record<string, number>): Record<string, number> | undefined {
		if (!stats) return undefined;
		const out: Record<string, number> = {};
		for (const [k, v] of Object.entries(stats)) {
			const n = Math.round(Number(v));
			if (Number.isFinite(n)) out[k] = Math.min(18, Math.max(1, n));
		}
		return out;
	}

	async loadAttributes(): Promise<string[]> {
		const data = await this.readJson<{ attributes?: string[] }>("设定/属性.json");
		return data?.attributes ?? [];
	}

	/** 追加判定流水（JSONL，由引擎掷骰写入） */
	async appendDiceCheck(entry: DiceCheck): Promise<void> {
		await this.appendLine("记忆/判定日志.jsonl", JSON.stringify(entry));
	}

	/** 最近 n 条判定（供校对核对叙述是否服从骰子结果） */
	async recentDiceChecks(n = 5): Promise<DiceCheck[]> {
		const text = await this.readText("记忆/判定日志.jsonl");
		if (!text) return [];
		const out: DiceCheck[] = [];
		for (const line of text.trim().split("\n")) {
			try {
				out.push(JSON.parse(line) as DiceCheck);
			} catch {
				// 忽略损坏行
			}
		}
		return out.slice(-n);
	}

	/** 经济体系文本（上下文组装用） */
	async loadEconomy(): Promise<string | null> {
		return this.readText("设定/经济.md");
	}

	/** 追加账本流水（JSONL，每行一条，由引擎结算写入） */
	async appendLedger(entries: LedgerEntry[]): Promise<void> {
		if (entries.length === 0) return;
		for (const e of entries) {
			await this.appendLine("记忆/账本.jsonl", JSON.stringify(e));
		}
	}

	async loadLedger(): Promise<LedgerEntry[]> {
		const text = await this.readText("记忆/账本.jsonl");
		if (!text) return [];
		const out: LedgerEntry[] = [];
		for (const line of text.trim().split("\n")) {
			try {
				out.push(JSON.parse(line) as LedgerEntry);
			} catch {
				// 忽略损坏行
			}
		}
		return out;
	}

	// -- 大纲 ------------------------------------------------------------------

	private arcJsonPath(n: number): string {
		return `大纲/弧-${String(n).padStart(2, "0")}.json`;
	}

	private arcMdPath(n: number): string {
		return `大纲/弧-${String(n).padStart(2, "0")}.md`;
	}

	async saveArc(index: number, arc: ArcOutline): Promise<void> {
		await this.writeJson(this.arcJsonPath(index), arc);
		await this.writeText(
			this.arcMdPath(index),
			`# ${arc.title}\n\n## 目标\n${arc.goal}\n`,
		);
	}

	async loadArc(index: number): Promise<ArcOutline | null> {
		return this.readJson<ArcOutline>(this.arcJsonPath(index));
	}

	// -- 记忆 ------------------------------------------------------------------

	private sceneNo(n: number): string {
		return String(n).padStart(3, "0");
	}

	async saveSceneText(sceneIndex: number, title: string, text: string): Promise<void> {
		await this.writeText(`章稿/场景-${this.sceneNo(sceneIndex)}.md`, `# 场景${this.sceneNo(sceneIndex)}：${title}\n\n${text}\n`);
	}

	async saveSceneSummary(sceneIndex: number, report: SceneReport): Promise<void> {
		await this.writeText(
			`记忆/场景摘要/场景-${this.sceneNo(sceneIndex)}.md`,
			`# 场景${this.sceneNo(sceneIndex)}：${report.title}\n\n${report.summary}\n`,
		);
	}

	/**
	 * 最近 n 个场景摘要（含场景号），按场景号升序返回。
	 * 闭区间语义：latestScene 是"最后一场已完成场景"的编号，本身必须包含在内——
	 * 写第 N 场时调用方传 sceneIndex=N-1，恰好覆盖 1..N-1 的全部已完成场。
	 */
	async recentSummaries(latestScene: number, n: number): Promise<{ scene: number; title: string; summary: string }[]> {
		const out: { scene: number; title: string; summary: string }[] = [];
		const start = Math.max(1, latestScene - n + 1);
		for (let i = start; i <= latestScene; i++) {
			const md = await this.readText(`记忆/场景摘要/场景-${this.sceneNo(i)}.md`);
			if (md === null) continue;
			const [, title, summary] = md.match(/^# 场景\d+：(.*)\n\n([\s\S]*)$/u) ?? [, `场景${i}`, md];
			out.push({ scene: i, title: title ?? `场景${i}`, summary: (summary ?? "").trim() });
		}
		return out;
	}

	/** 上一场（latestScene 本身）的结尾原文：写第 N 场时 latestScene=N-1 即上一场 */
	async previousSceneTail(latestScene: number, chars: number): Promise<string | null> {
		if (latestScene <= 0) return null;
		const md = await this.readText(`章稿/场景-${this.sceneNo(latestScene)}.md`);
		if (md === null) return null;
		return md.slice(-chars);
	}

	/** 全部已写场景原文（导出用）：按场景号升序，返回去除标题行的正文与标题 */
	async readAllScenes(): Promise<{ scene: number; title: string; text: string }[]> {
		const files = (await this.listDir("章稿")).filter((f) => f.endsWith(".md"));
		const out: { scene: number; title: string; text: string }[] = [];
		for (const f of files) {
			const m = f.match(/^场景-(\d+)\.md$/);
			if (!m) continue;
			const scene = Number(m[1]);
			if (!Number.isInteger(scene) || scene < 1) continue;
			const md = await this.readText(`章稿/${f}`);
			if (md === null) continue;
			const [, title, text] = md.match(/^# 场景\d+：(.*)\n\n([\s\S]*)$/u) ?? [, `场景${scene}`, md];
			out.push({ scene, title: (title ?? `场景${scene}`).trim(), text: (text ?? "").trim() });
		}
		return out.sort((a, b) => a.scene - b.scene);
	}

	async saveArcSummary(text: string): Promise<void> {
		const prev = (await this.readText("记忆/弧摘要.md")) ?? "";
		await this.writeText("记忆/弧摘要.md", prev + text + "\n");
	}

	/** 蒸馏后整体替换弧摘要（记忆蒸馏用） */
	async replaceArcSummary(text: string): Promise<void> {
		await this.writeText("记忆/弧摘要.md", text + "\n");
	}

	// -- 伏笔台账 ---------------------------------------------------------------

	async loadForeshadows(): Promise<ForeshadowEntry[]> {
		return (await this.readJson<ForeshadowEntry[]>("记忆/伏笔台账.json")) ?? [];
	}

	async saveForeshadows(entries: ForeshadowEntry[]): Promise<void> {
		await this.writeJson("记忆/伏笔台账.json", entries);
	}

	// -- 选择历史 ---------------------------------------------------------------

	async appendChoice(sceneIndex: number, choice: string, source: "player" | "auto"): Promise<void> {
		await this.appendLine("记忆/选择历史.jsonl", JSON.stringify({ scene: sceneIndex, choice, source, at: new Date().toISOString() }));
	}

	// -- 运行时设置（工作区级，设置界面读写） --------------------------------------

	private settingsCache: RuntimeSettings | null = null;

	async loadSettings(): Promise<RuntimeSettings> {
		if (this.settingsCache) return this.settingsCache;
		const saved = await this.readJson<Partial<RuntimeSettings>>("设置.json");
		this.settingsCache = {
			scenesPerArc: Math.min(50, Math.max(2, Math.round(Number(saved?.scenesPerArc) || ENGINE.scenesPerArc))),
			maxArcs: Math.min(20, Math.max(1, Math.round(Number(saved?.maxArcs) || ENGINE.maxArcs))),
			webSearch: saved?.webSearch ?? true,
			llm: normalizeLlm(saved?.llm),
		};
		return this.settingsCache;
	}

	async saveSettings(settings: RuntimeSettings): Promise<void> {
		this.settingsCache = settings;
		await this.writeJson("设置.json", settings);
	}

	// -- 世界实体 ---------------------------------------------------------------

	async saveEntities(entities: WorldEntity[]): Promise<void> {
		await this.writeJson("设定/实体.json", entities);
	}

	async loadEntities(): Promise<WorldEntity[]> {
		return (await this.readJson<WorldEntity[]>("设定/实体.json")) ?? [];
	}

	// -- 史料库（联网查证固化的现实知识） -----------------------------------------

	async listHistoryNotes(): Promise<{ file: string; content: string }[]> {
		const files = (await this.listDir("设定")).filter((f) => f.startsWith("史料-") && f.endsWith(".md"));
		const out: { file: string; content: string }[] = [];
		for (const f of files) {
			const content = await this.readText(`设定/${f}`);
			if (content) out.push({ file: `设定/${f}`, content });
		}
		return out;
	}

	// -- 检索（供 search_story 工具使用） ---------------------------------------

	/** 全部 Markdown 内容缓存（writeText 时增量更新），行级命中与索引构建共用 */
	private searchCache: Map<string, string> | null = null;

	private async mdContents(): Promise<Map<string, string>> {
		if (this.searchCache) return this.searchCache;
		const map = new Map<string, string>();
		const walk = async (prefix: string): Promise<void> => {
			for (const entry of await this.listDir(prefix)) {
				const rel = prefix ? `${prefix}/${entry}` : entry;
				if (entry.endsWith(".md")) {
					const content = await this.readText(rel);
					if (content !== null) map.set(rel, content);
				} else if (!entry.includes(".") && entry !== "存档" && entry !== "sessions") {
					await walk(rel);
				}
			}
		};
		await walk("");
		this.searchCache = map;
		return map;
	}

	/** 关键词全文检索：BM25 + 内存倒排索引。
	 *  中文以字符 bigram 为词元（无词典依赖），ASCII 按整词；writeText 时增量更新该文件的词频。 */
	/** file -> 词元 -> 词频 */
	private bm25Tf: Map<string, Map<string, number>> | null = null;
	/** 词元 -> file -> 词频（倒排） */
	private bm25Postings: Map<string, Map<string, number>> = new Map();
	private bm25Lengths: Map<string, number> = new Map();

	private static tokenize(text: string): string[] {
		const tokens: string[] = [];
		for (const w of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) tokens.push(w);
		const cjk = text.replace(/[^\u4e00-\u9fff]/g, "");
		for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk.slice(i, i + 2));
		return tokens;
	}

	private reindexFile(rel: string, content: string | null): void {
		if (this.bm25Tf === null) return; // 索引未构建，构建时会全量扫描
		const old = this.bm25Tf.get(rel);
		if (old) {
			for (const term of old.keys()) {
				const posting = this.bm25Postings.get(term);
				if (posting) {
					posting.delete(rel);
					if (posting.size === 0) this.bm25Postings.delete(term);
				}
			}
			this.bm25Lengths.delete(rel);
		}
		if (content === null) {
			this.bm25Tf.delete(rel);
			return;
		}
		const tf = new Map<string, number>();
		for (const t of Store.tokenize(content)) tf.set(t, (tf.get(t) ?? 0) + 1);
		this.bm25Tf.set(rel, tf);
		this.bm25Lengths.set(rel, tf.size);
		for (const [term, n] of tf) {
			let posting = this.bm25Postings.get(term);
			if (!posting) this.bm25Postings.set(term, (posting = new Map()));
			posting.set(rel, n);
		}
	}

	private async bm25Index(): Promise<NonNullable<Store["bm25Tf"]>> {
		if (this.bm25Tf) return this.bm25Tf;
		this.bm25Tf = new Map();
		for (const [rel, content] of await this.mdContents()) this.reindexFile(rel, content);
		return this.bm25Tf;
	}

	async search(query: string, limit = 12): Promise<{ file: string; line: number; text: string }[]> {
		const queryTerms = query.trim().split(/\s+/).filter(Boolean);
		if (queryTerms.length === 0) return [];
		const docs = await this.bm25Index();
		if (docs.size === 0) return [];

		// BM25 打分（k1=1.5, b=0.75），查询词与文档词元都走同一分词器
		const k1 = 1.5;
		const b = 0.75;
		const N = docs.size;
		const avgLen = [...this.bm25Lengths.values()].reduce((a, x) => a + x, 0) / N || 1;
		const scores = new Map<string, number>();
		for (const qt of queryTerms) {
			for (const term of Store.tokenize(qt)) {
				const posting = this.bm25Postings.get(term);
				if (!posting || posting.size === 0) continue;
				const idf = Math.log(1 + (N - posting.size + 0.5) / (posting.size + 0.5));
				for (const [file, tf] of posting) {
					const len = this.bm25Lengths.get(file) ?? 1;
					const score = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / avgLen)));
					scores.set(file, (scores.get(file) ?? 0) + score);
				}
			}
		}

		// 相关性降序取 Top 文件，再在文件内取命中行（保持既有返回结构）
		const topFiles = [...scores.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 8).map(([f]) => f);
		const contents = await this.mdContents();
		const results: { file: string; line: number; text: string }[] = [];
		for (const rel of topFiles) {
			const lines = (contents.get(rel) ?? "").split("\n");
			for (let i = 0; i < lines.length; i++) {
				const text = lines[i] ?? "";
				if (queryTerms.some((t) => text.includes(t))) {
					results.push({ file: rel, line: i + 1, text: text.trim().slice(0, 200) });
					if (results.length >= limit) return results;
				}
			}
		}
		return results;
	}
}

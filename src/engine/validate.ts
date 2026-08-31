// ---------------------------------------------------------------------------
// 确定性校验与门禁（从 engine.ts 拆出，纯函数、零 import 依赖、零 LLM 调用）。
// 复读检测 / 大纲预检 / 开局设计校验：幻觉在落盘前被代码拦截。
// ---------------------------------------------------------------------------
import type { StoryDesign } from "../facts/types.js";

/** 确定性复读检测：小模型可能陷入 n-gram 循环并耗尽 token 预算。
 *  不花任何 LLM 调用，直接在草稿上查滑动窗口的重复块。 */
export function detectRepetitionLoop(draft: string): { quote: string; constraint: string; problem: string }[] {
	const window = 24; // 连续 24 字为一块
	const minRepeat = 4; // 同一块出现 ≥4 次视为复读
	if (draft.length < window * (minRepeat + 1)) return [];
	const counts = new Map<string, number>();
	for (let i = 0; i + window <= draft.length; i++) {
		const key = draft.slice(i, i + window);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	let worst = "";
	let worstCount = 0;
	for (const [key, count] of counts) {
		if (count > worstCount) {
			worst = key;
			worstCount = count;
		}
	}
	if (worstCount < minRepeat) return [];
	return [
		{
			quote: worst,
			constraint: "文本复读检测",
			problem: `同一片段「${worst.slice(0, 12)}…」在草稿中重复出现 ${worstCount} 次，陷入复读循环；请重写整个场景，推进剧情而不是原地重复。`,
		},
	];
}

const OUTLINE_MIN = 80;
const OUTLINE_MAX = 600;

/** 大纲硬性预检：字数出格直接打回（不劳 LLM 审核） */
export function outlineGateHard(outline: string): { quote: string; constraint: string; problem: string }[] {
	if (outline.length >= OUTLINE_MIN && outline.length <= OUTLINE_MAX) return [];
	return [
		{
			quote: outline.slice(0, 30),
			constraint: "大纲规格（80-600 字）",
			problem: `大纲长度 ${outline.length} 字，超出规格；请${outline.length < OUTLINE_MIN ? "充实每个节点的信息增量" : "压缩过程细节、保留节点骨架"}后重新提交。`,
		},
	];
}

/** 从读者选择文本提取关键词（按标点切分，取 ≥2 字的段），用于承接性检查 */
function choiceKeywords(choice: string): string[] {
	return choice
		.split(/[——…、，。;；!？?！:：\s()（）「」《》"'·]+/)
		.map((s) => s.trim())
		.filter((s) => s.length >= 2);
}

/** 大纲软性预检：疑点提示喂给审核，不直接打回 */
export function outlineGateNotes(outline: string, lastChoice: string | null): string[] {
	const notes: string[] = [];
	if (lastChoice) {
		const kws = choiceKeywords(lastChoice);
		if (kws.length > 0 && !kws.some((k) => outline.includes(k))) {
			notes.push(`读者上一选择「${lastChoice}」在大纲中找不到明显呼应——请核对承接性，若确实未承接应打回。`);
		}
	}
	return notes;
}

/** 大纲中已登记角色的出场情况（给审核做「未登记名扫描」的参考面） */
export function outlineCastNote(outline: string, knownNames: string[]): string | null {
	const present = knownNames.filter((n) => n.length >= 2 && outline.includes(n));
	if (present.length === 0) return null;
	return `大纲提及的已登记角色：${present.join("、")}。其余出场人物若需具名，须是已登记角色或无名指代（如「店主」）。`;
}

/** 开局设计校验：可确定性修复前的硬伤清单（供一轮 LLM 修复） */
export function designIssues(design: StoryDesign): string[] {
	const issues: string[] = [];
	if (!design.title?.trim()) issues.push("书名（title）为空");
	if (!design.premise?.trim()) issues.push("故事梗概（premise）为空");
	if (!design.worldRules?.trim()) issues.push("世界规则（worldRules）为空");
	if (!design.economy?.currency?.trim()) issues.push("经济体系的计价单位（economy.currency）为空");
	if (!design.economy?.overview?.trim()) issues.push("经济体系概述（economy.overview）为空");
	if (!design.arc?.title?.trim() || !design.arc?.goal?.trim()) issues.push("第一弧的标题或目标为空");
	if (!design.openingBeat?.trim()) issues.push("开场拍（openingBeat）为空");
	if (!Array.isArray(design.characters) || design.characters.length < 2) issues.push("主要角色少于 2 个");
	if (!Array.isArray(design.attributes) || design.attributes.length < 4 || design.attributes.length > 8) {
		issues.push(`世界属性表需要 4-8 条（当前 ${design.attributes?.length ?? 0} 条）`);
	}
	return issues;
}

/** 开局设计修复：属性表裁剪、stats 键对齐属性表并补默认值。返回告警。 */
export function sanitizeDesign(design: StoryDesign): { design: StoryDesign; warnings: string[] } {
	const warnings: string[] = [];
	let attributes = (design.attributes ?? []).map((a) => a?.trim()).filter(Boolean);
	if (attributes.length > 8) {
		attributes = attributes.slice(0, 8);
		warnings.push("属性表超过 8 条，已截断");
	}
	if (attributes.length > 0) {
		const attrSet = new Set(attributes);
		const characters = design.characters.map((c) => {
			const raw = c.initialState.stats;
			if (!raw) return c;
			const dropped = Object.keys(raw).filter((k) => !attrSet.has(k));
			const stats: Record<string, number> = {};
			for (const k of attributes) stats[k] = typeof raw[k] === "number" ? Math.min(18, Math.max(1, Math.round(raw[k]))) : 10;
			if (dropped.length > 0) warnings.push(`${c.name} 的属性键 [${dropped.join("、")}] 不在属性表中，已按属性表重排（缺省 10）`);
			return { ...c, initialState: { ...c.initialState, stats } };
		});
		return { design: { ...design, attributes, characters }, warnings };
	}
	return { design: { ...design, attributes }, warnings };
}

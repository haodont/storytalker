// ---------------------------------------------------------------------------
// 结算（只写）：场景报告落盘后的全部状态变更。本模块不得 import 任何
// assemble* 组装函数——读与写的物理边界，import 规则即文档。
// ---------------------------------------------------------------------------

import type { Store } from '../facts/store.js';
import type { CharacterState, ForeshadowOp, GameState, LedgerEntry, SceneReport, WorldEntity } from '../facts/types.js';

// -- 报告门禁（确定性，零 LLM）：落盘前拦截 Director 报告中的幻觉 ---------------

const SUMMARY_MAX = 400;
const TX_MAX_ABS = 1_000_000;

/** 追加去重：patch 里的条目若已存在（精确匹配，trim 后）则丢弃，防重复累积 */
function dedupeAppend(base: string[], add: string[]): string[] {
	const out = [...base];
	const seen = new Set(base.map((s) => s.trim()));
	for (const item of add) {
		const t = item.trim();
		if (t && !seen.has(t)) {
			out.push(t);
			seen.add(t);
		}
	}
	return out;
}

/**
 * 场景报告门禁：未知角色补丁丢弃、流水名字校验与金额钳制、choices 复验、摘要截断。
 * 返回清理后的报告与告警（引擎转成 status 事件）。
 */
export function sanitizeReport(report: SceneReport, knownNames: string[], knownEntities: string[] = []): { report: SceneReport; warnings: string[] } {
	const warnings: string[] = [];
	const known = new Set(knownNames);
	const knownEntity = new Set(knownEntities);

	const entityUpdates = (report.entityUpdates ?? []).filter((u) => {
		if (knownEntity.has(u.name) && u.patch && Object.keys(u.patch).length > 0) return true;
		warnings.push(`实体补丁指向未注册实体「${u.name}」，已丢弃（实体在设计时注册，运行中不可凭空新增）`);
		return false;
	});

	const characterUpdates = report.characterUpdates.filter((u) => {
		if (known.has(u.name)) return true;
		warnings.push(`状态补丁指向未登记角色「${u.name}」，已丢弃（新角色应先在剧情中合理登场）`);
		return false;
	});

	const transactions = (report.transactions ?? []).flatMap((tx) => {
		if (!known.has(tx.name)) {
			warnings.push(`收支流水的「${tx.name}」未登记，该笔已忽略`);
			return [];
		}
		if (!Number.isFinite(tx.change)) return [];
		if (Math.abs(tx.change) > TX_MAX_ABS) {
			warnings.push(`${tx.name} 的单笔金额 ${tx.change} 异常，已钳制到 ±${TX_MAX_ABS}`);
			return [{ ...tx, change: Math.sign(tx.change) * TX_MAX_ABS }];
		}
		return [tx];
	});

	const seenLabels = new Set<string>();
	const choices = (report.choices ?? []).filter((c) => {
		const label = c.label?.trim();
		if (!label || seenLabels.has(label)) return false;
		seenLabels.add(label);
		return true;
	}).slice(0, 4);

	const recommended =
		report.recommendedChoice != null
			? Math.min(Math.max(Math.round(report.recommendedChoice), 1), Math.max(choices.length, 1))
			: undefined;

	return {
		report: {
			...report,
			summary: report.summary.slice(0, SUMMARY_MAX),
			characterUpdates,
			transactions,
			entityUpdates,
			choices,
			recommendedChoice: recommended,
		},
		warnings,
	};
}

// -- 状态更新 ---------------------------------------------------------------

function mergeState(base: CharacterState, patch: CharacterState): CharacterState {
	return {
		location: patch.location ?? base.location,
		condition: patch.condition ?? base.condition,
		knowledge: patch.knowledge ? dedupeAppend(base.knowledge ?? [], patch.knowledge) : base.knowledge,
		relationships: patch.relationships ? { ...(base.relationships ?? {}), ...patch.relationships } : base.relationships,
		emotions: patch.emotions ? dedupeAppend(base.emotions ?? [], patch.emotions) : base.emotions,
		stats: mergeStats(base.stats, patch.stats),
		finance: mergeFinance(base.finance, patch.finance),
	};
}

/** 属性合并：补丁值钳制 1-18（防成长/受伤补丁写出超模数值） */
function mergeStats(base?: Record<string, number>, patch?: Record<string, number>): Record<string, number> | undefined {
	if (!patch && !base) return undefined;
	if (!patch) return base;
	const out: Record<string, number> = { ...(base ?? {}) };
	for (const [k, v] of Object.entries(patch)) {
		const n = Math.round(Number(v));
		if (Number.isFinite(n)) out[k] = Math.min(18, Math.max(1, n));
	}
	return out;
}

function mergeFinance(base: CharacterState["finance"], patch: CharacterState["finance"]): CharacterState["finance"] {
	if (!patch && !base) return undefined;
	if (!patch) return base;
	return {
		// balance 由引擎按流水结算；patch 里的 balance 仅作为 Director 的修正快照
		balance: patch.balance ?? base?.balance,
		income: patch.income ?? base?.income,
		debts: patch.debts ? [...(base?.debts ?? []), ...patch.debts] : base?.debts,
	};
}

/**
 * 收支结算（代码管账）：按场景报告的 transactions 逐笔结算角色余额、追加账本。
 * 未知角色跳过。返回提醒列表（如余额为负）。
 */
export async function applyTransactions(
	store: Store,
	sceneIndex: number,
	transactions: { name: string; change: number; reason: string }[],
): Promise<string[]> {
	const warnings: string[] = [];
	const entries: LedgerEntry[] = [];
	for (const tx of transactions) {
		if (!Number.isFinite(tx.change) || tx.change === 0) continue;
		const card = await store.loadCharacter(tx.name);
		if (!card) continue;
		const before = card.state.finance?.balance ?? 0;
		const after = before + tx.change;
		await store.saveCharacter({
			...card,
			state: { ...card.state, finance: { ...card.state.finance, balance: after } },
		});
		entries.push({ scene: sceneIndex, name: tx.name, change: tx.change, reason: tx.reason, balanceAfter: after });
		if (after < 0) warnings.push(`${tx.name} 余额已为负（${after}），后续场景按负债处理`);
	}
	await store.appendLedger(entries);
	return warnings;
}

export async function applyCharacterPatches(store: Store, updates: { name: string; patch: CharacterState }[]): Promise<void> {
	for (const { name, patch } of updates) {
		const card = await store.loadCharacter(name);
		if (!card) continue; // 未知角色由 Reviewer 把关；这里不中断流水线
		await store.saveCharacter({ ...card, state: mergeState(card.state, patch) });
	}
}

/** 实体状态合并：数字保留数字（供代码结算/趋势），字符串保留字符串 */
export async function applyEntityPatches(store: Store, updates: { name: string; patch: Record<string, string | number> }[]): Promise<void> {
	if (updates.length === 0) return;
	const entities = await store.loadEntities();
	for (const { name, patch } of updates) {
		const e = entities.find((x) => x.name === name);
		if (!e) continue; // 已由门禁过滤，此处兜底
		const state: Record<string, string | number> = { ...e.state };
		for (const [k, v] of Object.entries(patch)) {
			if (v === null || v === undefined) continue;
			if (typeof v === "number" && !Number.isFinite(v)) continue;
			state[k] = v;
		}
		e.state = state;
	}
	await store.saveEntities(entities);
}

export async function applyForeshadowOps(store: Store, ops: ForeshadowOp[], sceneIndex: number): Promise<string[]> {
	const warnings: string[] = [];
	const entries = await store.loadForeshadows();
	for (const op of ops) {
		if (op.action === "plant") {
			const id = op.id ?? `F${String(sceneIndex).padStart(3, "0")}-${String(entries.length + 1).padStart(2, "0")}`;
			const existing = entries.find((e) => e.id === id);
			if (existing) {
				warnings.push(`伏笔「${id}」已被埋设于场景${existing.plantedAtScene}，重复 plant 已忽略`);
				continue;
			}
			entries.push({ id, description: op.description ?? "", plantedAtScene: sceneIndex, status: "open", notes: op.note ? [op.note] : [] });
		} else {
			const target = entries.find((e) => e.id === op.id);
			if (!target) {
				warnings.push(`伏笔操作「${op.action}」指向未注册的伏笔 ID「${op.id}」，已忽略`);
				continue;
			}
			if (op.action === "resolve") {
				if (target.status === "resolved") {
					warnings.push(`伏笔「${op.id}」已被回收过，重复 resolve 已忽略`);
					continue;
				}
				target.status = "resolved";
			}
			target.notes = [...(target.notes ?? []), ...(op.note ? [`场景${sceneIndex}: ${op.note}`] : [])];
		}
	}
	await store.saveForeshadows(entries);
	return warnings;
}

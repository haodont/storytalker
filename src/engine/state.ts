// ---------------------------------------------------------------------------
// GameState 工厂与归一化（从 engine.ts 拆出，静态纯函数）。
// schemaVersion 语义：加字段/改语义时递增，normalizeState 统一兜底旧存档。
// ---------------------------------------------------------------------------
import type { GameState } from "../facts/types.js";

/** GameState 结构版本：加字段/改语义时递增，restoreOrEmpty 的 normalizeState 兜底 */
export const CURRENT_SCHEMA_VERSION = 2;

/** 空局初始状态 */
export function initialState(): GameState {
	return {
		phase: "empty",
		mode: "manual",
		title: "",
		premise: "",
		sceneIndex: 0,
		arcBeatIndex: 0,
		arc: null,
		arcCount: 1,
		pendingReport: null,
		ideaMsgs: [],
		schemaVersion: CURRENT_SCHEMA_VERSION,
		updatedAt: new Date().toISOString(),
	};
}

/** 存档归一化：旧版本快照缺字段时补默认值（新增字段一律在此兜底，替代散点补丁） */
export function normalizeState(saved: GameState): GameState {
	return {
		...saved,
		schemaVersion: CURRENT_SCHEMA_VERSION,
		title: saved.title ?? "",
		premise: saved.premise ?? "",
		sceneIndex: saved.sceneIndex ?? 0,
		arcBeatIndex: saved.arcBeatIndex ?? 1,
		arcCount: saved.arcCount ?? 1,
		pendingReport: saved.pendingReport ?? null,
		ideaMsgs: saved.ideaMsgs ?? [],
	};
}

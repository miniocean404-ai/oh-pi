
import type { Settings } from "../config/settings";
import { hindsightBackend } from "../hindsight";
import { localBackend } from "./local-backend";
import { offBackend } from "./off-backend";
import type { MemoryBackend } from "./types";

/**
 * Pick the active memory backend for a Settings instance.
 * 根据 Settings 实例选择当前活跃的记忆后端。
 *
 * Selection rules (single source of truth — every memory consumer routes
 * through this):
 * 选择规则（唯一事实来源 — 所有记忆消费方均通过此函数路由）：
 *   - `memory.backend === "hindsight"`  → Hindsight remote memory / Hindsight 远程记忆
 *   - `memory.backend === "local"`      → local pipeline / 本地管线
 *   - everything else                   → no-op / 空操作
 *
 * `memories.enabled` remains accepted only as a legacy migration input. Once
 * a config is loaded, `memory.backend` is the sole runtime selector.
 * `memories.enabled` 仅作为旧版迁移输入保留。配置加载后，
 * `memory.backend` 是唯一的运行时选择器。
 */
export function resolveMemoryBackend(settings: Settings): MemoryBackend {
	const id = settings.get("memory.backend");
	if (id === "hindsight") return hindsightBackend;
	if (id === "local") return localBackend;
	return offBackend;
}



import {
	buildMemoryToolDeveloperInstructions,
	clearMemoryData,
	enqueueMemoryConsolidation,
	startMemoryStartupTask,
} from "../memories";
import type { MemoryBackend } from "./types";

/**
 * Wraps the existing `memories/` module as a `MemoryBackend`.
 * 将现有的 `memories/` 模块封装为 `MemoryBackend` 实现。
 *
 * No behavioural change — every call delegates to the legacy entry points so
 * the local memory pipeline (rollout summarisation → SQLite → memory_summary.md)
 * keeps working exactly as before.
 * 无行为变更 — 每个调用都委托给旧版入口，确保本地记忆管线
 *（滚动摘要 → SQLite → memory_summary.md）维持原有行为。
 */
export const localBackend: MemoryBackend = {
	id: "local",
	start(options) {
		startMemoryStartupTask(options);
	},
	async buildDeveloperInstructions(agentDir, settings) {
		return buildMemoryToolDeveloperInstructions(agentDir, settings);
	},
	async clear(agentDir, cwd) {
		await clearMemoryData(agentDir, cwd);
	},
	async enqueue(agentDir, cwd) {
		enqueueMemoryConsolidation(agentDir, cwd);
	},
};


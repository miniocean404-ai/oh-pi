
import type { MemoryBackend } from "./types";

/**
 * No-op memory backend.
 * 空操作记忆后端。
 *
 * Selected when `memory.backend` is `"off"`.
 * 当 `memory.backend` 设置为 `"off"` 时选用。
 */
export const offBackend: MemoryBackend = {
	id: "off",
	async start() {},
	async buildDeveloperInstructions() {
		return undefined;
	},
	async clear() {},
	async enqueue() {},
};


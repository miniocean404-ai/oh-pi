
/**
 * 每会话的文件内容缓存，记录当前 agent 会话中 `read` 和 `search` 工具
 * 渲染给模型时的文件内容。
 *
 * 用于 hashline 模式的锚点过期恢复：如果模型基于某个文件版本编写了锚点，
 * 但该文件在读取和编辑之间被子 agent、用户、linter 或格式化工具修改了——
 * 我们会对缓存的编辑前快照重放编辑，并将结果三路合并到磁盘上的实时文件。
 *
 * 作用域为 `ToolSession`：缓存存在于会话对象本身，不同会话不共享快照，
 * 会话超出作用域时条目被回收。每个会话保持一个小的 LRU 路径窗口；
 * 缓存始终反映*当前*会话最近看到的内容。
 *
 * Per-session cache of file contents as they were rendered to the model by
 * the `read` and `search` tools in the current agent session.
 *
 * Used by hashline-mode anchor-stale recovery: if the model authored anchors
 * against a version of the file that no longer matches what is on disk —
 * because a subagent, the user, a linter, or a formatter modified the file
 * between the read and the edit — we replay the edits against the cached
 * pre-edit snapshot and 3-way-merge the result onto the live file.
 *
 * Scoped per `ToolSession`: the cache lives on the session object itself, so
 * different sessions never share snapshots and entries get reclaimed when
 * the session goes out of scope. Each session keeps a small LRU window of
 * paths; the cache always reflects what *this* session most recently saw,
 * so it stays correct by construction even when this session writes the
 * file itself — the next read after the write refreshes the entry.
 */
import { LRUCache } from "lru-cache/raw";
import type { ToolSession } from "../tools";

/** 每个会话缓存的最大路径数 */
const MAX_PATHS_PER_SESSION = 30;

/** 文件读取快照，记录 `read`/`search` 工具观察到的行内容 */
export interface FileReadSnapshot {
	/** 1 索引的行号 → `read`/`search` 观察到的精确行内容 */
	/** 1-indexed line number → exact line content as observed by `read`/`search`. */
	lines: Map<number, string>;
	/** 记录时间戳 */
	recordedAt: number;
}

/** 文件读取缓存类，基于 LRU 策略管理文件快照 */
export class FileReadCache {
	#snapshots = new LRUCache<string, FileReadSnapshot>({ max: MAX_PATHS_PER_SESSION });

	/** 查找 `absPath` 的最近快照，不存在则返回 `null` */
	/** Look up the most recent snapshot for `absPath`, or `null` if absent. */
	get(absPath: string): FileReadSnapshot | null {
		return this.#snapshots.get(absPath) ?? null;
	}

	/** 记录连续行（如来自 `read` 工具）。`startLine` 从 1 开始索引 */
	/** Record a contiguous run of lines (e.g. from a `read` tool). `startLine` is 1-indexed. */
	recordContiguous(absPath: string, startLine: number, lines: readonly string[]): void {
		if (lines.length === 0) return;
		const entries: Array<readonly [number, string]> = lines.map((line, idx) => [startLine + idx, line] as const);
		this.#record(absPath, entries);
	}

	/** 记录稀疏的 `(行号, 内容)` 对（如 `search` 匹配结果和上下文） */
	/** Record sparse `(lineNumber, content)` pairs (e.g. `search` matches plus context). */
	recordSparse(absPath: string, entries: Iterable<readonly [number, string]>): void {
		const arr = Array.from(entries);
		if (arr.length === 0) return;
		this.#record(absPath, arr);
	}

	/** 删除单个路径的快照 */
	/** Drop the snapshot for a single path. */
	invalidate(absPath: string): void {
		this.#snapshots.delete(absPath);
	}

	/** 清空所有快照 */
	/** Drop every snapshot. */
	clear(): void {
		this.#snapshots.clear();
	}

	#record(absPath: string, entries: ReadonlyArray<readonly [number, string]>): void {
		const existing = this.#snapshots.get(absPath);
		if (existing && hasConflict(existing.lines, entries)) {
			// 文件内容自上次记录后已更改。丢弃过期快照，用刚观察到的内容重新开始。
			this.#snapshots.set(absPath, { lines: new Map(entries), recordedAt: Date.now() });
			return;
		}
		if (existing) {
			for (const [lineNum, content] of entries) existing.lines.set(lineNum, content);
			existing.recordedAt = Date.now();
			// 上面的 `get` 已经更新了此键的 LRU 最近访问状态
			return;
		}
		this.#snapshots.set(absPath, { lines: new Map(entries), recordedAt: Date.now() });
	}
}

/** 检查已有快照和新数据之间是否存在内容冲突 */
function hasConflict(existing: Map<number, string>, incoming: ReadonlyArray<readonly [number, string]>): boolean {
	for (const [lineNum, content] of incoming) {
		const prior = existing.get(lineNum);
		if (prior !== undefined && prior !== content) return true;
	}
	return false;
}

/**
 * 查找（或延迟创建）附加到会话的文件读取缓存。
 * 缓存存储为 `session.fileReadCache`，与会话生命周期一致。
 *
 * Look up (or lazily create) the file-read cache attached to a session. The
 * cache is stored as `session.fileReadCache` so it lives exactly as long as
 * the session itself.
 */
export function getFileReadCache(session: ToolSession): FileReadCache {
	if (!session.fileReadCache) session.fileReadCache = new FileReadCache();
	return session.fileReadCache;
}


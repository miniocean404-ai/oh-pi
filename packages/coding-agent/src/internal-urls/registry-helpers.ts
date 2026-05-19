
/**
 * Shared helpers for internal-url protocol handlers that resolve IDs against
 * registered agent sessions.
 *
 * 内部 URL 协议处理器的共享辅助函数，用于将各种 ID 解析到已注册的 Agent 会话。
 */
import { AgentRegistry } from "../registry/agent-registry";

/**
 * Snapshot of artifacts dirs for every registered session, deduped.
 *
 * Prefers `sessionManager.getArtifactsDir()` because subagents adopt their
 * parent's `ArtifactManager` and report the parent's dir there; dedup then
 * collapses parent + N subagents (the whole agent tree) to one entry. Falls
 * back to the raw session file (with the `.jsonl` suffix stripped) when no
 * live session reference is attached.
 *
 * 收集所有已注册会话的 artifacts 目录快照（去重后）。
 * 优先使用 `sessionManager.getArtifactsDir()`：子 Agent 会沿用父 Agent
 * 的 `ArtifactManager` 并上报父级目录，因此去重后整棵 Agent 树（父 + N 个子）
 * 会合并为一项。当没有挂载活跃会话引用时，则回退到原始会话文件路径
 * （去掉 `.jsonl` 后缀）。
 */
export function artifactsDirsFromRegistry(): string[] {
	const dirs: string[] = [];
	for (const ref of AgentRegistry.global().list()) {
		const dir =
			ref.session?.sessionManager.getArtifactsDir() ?? (ref.sessionFile ? ref.sessionFile.slice(0, -6) : null);
		if (!dir) continue;
		if (!dirs.includes(dir)) dirs.push(dir);
	}
	return dirs;
}


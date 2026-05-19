
/**
 * Memory backend abstraction.
 * 记忆后端抽象层。
 *
 * Backends are mutually exclusive — `resolveMemoryBackend(settings)` returns
 * exactly one. Implementations MUST be self-contained: they own the per-session
 * state they create in `start()` and tear it down on `clear()`.
 * 后端之间互斥 — `resolveMemoryBackend(settings)` 只返回一个。
 * 实现必须自包含：在 `start()` 中创建的会话状态由自身管理，并在 `clear()` 时清理。
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { HindsightSessionState } from "../hindsight/state";
import type { AgentSession } from "../session/agent-session";

/** 记忆后端标识类型 */
export type MemoryBackendId = "off" | "local" | "hindsight";

/** 记忆后端启动选项 */
export interface MemoryBackendStartOptions {
	/** 代理会话实例 */
	session: AgentSession;
	/** 配置实例 */
	settings: Settings;
	/** 模型注册表 */
	modelRegistry: ModelRegistry;
	/** 代理目录路径 */
	agentDir: string;
	/** 任务嵌套深度 */
	taskDepth: number;
	/** 父级 Hindsight 会话状态（可选） */
	parentHindsightSessionState?: HindsightSessionState;
}

/** 记忆后端接口定义 */
export interface MemoryBackend {
	/** 后端唯一标识 */
	readonly id: MemoryBackendId;

	/**
	 * Wire any background work or session subscriptions for this backend.
	 * 为该后端挂载后台任务或会话订阅。
	 *
	 * Called once per agent session at startup. Implementations MUST be
	 * non-throwing: failures should be logged and swallowed so a misconfigured
	 * memory backend cannot break the agent loop.
	 * 每个代理会话启动时调用一次。实现不得抛出异常：错误应记录并吞掉，
	 * 防止配置错误的记忆后端破坏代理循环。
	 */
	start(options: MemoryBackendStartOptions): void | Promise<void>;

	/**
	 * Markdown injected as the system-prompt append section.
	 * 作为系统提示词附加段注入的 Markdown 内容。
	 * Returned on every prompt rebuild via `refreshBaseSystemPrompt()`.
	 * 每次通过 `refreshBaseSystemPrompt()` 重建提示词时返回。
	 */
	buildDeveloperInstructions(
		agentDir: string,
		settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined>;

	/** Wipe all persisted state for this backend (slash `/memory clear`). */
	/** 清除该后端的所有持久化状态（对应 `/memory clear` 命令）。 */
	clear(agentDir: string, cwd: string, session?: AgentSession): Promise<void>;

	/** Force consolidation/retain to happen now (slash `/memory enqueue`). */
	/** 立即强制执行记忆整合/保留（对应 `/memory enqueue` 命令）。 */
	enqueue(agentDir: string, cwd: string, session?: AgentSession): Promise<void>;

	/**
	 * Optional hook to inject a backend-specific block into the current turn's
	 * system prompt before the agent starts generating.
	 * 可选钩子，在代理开始生成前，向当前轮次的系统提示词注入后端特定内容。
	 *
	 * This is the only place a backend can affect the very first answer of a
	 * fresh session. The returned text is appended to the already-built base
	 * system prompt for this turn only; callers may separately cache it and
	 * surface it through `buildDeveloperInstructions()` on later rebuilds.
	 * 这是后端影响新会话首次回答的唯一入口。返回的文本仅在本轮附加到
	 * 已构建的基础系统提示词上；调用方可单独缓存并在后续重建时通过
	 * `buildDeveloperInstructions()` 暴露。
	 */
	beforeAgentStartPrompt?(session: AgentSession, promptText: string): Promise<string | undefined>;

	/**
	 * Optional hook to splice extra context into a compaction summarization.
	 * 可选钩子，向压缩摘要中插入额外上下文。
	 *
	 * Called from the compaction call site before the LLM summary is requested.
	 * Returning a string appends one entry to the compaction's `extraContext`
	 * list (which becomes part of the summarization prompt). Return `undefined`
	 * to inject nothing — the local backend takes this branch because its
	 * summary is already part of the system prompt.
	 * 在请求 LLM 摘要前由压缩调用点调用。返回字符串会追加到压缩的
	 * `extraContext` 列表（成为摘要提示词的一部分）。返回 `undefined` 表示
	 * 不注入内容 — 本地后端走此分支，因为其摘要已在系统提示词中。
	 */
	preCompactionContext?(
		messages: AgentMessage[],
		settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined>;
}


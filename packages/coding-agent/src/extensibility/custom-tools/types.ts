
/**
 * Custom tool types.
 *
 * Custom tools are TypeScript modules that define additional tools for the agent.
 * They can provide custom rendering for tool calls and results in the TUI.
 *
 * 自定义工具相关类型。
 *
 * 自定义工具是为 agent 定义额外工具的 TypeScript 模块，
 * 它们可以为 TUI 中的工具调用与结果提供自定义渲染。
 */
import type { AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model, Static, TSchema } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import type { Rule } from "../../capability/rule";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { ExecOptions, ExecResult } from "../../exec/exec";
import type { HookUIContext } from "../../extensibility/hooks/types";
import type { Theme } from "../../modes/theme/theme";
import type { ReadonlySessionManager } from "../../session/session-manager";
import type { TodoItem } from "../../tools/todo-write";

/** Alias for clarity
 *  HookUIContext 的别名，语义更清晰 */
export type CustomToolUIContext = HookUIContext;

// Re-export for backward compatibility
// 为保持向后兼容而重新导出
export type { ExecOptions, ExecResult } from "../../exec/exec";
/** Re-export for custom tools to use in execute signature
 *  重新导出，便于自定义工具在 execute 签名中直接使用 */
export type { AgentToolResult, AgentToolUpdateCallback };

/** Pending action entry consumed by the hidden resolve tool
 *  待决动作条目，由隐藏的 resolve 工具消费 */
export interface CustomToolPendingAction {
	/** Human-readable preview label shown in resolve flow
	 *  在 resolve 流程中展示的可读预览标签 */
	label: string;
	/** Apply callback invoked when resolve(action="apply") is called
	 *  当调用 resolve(action="apply") 时触发的 apply 回调 */
	apply(reason: string): Promise<AgentToolResult<unknown>>;
	/** Optional reject callback invoked when resolve(action="discard") is called
	 *  可选的 reject 回调，当调用 resolve(action="discard") 时触发 */
	reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;
	/** Optional details metadata stored with the pending action
	 *  随待决动作一同保存的可选细节元数据 */
	details?: unknown;
	/** Optional source tool name shown by resolve renderer (defaults to "custom_tool")
	 *  在 resolve 渲染器中展示的来源工具名（默认 "custom_tool"） */
	sourceToolName?: string;
}

/** API passed to custom tool factory (stable across session changes)
 *  传给自定义工具工厂的 API（在会话切换间保持稳定） */
export interface CustomToolAPI {
	/** Current working directory
	 *  当前工作目录 */
	cwd: string;
	/** Execute a command
	 *  执行命令 */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
	/** UI methods for user interaction (select, confirm, input, notify, custom)
	 *  用于与用户交互的 UI 方法（select / confirm / input / notify / custom） */
	ui: CustomToolUIContext;
	/** Whether UI is available (false in print/RPC mode)
	 *  当前是否有 UI 可用（在 print/RPC 模式下为 false） */
	hasUI: boolean;
	/** File logger for error/warning/debug messages
	 *  用于输出错误 / 警告 / 调试信息的文件日志器 */
	logger: typeof import("@oh-my-pi/pi-utils").logger;
	/** Injected zod-backed typebox shim (legacy/compat — Zod-authored tools are preferred).
	 *  注入的基于 zod 的 typebox 兼容层（遗留 / 兼容用途；推荐直接使用 Zod 编写工具）。 */
	typebox: typeof import("../typebox");
	/** Injected zod module for Zod-authored custom tools.
	 *  注入的 zod 模块，供基于 Zod 编写的自定义工具使用。 */
	zod: typeof import("zod/v4");
	/** Injected pi-coding-agent exports
	 *  注入的 pi-coding-agent 包导出 */
	pi: typeof import("../..");
	/** Push a preview action that can later be resolved with the hidden resolve tool
	 *  推入一个预览动作，稍后可由隐藏的 resolve 工具决议（apply / discard） */
	pushPendingAction(action: CustomToolPendingAction): void;
}

/**
 * Context passed to tool execute and onSession callbacks.
 * Provides access to session state and model information.
 *
 * 传给工具 execute 与 onSession 回调的上下文。
 * 提供对会话状态与模型信息的访问能力。
 */
export interface CustomToolContext {
	/** Session manager (read-only)
	 *  只读的会话管理器 */
	sessionManager: ReadonlySessionManager;
	/** Model registry - use for API key resolution and model retrieval
	 *  模型注册表 —— 用于解析 API key 和获取模型 */
	modelRegistry: ModelRegistry;
	/** Current model (may be undefined if no model is selected yet)
	 *  当前模型（若尚未选择则可能为 undefined） */
	model: Model | undefined;
	/** Whether the agent is idle (not streaming)
	 *  agent 是否处于空闲状态（即未在流式输出中） */
	isIdle(): boolean;
	/** Whether there are queued messages waiting to be processed
	 *  是否存在已排队待处理的消息 */
	hasQueuedMessages(): boolean;
	/** Abort the current agent operation (fire-and-forget, does not wait)
	 *  中止当前的 agent 操作（fire-and-forget，不等待完成） */
	abort(): void;
	/** Settings instance for the current session. Prefer over the global singleton.
	 *  当前会话使用的 Settings 实例，应优先于全局单例使用。 */
	settings?: Settings;
}

/** Session event passed to onSession callback
 *  传给 onSession 回调的会话事件 */
export type CustomToolSessionEvent =
	| {
			/** Reason for the session event
			 *  会话事件的触发原因 */
			reason: "start" | "switch" | "branch" | "tree" | "shutdown";
			/** Previous session file path, or undefined for "start" and "shutdown"
			 *  前一个会话文件路径；对于 "start" 与 "shutdown" 为 undefined */
			previousSessionFile: string | undefined;
	  }
	| {
			reason: "auto_compaction_start";
			trigger: "threshold" | "overflow" | "idle";
			action: "context-full" | "handoff";
	  }
	| {
			reason: "auto_compaction_end";
			action: "context-full" | "handoff";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| {
			reason: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| {
			reason: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
	  }
	| {
			reason: "ttsr_triggered";
			rules: Rule[];
	  }
	| {
			reason: "todo_reminder";
			todos: TodoItem[];
			attempt: number;
			maxAttempts: number;
	  };

/** Rendering options passed to renderResult
 *  传给 renderResult 的渲染选项 */
export interface RenderResultOptions {
	/** Whether the result view is expanded
	 *  结果视图是否处于展开状态 */
	expanded: boolean;
	/** Whether this is a partial/streaming result
	 *  当前是否为部分 / 流式结果 */
	isPartial: boolean;
	/** Current spinner frame index for animated elements (0-9, only provided during partial results)
	 *  动画元素的当前 spinner 帧索引（0-9，仅在部分结果阶段提供） */
	spinnerFrame?: number;
}

/** 自定义工具结果的别名，泛型 TDetails 用于细化结构化详情类型 */
export type CustomToolResult<TDetails = any> = AgentToolResult<TDetails>;

/**
 * Custom tool definition.
 *
 * Custom tools are standalone - they don't extend AgentTool directly.
 * When loaded, they are wrapped in an AgentTool for the agent to use.
 *
 * The execute callback receives a ToolContext with access to session state,
 * model registry, and current model.
 *
 * 自定义工具定义。
 *
 * 自定义工具是独立的 —— 不直接继承 AgentTool。
 * 加载时会被包装成 AgentTool 供 agent 使用。
 *
 * execute 回调接收 CustomToolContext，可访问会话状态、模型注册表与当前模型。
 *
 * @example
 * ```typescript
 * const factory: CustomToolFactory = (pi) => ({
 *   name: "my_tool",
 *   label: "My Tool",
 *   description: "Does something useful",
 *   parameters: Type.Object({ input: Type.String() }),
 *
 *   async execute(toolCallId, params, onUpdate, ctx, signal) {
 *     // Access session state via ctx.sessionManager
 *     // Access model registry via ctx.modelRegistry
 *     // Current model via ctx.model
 *     return { content: [{ type: "text", text: "Done" }] };
 *   },
 *
 *   onSession(event, ctx) {
 *     if (event.reason === "shutdown") {
 *       // Cleanup
 *     }
 *     // Reconstruct state from ctx.sessionManager.getEntries()
 *   }
 * });
 * ```
 */
export interface CustomTool<TParams extends TSchema = TSchema, TDetails = any> {
	/** Tool name (used in LLM tool calls)
	 *  工具名（在 LLM 的 tool call 中使用） */
	name: string;
	/** Human-readable label for UI
	 *  在 UI 中展示的人类可读标签 */
	label: string;
	/** If true, tool is strictly typed and validated against the parameters schema before execution
	 *  为 true 时，执行前会按 parameters schema 严格校验参数类型 */
	strict?: boolean;
	/** Description for LLM
	 *  提供给 LLM 的工具描述 */
	description: string;
	/** Parameter schema (Zod or TypeBox; TypeBox is auto-lifted to Zod at registration).
	 *  参数 schema（Zod 或 TypeBox；TypeBox 在注册阶段会自动转换为 Zod）。 */
	parameters: TParams;
	/** If true, tool is excluded unless explicitly listed in --tools or agent's tools field
	 *  为 true 时，除非在 --tools 或 agent.tools 中显式列出，否则该工具会被排除 */
	hidden?: boolean;
	/** If true, tool may stage deferred changes that require explicit resolve/discard.
	 *  为 true 时，工具可能暂存延迟变更，需要显式 resolve / discard 决议。 */
	deferrable?: boolean;
	/** MCP server name for discovery/search metadata when this tool fronts an MCP server.
	 *  当该工具代理某个 MCP server 时，用于发现 / 搜索元数据的 MCP server 名。 */
	mcpServerName?: string;
	/** Original MCP tool name for discovery/search metadata.
	 *  用于发现 / 搜索元数据的原始 MCP 工具名。 */
	mcpToolName?: string;
	/**
	 * Execute the tool.
	 * @param toolCallId - Unique ID for this tool call
	 * @param params - Parsed parameters matching the schema
	 * @param onUpdate - Callback for streaming partial results (for UI, not LLM)
	 * @param ctx - Context with session manager, model registry, and current model
	 * @param signal - Optional abort signal for cancellation
	 *
	 * 执行工具。
	 * @param toolCallId - 本次工具调用的唯一 ID
	 * @param params - 与 schema 匹配的已解析参数
	 * @param onUpdate - 流式部分结果回调（用于 UI，不发送给 LLM）
	 * @param ctx - 包含 sessionManager、modelRegistry 与当前模型的上下文
	 * @param signal - 可选的取消信号
	 */
	execute(
		toolCallId: string,
		params: Static<TParams>,
		onUpdate: AgentToolUpdateCallback<TDetails, TParams> | undefined,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<AgentToolResult<TDetails, TParams>>;

	/** Called on session lifecycle events - use to reconstruct state or cleanup resources
	 *  会话生命周期事件回调 —— 用于重建状态或清理资源 */
	onSession?: (event: CustomToolSessionEvent, ctx: CustomToolContext) => void | Promise<void>;
	/** Custom rendering for tool call display - return a Component
	 *  自定义工具调用的展示渲染 —— 返回一个 Component */
	renderCall?: (args: Static<TParams>, options: RenderResultOptions, theme: Theme) => Component;

	/** Custom rendering for tool result display - return a Component
	 *  自定义工具结果的展示渲染 —— 返回一个 Component */
	renderResult?: (
		result: CustomToolResult<TDetails>,
		options: RenderResultOptions,
		theme: Theme,
		args?: Static<TParams>,
	) => Component;
}

/** Factory function that creates a custom tool or array of tools
 *  用于创建自定义工具（单个或数组）的工厂函数 */
export type CustomToolFactory = (
	pi: CustomToolAPI,
) => CustomTool<any, any> | CustomTool<any, any>[] | Promise<CustomTool<any, any> | CustomTool<any, any>[]>;

/** Loaded custom tool with metadata and wrapped AgentTool
 *  已加载的自定义工具及其元数据 */
export interface LoadedCustomTool<TParams extends TSchema = TSchema, TDetails = any> {
	/** Original path (as specified)
	 *  原始路径（按指定方式保留） */
	path: string;
	/** Resolved absolute path
	 *  解析后的绝对路径 */
	resolvedPath: string;
	/** The original custom tool instance
	 *  原始自定义工具实例 */
	tool: CustomTool<TParams, TDetails>;
	/** Source metadata (provider and level)
	 *  来源元数据（provider 与 level） */
	source?: { provider: string; providerName: string; level: "user" | "project" };
}

/** Error with source metadata
 *  附带来源元数据的加载错误 */
export interface ToolLoadError {
	path: string;
	error: string;
	source?: { provider: string; providerName: string; level: "user" | "project" };
}

/** Result from loading custom tools
 *  加载自定义工具的结果 */
export interface CustomToolsLoadResult {
	tools: LoadedCustomTool[];
	errors: ToolLoadError[];
	/** Update the UI context for all loaded tools. Call when mode initializes.
	 *  为所有已加载工具更新 UI 上下文，应在模式初始化时调用。 */
	setUIContext(uiContext: CustomToolUIContext, hasUI: boolean): void;
}


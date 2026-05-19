
/**
 * Extension system types.
 *
 * Extensions are TypeScript modules that can:
 * - Subscribe to agent lifecycle events
 * - Register LLM-callable tools
 * - Register commands, keyboard shortcuts, and CLI flags
 * - Interact with the user via UI primitives
 *
 * 扩展系统类型定义。
 *
 * 扩展是 TypeScript 模块，可以：
 * - 订阅 agent 生命周期事件
 * - 注册可被 LLM 调用的工具
 * - 注册命令、快捷键和 CLI 标志
 * - 通过 UI 原语与用户交互
 */
import type { AgentMessage, AgentToolResult, AgentToolUpdateCallback, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Model,
	ProviderResponseMetadata,
	SimpleStreamOptions,
	Static,
	TextContent,
	TSchema,
} from "@oh-my-pi/pi-ai";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/utils/oauth/types";
import type * as piCodingAgent from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem, Component, EditorTheme, KeyId, TUI } from "@oh-my-pi/pi-tui";
import type { KeybindingsManager } from "../../config/keybindings";
import type { ModelRegistry } from "../../config/model-registry";
import type { EditToolDetails } from "../../edit";
import type { PythonResult } from "../../eval/py/executor";
import type { BashResult } from "../../exec/bash-executor";
import type { ExecOptions, ExecResult } from "../../exec/exec";
import type { CustomEditor } from "../../modes/components/custom-editor";
import type { Theme } from "../../modes/theme/theme";
import type { CustomMessage } from "../../session/messages";
import type { ReadonlySessionManager, SessionManager } from "../../session/session-manager";
import type {
	BashToolDetails,
	BashToolInput,
	FindToolDetails,
	FindToolInput,
	ReadToolDetails,
	ReadToolInput,
	SearchToolDetails,
	SearchToolInput,
	WriteToolInput,
} from "../../tools";
import type { EventBus } from "../../utils/event-bus";
import type {
	AgentEndEvent,
	AgentStartEvent,
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	ContextEvent,
	GoalUpdatedEvent,
	SessionBeforeBranchEvent,
	SessionBeforeBranchResult,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionBeforeSwitchEvent,
	SessionBeforeSwitchResult,
	SessionBeforeTreeEvent,
	SessionBeforeTreeResult,
	SessionBranchEvent,
	SessionCompactEvent,
	SessionCompactingEvent,
	SessionCompactingResult,
	SessionEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionSwitchEvent,
	SessionTreeEvent,
	TodoReminderEvent,
	ToolCallEventResult,
	ToolResultEventResult,
	TtsrTriggeredEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../shared-events";
import type { SlashCommandInfo } from "../slash-commands";

export type { AppKeybinding, KeybindingsManager } from "../../config/keybindings";
export type { ExecOptions, ExecResult } from "../../exec/exec";
export type { AgentToolResult, AgentToolUpdateCallback };

// ============================================================================
// UI Context
// UI 上下文
// ============================================================================

/**
 * UI dialog options for extensions.
 * 扩展使用的 UI 对话框通用选项。
 */
export interface ExtensionUIDialogOptions {
	signal?: AbortSignal;
	timeout?: number;
	/** Invoked when the UI times out while waiting for a selection/input */
	onTimeout?: () => void;
	/** Initial cursor position for select dialogs (0-indexed) */
	initialIndex?: number;
	/** Render an outlined list for select dialogs */
	outline?: boolean;
	/** Invoked when user presses left arrow in select dialogs */
	onLeft?: () => void;
	/** Invoked when user presses right arrow in select dialogs */
	onRight?: () => void;
	/** Invoked when user presses the external editor shortcut in select dialogs */
	onExternalEditor?: () => void;
	/** Optional footer hint text rendered by interactive selector */
	helpText?: string;
}

/** Raw terminal input listener for extensions.
 * 扩展使用的原始终端输入监听器。 */
export type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

/** 小组件相对编辑器的位置。 */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** 扩展小组件的配置项。 */
export interface ExtensionWidgetOptions {
	placement?: WidgetPlacement;
}

/** 可被扩展挂载到 UI 的组件类型，可选实现 dispose 进行清理。 */
export type ExtensionUiComponent = Component & { dispose?(): void };
/** UI 组件工厂：根据 TUI 与主题创建组件。 */
export type ExtensionUiComponentFactory = (tui: TUI, theme: Theme) => ExtensionUiComponent;
/** 小组件内容：字符串数组（纯文本）或组件工厂；undefined 表示清除。 */
export type ExtensionWidgetContent = string[] | ExtensionUiComponentFactory | undefined;

/**
 * UI context for extensions to request interactive UI.
 * Each mode (interactive, RPC, print) provides its own implementation.
 *
 * 扩展用以请求交互式 UI 的上下文。
 * 各运行模式（interactive、RPC、print）各自提供实现。
 */
// fallow-ignore-next-line code-duplication
// Parallel to HookUIContext: extensions expose a strictly larger UI surface
// (custom editor component, header/footer, widgets, theming, terminal input)
// and may be invoked from event handlers that have already taken the agent
// loop's lock — hooks intentionally cannot.
export interface ExtensionUIContext {
	/** Show a selector and return the user's choice. */
	select(title: string, options: string[], dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** Show a confirmation dialog. */
	confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean>;

	/** Show a text input dialog. */
	input(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** Show a notification to the user. */
	notify(message: string, type?: "info" | "warning" | "error"): void;

	/** Listen to raw terminal input (interactive mode only). Returns an unsubscribe function. */
	onTerminalInput(handler: TerminalInputHandler): () => void;

	/** Set status text in the footer/status bar. Pass undefined to clear. */
	setStatus(key: string, text: string | undefined): void;

	/** Set the working/loading message shown during streaming. Call with no argument to restore default. */
	setWorkingMessage(message?: string): void;

	/** Set a widget to display above or below the editor. Accepts string array or component factory. */
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;

	/** Set a custom footer component, or undefined to restore the built-in footer. */
	setFooter(factory: ExtensionUiComponentFactory | undefined): void;

	/** Set a custom header component, or undefined to restore the built-in header. */
	setHeader(factory: ExtensionUiComponentFactory | undefined): void;

	/** Set the terminal window/tab title. */
	setTitle(title: string): void;

	/** Show a custom component with keyboard focus. */
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => ExtensionUiComponent | Promise<ExtensionUiComponent>,
		options?: { overlay?: boolean },
	): Promise<T>;

	/** Set the text in the core input editor. */
	setEditorText(text: string): void;

	/**
	 * Paste text into the core input editor.
	 *
	 * Interactive mode should route through the editor's paste handling (e.g. large paste markers).
	 * Non-interactive modes may fall back to replacing the editor text.
	 */
	pasteToEditor(text: string): void;

	/** Get the current text from the core input editor. */
	getEditorText(): string;

	/** Show a multi-line editor for text editing. */
	editor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined>;

	/**
	 * Set a custom editor component via factory function, or `undefined` to restore the default editor.
	 *
	 * The factory must return a {@link CustomEditor} subclass. Plain `EditorComponent`/`Editor`
	 * instances do not implement the action-keys, escape callbacks, and custom-key-handler surface
	 * required by interactive mode.
	 */
	setEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined,
	): void;

	/** Get the current theme for styling. */
	readonly theme: Theme;

	/** Get all available themes with names and paths. */
	getAllThemes(): Promise<{ name: string; path: string | undefined }[]>;

	/** Load a theme by name without switching to it. */
	getTheme(name: string): Promise<Theme | undefined>;

	/** Set the current theme by name or Theme object. */
	setTheme(theme: string | Theme): Promise<{ success: boolean; error?: string }>;

	/** Get current tool output expansion state. */
	getToolsExpanded(): boolean;

	/** Set tool output expansion state. */
	setToolsExpanded(expanded: boolean): void;
}

// ============================================================================
// Extension Context
// 扩展上下文
// ============================================================================

/** 当前上下文 token 占用情况。 */
export interface ContextUsage {
	/** Estimated context tokens, or null if unknown (e.g. right after compaction, before next LLM response). */
	tokens: number | null;
	contextWindow: number;
	/** Context usage as percentage of context window, or null if tokens is unknown. */
	percent: number | null;
}

/** Compact 操作的回调选项。 */
export interface CompactOptions {
	onComplete?: (result: CompactionResult) => void;
	onError?: (error: Error) => void;
}

/**
 * Context passed to extension event handlers.
 * 传递给扩展事件处理器的上下文对象。
 */
// fallow-ignore-next-line code-duplication
// Parallel to HookContext: extensions expose a strictly larger runtime
// surface (model registry, system prompt, shutdown, full session manager
// access). Field overlap is incidental; merging into a base would require
// hooks to widen their public contract.
export interface ExtensionContext {
	/** UI methods for user interaction */
	ui: ExtensionUIContext;
	/** Get current context usage for the active model. */
	getContextUsage(): ContextUsage | undefined;
	/** Compact the session context (interactive mode shows UI). */
	compact(instructionsOrOptions?: string | CompactOptions): Promise<void>;
	/** Whether UI is available (false in print/RPC mode) */
	hasUI: boolean;
	/** Current working directory */
	cwd: string;
	/** Session manager (read-only) */
	sessionManager: ReadonlySessionManager;
	/** Model registry for API key resolution */
	modelRegistry: ModelRegistry;
	/** Current model (may be undefined) */
	model: Model | undefined;
	/** Whether the agent is idle (not streaming) */
	isIdle(): boolean;
	/** Abort the current agent operation */
	abort(): void;
	/** Whether there are queued messages waiting */
	hasPendingMessages(): boolean;
	/** Gracefully shutdown and exit. */
	shutdown(): void;
	/** Get the current effective system prompt. */
	getSystemPrompt(): string[];
	/** @deprecated Use hasPendingMessages() instead */
	hasQueuedMessages(): boolean;
}

/**
 * Extended context for command handlers.
 * Includes session control methods only safe in user-initiated commands.
 *
 * 命令处理器使用的扩展上下文。
 * 包含仅在用户主动触发命令时才安全的会话控制方法。
 */
// fallow-ignore-next-line code-duplication
// Parallel to HookCommandContext: same method names, different invariants —
// extension commands additionally permit `switchSession` and `reload`,
// which hooks must not call to avoid deadlocking the agent loop.
export interface ExtensionCommandContext extends ExtensionContext {
	/** Get current context usage for the active model. */
	getContextUsage(): ContextUsage | undefined;

	/** Wait for the agent to finish streaming */
	waitForIdle(): Promise<void>;

	/** Start a new session, optionally with initialization. */
	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;

	/** Branch from a specific entry, creating a new session file. */
	branch(entryId: string): Promise<{ cancelled: boolean }>;

	/** Navigate to a different point in the session tree. */
	navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }>;

	/** Switch to a different session file. */
	switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;

	/** Reload the current session/runtime state. */
	reload(): Promise<void>;

	/** Compact the session context (interactive mode shows UI). */
	compact(instructionsOrOptions?: string | CompactOptions): Promise<void>;
}

// ============================================================================
// Tool Types
// 工具类型
// ============================================================================

/** Rendering options for tool results
 * 工具结果渲染所用的选项 */
export interface ToolRenderResultOptions {
	/** Whether the result view is expanded */
	expanded: boolean;
	/** Whether this is a partial/streaming result */
	isPartial: boolean;
	/** Current spinner frame index for animated elements (optional) */
	spinnerFrame?: number;
}

/** Session event for tool onSession lifecycle
 * 工具 onSession 生命周期回调的会话事件 */
export interface ToolSessionEvent {
	/** Reason for the session event */
	reason: "start" | "switch" | "branch" | "tree" | "shutdown";
	/** Previous session file path, or undefined for "start" and "shutdown" */
	previousSessionFile: string | undefined;
}

/**
 * Tool definition for registerTool().
 * 通过 `registerTool()` 注册的工具定义。
 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
	/** Tool name (used in LLM tool calls) */
	name: string;
	/** Human-readable label for UI */
	label: string;
	/** Description for LLM */
	description: string;
	/** Parameter schema (Zod, or TypeBox for legacy/extension compat). */
	parameters: TParams;
	/** If true, tool is excluded unless explicitly listed in --tools or agent's tools field */
	hidden?: boolean;
	/** If true, tool is registered but not auto-included in the initial active set.
	 *  The registering extension is responsible for activating/deactivating it via setActiveTools(). */
	defaultInactive?: boolean;
	/** If true, tool may stage deferred changes that require explicit resolve/discard. */
	deferrable?: boolean;
	/** MCP server name for discovery/search metadata when this tool fronts an MCP server. */
	mcpServerName?: string;
	/** Original MCP tool name for discovery/search metadata. */
	mcpToolName?: string;
	/** Execute the tool. */
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<TDetails>>;

	/** Called on session lifecycle events - use to reconstruct state or cleanup resources */
	onSession?: (event: ToolSessionEvent, ctx: ExtensionContext) => void | Promise<void>;

	/** Custom rendering for tool call display */
	renderCall?: (args: Static<TParams>, options: ToolRenderResultOptions, theme: Theme) => Component;

	/** Custom rendering for tool result display */
	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: Theme,
		args?: Static<TParams>,
	) => Component;
}

// ============================================================================
// Resource Events
// 资源事件
// ============================================================================

/** Fired after session_start to allow extensions to provide additional resource paths.
 * 在 session_start 之后触发，允许扩展贡献额外的资源路径（skill/prompt/theme）。 */
export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

/** Result from resources_discover event handler
 * resources_discover 事件处理器返回的结果 */
export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
}

// ============================================================================
// Session Events (shared with hooks subsystem)
// 会话事件（与 hooks 子系统共享）
// ============================================================================

export type {
	SessionBeforeBranchEvent,
	SessionBeforeCompactEvent,
	SessionBeforeSwitchEvent,
	SessionBeforeTreeEvent,
	SessionBranchEvent,
	SessionCompactEvent,
	SessionCompactingEvent,
	SessionEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionSwitchEvent,
	SessionTreeEvent,
	TreePreparation,
} from "../shared-events";

// ============================================================================
// Agent Events
// Agent 事件
// ============================================================================

export type { ContextEvent } from "../shared-events";

/** Fired before a provider request is sent. Can replace the payload.
 * 在向 provider 发送请求前触发，可替换 payload。 */
export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	payload: unknown;
}

/** Fired after a provider response is received, before its stream body is consumed.
 * 在收到 provider 响应、消费流体之前触发。 */
export interface AfterProviderResponseEvent extends ProviderResponseMetadata {
	type: "after_provider_response";
}

/** Fired after user submits prompt but before agent loop.
 * 在用户提交 prompt 之后、agent 循环开始之前触发。 */
export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	prompt: string;
	images?: ImageContent[];
	systemPrompt: string[];
}

export type { AgentEndEvent, AgentStartEvent, TurnEndEvent, TurnStartEvent } from "../shared-events";

/** Fired when a message starts (user, assistant, or toolResult)
 * 在一条消息（用户/助手/工具结果）开始时触发 */
export interface MessageStartEvent {
	type: "message_start";
	message: AgentMessage;
}

/** Fired during assistant message streaming with token-by-token updates
 * 助手消息流式输出过程中按 token 触发更新 */
export interface MessageUpdateEvent {
	type: "message_update";
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEvent;
}

/** Fired when a message ends
 * 一条消息结束时触发 */
export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}

/** Fired when a tool starts executing
 * 工具开始执行时触发 */
export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
}

/** Fired during tool execution with partial/streaming output
 * 工具执行过程中产生部分/流式输出时触发 */
export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args: unknown;
	partialResult: unknown;
}

/** Fired when a tool finishes executing
 * 工具执行结束时触发 */
export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
}

export type {
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	TodoReminderEvent,
	TtsrTriggeredEvent,
} from "../shared-events";

/** Fired when AuthStorage automatically soft-disables a credential (e.g. OAuth `invalid_grant`). Not fired for user-initiated `remove()` or duplicate-credential dedup.
 * 当 AuthStorage 自动软禁用某个凭据时触发（例如 OAuth `invalid_grant`）。
 * 用户主动 `remove()` 或凭据去重时不会触发。 */
export interface CredentialDisabledEvent {
	type: "credential_disabled";
	/** Provider id whose credential was disabled (e.g. "anthropic"). */
	provider: string;
	/** Verbatim error captured for forensics (truncated upstream). */
	disabledCause: string;
}

// ============================================================================
// User Bash Events
// 用户 Bash 事件
// ============================================================================

/** Fired when user executes a bash command via ! or !! prefix
 * 当用户通过 `!` 或 `!!` 前缀执行 bash 命令时触发 */
export interface UserBashEvent {
	type: "user_bash";
	/** The command to execute */
	command: string;
	/** True if !! prefix was used (excluded from LLM context) */
	excludeFromContext: boolean;
	/** Current working directory */
	cwd: string;
}

// ============================================================================
// User Python Events
// 用户 Python 事件
// ============================================================================

/** Fired when user executes Python code via $ or $$ prefix
 * 当用户通过 `$` 或 `$$` 前缀执行 Python 代码时触发 */
export interface UserPythonEvent {
	type: "user_python";
	/** The Python code to execute */
	code: string;
	/** True if $$ prefix was used (excluded from LLM context) */
	excludeFromContext: boolean;
	/** Current working directory */
	cwd: string;
}

// ============================================================================
// Input Events
// 输入事件
// ============================================================================

/** Fired when the user submits input (interactive mode only).
 * 用户提交输入时触发（仅交互模式）。 */
export interface InputEvent {
	type: "input";
	text: string;
	images?: ImageContent[];
	source: "interactive" | "rpc" | "extension";
}

// ============================================================================
// Tool Events
// 工具事件
// ============================================================================

interface ToolCallEventBase {
	type: "tool_call";
	toolCallId: string;
}

export interface BashToolCallEvent extends ToolCallEventBase {
	toolName: "bash";
	input: BashToolInput;
}

export interface ReadToolCallEvent extends ToolCallEventBase {
	toolName: "read";
	input: ReadToolInput;
}

export interface EditToolCallEvent extends ToolCallEventBase {
	toolName: "edit";
	input: Record<string, unknown>;
}

export interface WriteToolCallEvent extends ToolCallEventBase {
	toolName: "write";
	input: WriteToolInput;
}

export interface SearchToolCallEvent extends ToolCallEventBase {
	toolName: "search";
	input: SearchToolInput;
}

export interface FindToolCallEvent extends ToolCallEventBase {
	toolName: "find";
	input: FindToolInput;
}

export interface CustomToolCallEvent extends ToolCallEventBase {
	toolName: string;
	input: Record<string, unknown>;
}

/** Fired before a tool executes. Can block.
 * 工具执行前触发，可阻断执行。 */
export type ToolCallEvent =
	| BashToolCallEvent
	| ReadToolCallEvent
	| EditToolCallEvent
	| WriteToolCallEvent
	| SearchToolCallEvent
	| FindToolCallEvent
	| CustomToolCallEvent;

interface ToolResultEventBase {
	type: "tool_result";
	toolCallId: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	isError: boolean;
}

export interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details: BashToolDetails | undefined;
}

export interface ReadToolResultEvent extends ToolResultEventBase {
	toolName: "read";
	details: ReadToolDetails | undefined;
}

export interface EditToolResultEvent extends ToolResultEventBase {
	toolName: "edit";
	details: EditToolDetails | undefined;
}

export interface WriteToolResultEvent extends ToolResultEventBase {
	toolName: "write";
	details: undefined;
}

export interface SearchToolResultEvent extends ToolResultEventBase {
	toolName: "search";
	details: SearchToolDetails | undefined;
}

export interface FindToolResultEvent extends ToolResultEventBase {
	toolName: "find";
	details: FindToolDetails | undefined;
}

export interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details: unknown;
}

/** Fired after a tool executes. Can modify result.
 * 工具执行结束后触发，可修改结果。 */
export type ToolResultEvent =
	| BashToolResultEvent
	| ReadToolResultEvent
	| EditToolResultEvent
	| WriteToolResultEvent
	| SearchToolResultEvent
	| FindToolResultEvent
	| CustomToolResultEvent;

/**
 * Type guard for narrowing ToolCallEvent by tool name.
 *
 * 通过工具名收窄 ToolCallEvent 的类型守卫。
 *
 * Built-in tools narrow automatically (no type params needed):
 * ```ts
 * if (isToolCallEventType("bash", event)) {
 *   event.input.command;  // string
 * }
 * ```
 *
 * Custom tools require explicit type parameters:
 * ```ts
 * if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
 *   event.input.action;  // typed
 * }
 * ```
 *
 * Note: Direct narrowing via `event.toolName === "bash"` doesn't work because
 * CustomToolCallEvent.toolName is `string` which overlaps with all literals.
 */
export function isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
export function isToolCallEventType(toolName: "read", event: ToolCallEvent): event is ReadToolCallEvent;
export function isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
export function isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
export function isToolCallEventType(toolName: "search", event: ToolCallEvent): event is SearchToolCallEvent;
export function isToolCallEventType(toolName: "find", event: ToolCallEvent): event is FindToolCallEvent;
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
	toolName: TName,
	event: ToolCallEvent,
): event is ToolCallEvent & { toolName: TName; input: TInput };
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
	return event.toolName === toolName;
}

/** Union of all event types
 * 所有扩展事件类型的联合 */
export type ExtensionEvent =
	| ResourcesDiscoverEvent
	| SessionEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| AfterProviderResponseEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| AutoCompactionStartEvent
	| AutoCompactionEndEvent
	| AutoRetryStartEvent
	| AutoRetryEndEvent
	| TtsrTriggeredEvent
	| TodoReminderEvent
	| GoalUpdatedEvent
	| CredentialDisabledEvent
	| UserBashEvent
	| UserPythonEvent
	| InputEvent
	| ToolCallEvent
	| ToolResultEvent;

// ============================================================================
// Event Results
// 事件处理结果
// ============================================================================

/** context 事件处理器的返回结果：可替换发送给 LLM 的消息列表。 */
export interface ContextEventResult {
	messages?: AgentMessage[];
}

/** before_provider_request 处理器的返回值（替换原 payload，类型不约束）。 */
export type BeforeProviderRequestEventResult = unknown;

export type { ToolCallEventResult } from "../shared-events";

/** Result from input event handler
 * input 事件处理器的返回结果 */
export interface InputEventResult {
	/** If true, the input was handled and should not continue through normal flow */
	handled?: boolean;
	/** Replace the input text */
	text?: string;
	/** Replace any pending images */
	images?: ImageContent[];
}

/** Result from user_bash event handler
 * user_bash 事件处理器的返回结果 */
export interface UserBashEventResult {
	/** Full replacement: extension handled execution, use this result */
	result?: BashResult;
}

/** Result from user_python event handler
 * user_python 事件处理器的返回结果 */
export interface UserPythonEventResult {
	/** Full replacement: extension handled execution, use this result */
	result?: PythonResult;
}

export type { ToolResultEventResult } from "../shared-events";

/** before_agent_start 事件处理器的返回结果：可注入消息或替换 systemPrompt。 */
export interface BeforeAgentStartEventResult {
	message?: Pick<CustomMessage, "customType" | "content" | "display" | "details" | "attribution">;
	/** Replace the system prompt for this turn. If multiple extensions return this, they are chained. */
	systemPrompt?: string[];
}

export type {
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionCompactingResult,
} from "../shared-events";

// ============================================================================
// Message Rendering
// 消息渲染
// ============================================================================

/** 自定义消息渲染选项。 */
export interface MessageRenderOptions {
	expanded: boolean;
}

/** 扩展可注册的自定义消息渲染器签名。 */
export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

// ============================================================================
// Command Registration
// 命令注册
// ============================================================================

// fallow-ignore-next-line code-duplication
// Parallel to HookAPI's RegisteredCommand: extensions add
// `getArgumentCompletions` and bind handlers to ExtensionCommandContext.
/** 扩展注册的 slash 命令；相比 hooks 多了参数补全能力且绑定 ExtensionCommandContext。 */
export interface RegisteredCommand {
	name: string;
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

// ============================================================================
// Extension API
// 扩展 API
// ============================================================================

/** Handler function type for events
 * 事件处理器函数类型 */
// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare return statements
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

/**
 * ExtensionAPI passed to extension factory functions.
 * 传递给扩展工厂函数的 ExtensionAPI 接口。
 */
export interface ExtensionAPI {
	// =========================================================================
	// Module Access
	// 模块访问
	// =========================================================================

	/** File logger for error/warning/debug messages */
	logger: typeof import("@oh-my-pi/pi-utils").logger;

	/** Injected zod-backed typebox shim for legacy `Type.Object(...)` parameter authoring. */
	typebox: typeof import("../typebox");

	/** Injected zod module for Zod-authored extension tools (canonical going forward). */
	zod: typeof import("zod/v4");

	/** Injected pi-coding-agent exports for accessing SDK utilities */
	pi: typeof piCodingAgent;

	// =========================================================================
	// Event Subscription
	// 事件订阅
	// =========================================================================

	on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(
		event: "session_before_switch",
		handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
	): void;
	on(event: "session_switch", handler: ExtensionHandler<SessionSwitchEvent>): void;
	on(
		event: "session_before_branch",
		handler: ExtensionHandler<SessionBeforeBranchEvent, SessionBeforeBranchResult>,
	): void;
	on(event: "session_branch", handler: ExtensionHandler<SessionBranchEvent>): void;
	on(
		event: "session_before_compact",
		handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): void;
	on(event: "session.compacting", handler: ExtensionHandler<SessionCompactingEvent, SessionCompactingResult>): void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void;
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
	on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
	on(
		event: "before_provider_request",
		handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
	): void;
	on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): void;
	on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
	on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
	on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
	on(event: "message_end", handler: ExtensionHandler<MessageEndEvent>): void;
	on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
	on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
	on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
	on(event: "auto_compaction_start", handler: ExtensionHandler<AutoCompactionStartEvent>): void;
	on(event: "auto_compaction_end", handler: ExtensionHandler<AutoCompactionEndEvent>): void;
	on(event: "auto_retry_start", handler: ExtensionHandler<AutoRetryStartEvent>): void;
	on(event: "auto_retry_end", handler: ExtensionHandler<AutoRetryEndEvent>): void;
	on(event: "ttsr_triggered", handler: ExtensionHandler<TtsrTriggeredEvent>): void;
	on(event: "todo_reminder", handler: ExtensionHandler<TodoReminderEvent>): void;
	on(event: "goal_updated", handler: ExtensionHandler<GoalUpdatedEvent>): void;
	on(event: "credential_disabled", handler: ExtensionHandler<CredentialDisabledEvent>): void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
	on(event: "user_python", handler: ExtensionHandler<UserPythonEvent, UserPythonEventResult>): void;

	// =========================================================================
	// Tool Registration
	// 工具注册
	// =========================================================================

	/** Register a tool that the LLM can call.
	 * 注册一个 LLM 可调用的工具。 */
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void;

	// =========================================================================
	// Command, Shortcut, Flag Registration
	// 命令、快捷键、CLI Flag 注册
	// =========================================================================

	/** Register a custom command. */
	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
			handler: RegisteredCommand["handler"];
		},
	): void;

	/** Register a keyboard shortcut. */
	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void;

	/** Register a CLI flag. */
	registerFlag(
		name: string,
		options: {
			description?: string;
			type: "boolean" | "string";
			default?: boolean | string;
		},
	): void;

	/** Set the display label for this extension, or set a label on a specific entry. */
	setLabel(entryIdOrLabel: string, label?: string | undefined): void;

	/** Get the value of a registered CLI flag. */
	getFlag(name: string): boolean | string | undefined;

	// =========================================================================
	// Message Rendering
	// 消息渲染
	// =========================================================================

	/** Register a custom renderer for CustomMessageEntry.
	 * 为 CustomMessageEntry 注册自定义渲染器。 */
	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;

	// =========================================================================
	// Actions
	// 动作方法
	// =========================================================================

	/**
	 * Send a custom message to the session.
	 *
	 * `deliverAs: "nextTurn"` keeps the message hidden from the editable pending-message UI.
	 * If `triggerTurn` is also true while the current turn is still unwinding, the session schedules
	 * an internal continuation that consumes the message on the next turn.
	 */
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;

	/** Send a user message to the agent. Always triggers a turn. */
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): void;

	/** Append a custom entry to the session for state persistence (not sent to LLM). */
	appendEntry<T = unknown>(customType: string, data?: T): void;

	/** Execute a shell command. */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	/** Get the list of currently active tool names. */
	getActiveTools(): string[];

	/** Get all configured tools (built-in + extension tools). */
	getAllTools(): string[];

	/** Set the active tools by name. */
	setActiveTools(toolNames: string[]): Promise<void>;

	/** Get available slash commands in the current session. */
	getCommands(): SlashCommandInfo[];

	/** Set the current model. Returns false if no API key available. */
	setModel(model: Model): Promise<boolean>;

	/** Get current thinking level. */
	getThinkingLevel(): ThinkingLevel | undefined;

	/** Set thinking level for the current session. */
	setThinkingLevel(level: ThinkingLevel): void;

	/** Get the current session name. */
	getSessionName(): string | undefined;

	/** Set the session name. Persists to the session file. */
	setSessionName(name: string): Promise<void>;

	// =========================================================================
	// Provider Registration
	// 模型 Provider 注册
	// =========================================================================

	/**
	 * Register or override a model provider.
	 *
	 * If `models` is provided: replaces all existing models for this provider.
	 * If only `baseUrl` is provided: overrides the URL for existing models.
	 * If `streamSimple` is provided: registers a custom API stream handler.
	 *
	 * @example
	 * // Register a new provider with custom models and streaming
	 * pi.registerProvider("google-vertex-claude", {
	 *   baseUrl: "https://us-east5-aiplatform.googleapis.com",
	 *   apiKey: "GOOGLE_CLOUD_PROJECT",
	 *   api: "vertex-claude-api",
	 *   streamSimple: myStreamFunction,
	 *   models: [
	 *     {
	 *       id: "claude-sonnet-4@20250514",
	 *       name: "Claude Sonnet 4 (Vertex)",
	 *       reasoning: true,
	 *       thinking: { mode: "anthropic-adaptive", minLevel: "minimal", maxLevel: "high" },
	 *       input: ["text", "image"],
	 *       cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	 *       contextWindow: 200000,
	 *       maxTokens: 64000,
	 *   ]
	 * });
	 *
	 * @example
	 * // Override baseUrl for an existing provider
	 * pi.registerProvider("anthropic", {
	 *   baseUrl: "https://proxy.example.com"
	 * });
	 */
	registerProvider(name: string, config: ProviderConfig): void;

	/** Shared event bus for extension communication. */
	events: EventBus;
}

// ============================================================================
// Provider Registration Types
// Provider 注册相关类型
// ============================================================================

/** Configuration for registering a provider via pi.registerProvider().
 * 通过 `pi.registerProvider()` 注册模型 provider 时使用的配置。 */
export interface ProviderConfig {
	/** Base URL for the API endpoint. Required when defining models. */
	baseUrl?: string;
	/** API key or environment variable name. Required when defining models unless oauth is provided. */
	apiKey?: string;
	/** API type identifier. Required when registering streamSimple or when models don't specify one. */
	api?: Api;
	/** Custom streaming function for non-built-in APIs. */
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	/** Custom headers to include in requests. */
	headers?: Record<string, string>;
	/** If true, adds Authorization: Bearer header with the resolved API key. */
	authHeader?: boolean;
	/** Models to register. If provided, replaces all existing models for this provider. */
	models?: ProviderModelConfig[];
	/** OAuth provider for /login support. */
	oauth?: {
		/** Display name in login UI. */
		name: string;
		/** Run the provider login flow and return credentials (or a plain API key) to persist. */
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string>;
		/** Refresh expired credentials. */
		refreshToken?(credentials: OAuthCredentials): Promise<OAuthCredentials>;
		/** Convert credentials to an API key string for requests. */
		getApiKey?(credentials: OAuthCredentials): string;
		/** Optional model rewrite hook for credential-aware routing (e.g., enterprise URLs). */
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
}

/** Configuration for a model within a provider.
 * Provider 内单个模型的配置。 */
export interface ProviderModelConfig {
	/** Model ID (e.g., "claude-sonnet-4@20250514"). */
	id: string;
	/** Display name (e.g., "Claude Sonnet 4 (Vertex)"). */
	name: string;
	/** API type override for this model. */
	api?: Api;
	/** Whether the model supports extended thinking at all. */
	reasoning: boolean;
	/** Optional canonical thinking capability metadata for per-model effort support. */
	thinking?: Model["thinking"];
	/** Supported input types. */
	input: ("text" | "image")[];
	/** Cost per million tokens. */
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** Premium Copilot requests charged per user-initiated request. */
	premiumMultiplier?: number;
	/** Maximum context window size in tokens. */
	contextWindow: number;
	/** Maximum output tokens. */
	maxTokens: number;
	/** Custom headers for this model. */
	headers?: Record<string, string>;
	/** OpenAI compatibility settings. */
	compat?: Model<Api>["compat"];
}

/** Extension factory function type. Supports both sync and async initialization.
 * 扩展工厂函数类型，支持同步或异步初始化。 */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

// ============================================================================
// Loaded Extension Types
// 已加载扩展相关类型
// ============================================================================

/** 已注册的工具及其所属扩展路径。 */
export interface RegisteredTool<TParams extends TSchema = TSchema, TDetails = unknown> {
	definition: ToolDefinition<TParams, TDetails>;
	extensionPath: string;
}

/** 扩展注册的 CLI Flag 元数据。 */
export interface ExtensionFlag {
	name: string;
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
	extensionPath: string;
}

/** 扩展注册的键盘快捷键定义。 */
export interface ExtensionShortcut {
	shortcut: KeyId;
	description?: string;
	handler: (ctx: ExtensionContext) => Promise<void> | void;
	extensionPath: string;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/** `pi.sendMessage()` 的实际执行处理器签名。 */
export type SendMessageHandler = <T = unknown>(
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
	/**
	 * `deliverAs: "nextTurn"` queues hidden custom context for the next turn.
	 * When paired with `triggerTurn: true` during prompt teardown, the session schedules
	 * an internal continuation without surfacing the message in the editable pending queue.
	 */
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
) => void;

/** `pi.sendUserMessage()` 的实际执行处理器签名。 */
export type SendUserMessageHandler = (
	content: string | (TextContent | ImageContent)[],
	options?: { deliverAs?: "steer" | "followUp" },
) => void;

/** `pi.appendEntry()` 的实际执行处理器签名。 */
export type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

/** 获取当前激活工具名列表。 */
export type GetActiveToolsHandler = () => string[];

/** 获取全部已配置工具名列表（内置 + 扩展）。 */
export type GetAllToolsHandler = () => string[];

/** 获取当前会话可用的 slash 命令信息。 */
export type GetCommandsHandler = () => SlashCommandInfo[];

/** 设置当前激活工具集合。 */
export type SetActiveToolsHandler = (toolNames: string[]) => Promise<void>;

/** 切换当前模型；缺少 API key 时返回 false。 */
export type SetModelHandler = (model: Model) => Promise<boolean>;

/** 获取当前会话的 thinking level。 */
export type GetThinkingLevelHandler = () => ThinkingLevel | undefined;

/** 设置 thinking level（可选是否持久化）。 */
export type SetThinkingLevelHandler = (level: ThinkingLevel, persist?: boolean) => void;

/** Shared state created by loader, used during registration and runtime.
 * 加载器创建的共享状态，注册与运行时阶段都会用到。 */
export interface ExtensionRuntimeState {
	flagValues: Map<string, boolean | string>;
	/** Provider registrations queued during extension loading, processed during session initialization */
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; sourceId: string }>;
}

/** Action implementations for ExtensionAPI methods.
 * ExtensionAPI 动作方法的具体实现集合。 */
export interface ExtensionActions {
	sendMessage: SendMessageHandler;
	sendUserMessage: SendUserMessageHandler;
	appendEntry: AppendEntryHandler;
	setLabel: (targetId: string, label: string | undefined) => void;
	getActiveTools: GetActiveToolsHandler;
	getAllTools: GetAllToolsHandler;
	setActiveTools: SetActiveToolsHandler;
	getCommands: GetCommandsHandler;
	setModel: SetModelHandler;
	getThinkingLevel: GetThinkingLevelHandler;
	setThinkingLevel: SetThinkingLevelHandler;
	getSessionName: () => string | undefined;
	setSessionName: (name: string) => Promise<void>;
}

/** Actions for ExtensionContext (ctx.* in event handlers).
 * ExtensionContext 中可用的动作集合（事件处理器中通过 ctx.* 调用）。 */
export interface ExtensionContextActions {
	getModel: () => Model | undefined;
	isIdle: () => boolean;
	abort: () => void;
	hasPendingMessages: () => boolean;
	shutdown: () => void;
	getContextUsage: () => ContextUsage | undefined;
	compact: (instructionsOrOptions?: string | CompactOptions) => Promise<void>;
	getSystemPrompt: () => string[];
}

/** Actions for ExtensionCommandContext (ctx.* in command handlers).
 * ExtensionCommandContext 中可用的动作集合（命令处理器中通过 ctx.* 调用）。 */
export interface ExtensionCommandContextActions {
	getContextUsage: () => ContextUsage | undefined;
	waitForIdle: () => Promise<void>;
	newSession: (options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
	}) => Promise<{ cancelled: boolean }>;
	branch: (entryId: string) => Promise<{ cancelled: boolean }>;
	navigateTree: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
	compact: (instructionsOrOptions?: string | CompactOptions) => Promise<void>;
	switchSession: (sessionPath: string) => Promise<{ cancelled: boolean }>;
	reload: () => Promise<void>;
}

/** Full runtime = state + actions.
 * 完整运行时 = 共享状态 + 动作实现。 */
export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {}

/** Loaded extension with all registered items.
 * 已加载的扩展，含所有注册项（handler、tool、command 等）。 */
export interface Extension {
	path: string;
	resolvedPath: string;
	label?: string;
	handlers: Map<string, HandlerFn[]>;
	tools: Map<string, RegisteredTool<any, any>>;
	messageRenderers: Map<string, MessageRenderer>;
	commands: Map<string, RegisteredCommand>;
	flags: Map<string, ExtensionFlag>;
	shortcuts: Map<KeyId, ExtensionShortcut>;
}

/** Result of loading extensions.
 * 扩展加载结果汇总。 */
export interface LoadExtensionsResult {
	extensions: Extension[];
	errors: Array<{ path: string; error: string }>;
	runtime: ExtensionRuntime;
}

// ============================================================================
// Extension Error
// 扩展错误
// ============================================================================

/** 扩展执行过程中产生的错误信息，用于 onError 监听上报。 */
export interface ExtensionError {
	extensionPath: string;
	event: string;
	error: string;
	stack?: string;
}


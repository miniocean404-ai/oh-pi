
/**
 * Extension runner - executes extensions and manages their lifecycle.
 * 扩展运行器 —— 调度扩展执行并管理其生命周期。
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CredentialDisabledEvent, ImageContent, Model, ProviderResponseMetadata } from "@oh-my-pi/pi-ai";
import type { KeyId } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import { type Theme, theme } from "../../modes/theme/theme";
import type { SessionManager } from "../../session/session-manager";
import type {
	AfterProviderResponseEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	CompactOptions,
	ContextEvent,
	ContextEventResult,
	ContextUsage,
	Extension,
	ExtensionActions,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFlag,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	InputEvent,
	InputEventResult,
	MessageRenderer,
	RegisteredCommand,
	RegisteredTool,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionCompactingResult,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	UserBashEvent,
	UserBashEventResult,
	UserPythonEvent,
	UserPythonEventResult,
} from "./types";

/** Combined result from all before_agent_start handlers
 * 所有 before_agent_start 处理器结果的合并产物 */
interface BeforeAgentStartCombinedResult {
	messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPrompt?: string[];
}

/** 扩展错误监听器函数类型。 */
export type ExtensionErrorListener = (error: ExtensionError) => void;

/** 扩展事件处理器默认超时时间（毫秒）。 */
export const EXTENSION_HANDLER_TIMEOUT_MS = 30_000;
let extensionHandlerTimeoutMs = EXTENSION_HANDLER_TIMEOUT_MS;

/** 仅供测试使用：覆盖扩展处理器超时阈值。 */
export function testSetExtensionHandlerTimeoutMs(timeoutMs: number): void {
	extensionHandlerTimeoutMs = timeoutMs;
}

const EXTENSION_HANDLER_TIMEOUT = Symbol("extensionHandlerTimeout");

const MAX_PENDING_CREDENTIAL_DISABLED = 32;

/**
 * Events handled by the generic emit() method.
 * Events with dedicated emitXxx() methods are excluded for stronger type safety.
 *
 * 通过通用 `emit()` 方法处理的事件集合；
 * 拥有独立 `emitXxx()` 方法的事件被排除以获得更强的类型安全。
 */
type RunnerEmitEvent = Exclude<
	ExtensionEvent,
	| ToolCallEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| AfterProviderResponseEvent
	| BeforeAgentStartEvent
	| ResourcesDiscoverEvent
	| InputEvent
>;

type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{ type: "session_before_switch" | "session_before_branch" | "session_before_compact" | "session_before_tree" }
>;

type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeBranchResult
	| SessionBeforeCompactResult
	| SessionBeforeTreeResult;

type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_branch" }
		? SessionBeforeBranchResult | undefined
		: TEvent extends { type: "session_before_compact" }
			? SessionBeforeCompactResult | undefined
			: TEvent extends { type: "session_before_tree" }
				? SessionBeforeTreeResult | undefined
				: TEvent extends { type: "session.compacting" }
					? SessionCompactingResult | undefined
					: undefined;

/** `ctx.newSession()` 的处理器签名。 */
export type NewSessionHandler = (options?: {
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

/** `ctx.branch()` 的处理器签名。 */
export type BranchHandler = (entryId: string) => Promise<{ cancelled: boolean }>;

/** `ctx.navigateTree()` 的处理器签名。 */
export type NavigateTreeHandler = (
	targetId: string,
	options?: { summarize?: boolean },
) => Promise<{ cancelled: boolean }>;

/** `ctx.switchSession()` 的处理器签名。 */
export type SwitchSessionHandler = (sessionPath: string) => Promise<{ cancelled: boolean }>;

/** 优雅关停处理器签名。 */
export type ShutdownHandler = () => void;

/**
 * Helper function to emit session_shutdown event to extensions.
 * Returns true if the event was emitted, false if there were no handlers.
 *
 * 向扩展广播 `session_shutdown` 事件的辅助函数。
 * 当事件被实际派发时返回 true，否则返回 false。
 */
export async function emitSessionShutdownEvent(extensionRunner: ExtensionRunner | undefined): Promise<boolean> {
	if (extensionRunner?.hasHandlers("session_shutdown")) {
		await extensionRunner.emit({
			type: "session_shutdown",
		});
		return true;
	}
	return false;
}

const noOpUIContext: ExtensionUIContext = {
	select: async (_title, _options, _dialogOptions) => undefined,
	confirm: async (_title, _message, _dialogOptions) => false,
	input: async (_title, _placeholder, _dialogOptions) => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	setEditorText: () => {},
	pasteToEditor: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	setEditorComponent: () => {},
	get theme() {
		return theme;
	},
	getAllThemes: () => Promise.resolve([]),
	getTheme: () => Promise.resolve(undefined),
	setTheme: (_theme: string | Theme) => Promise.resolve({ success: false, error: "UI not available" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

/**
 * 扩展运行器：保存所有已加载扩展，统一派发事件、聚合命令/快捷键/工具，
 * 并向扩展提供上下文（含 UI、模型、会话控制等）。
 */
export class ExtensionRunner {
	#uiContext: ExtensionUIContext;
	#errorListeners: Set<ExtensionErrorListener> = new Set();
	#getModel: () => Model | undefined = () => undefined;
	#isIdleFn: () => boolean = () => true;
	#waitForIdleFn: () => Promise<void> = async () => {};
	#abortFn: () => void = () => {};
	#hasPendingMessagesFn: () => boolean = () => false;
	#getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	#compactFn: (instructionsOrOptions?: string | CompactOptions) => Promise<void> = async () => {};
	#getSystemPromptFn: () => string[] = () => [];
	#newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	#branchHandler: BranchHandler = async () => ({ cancelled: false });
	#navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	#switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
	#reloadHandler: () => Promise<void> = async () => {};
	#shutdownHandler: ShutdownHandler = () => {};
	#commandDiagnostics: Array<{ type: string; message: string; path: string }> = [];
	#initialized = false;
	/**
	 * Buffer for `credential_disabled` events received via {@link emitCredentialDisabled}
	 * before {@link initialize} has run. Drained through {@link emit} once initialize sets
	 * up the runtime context, so extension handlers see a populated UI/runtime context
	 * rather than the constructor's no-op default. Bounded at
	 * {@link MAX_PENDING_CREDENTIAL_DISABLED}; oldest entries are dropped under pressure.
	 *
	 * 在 {@link initialize} 执行前，通过 {@link emitCredentialDisabled} 接收的
	 * `credential_disabled` 事件会被暂存于此缓冲区。初始化建立运行时上下文后
	 * 由 {@link emit} 排空，确保扩展处理器看到完整的 UI/runtime 上下文而非
	 * 构造期的 no-op 默认值。容量上限为 {@link MAX_PENDING_CREDENTIAL_DISABLED}，
	 * 溢出时丢弃最旧条目。
	 */
	#pendingCredentialDisabled: CredentialDisabledEvent[] = [];

	constructor(
		private readonly extensions: Extension[],
		private readonly runtime: ExtensionRuntime,
		private readonly cwd: string,
		private readonly sessionManager: SessionManager,
		private readonly modelRegistry: ModelRegistry,
	) {
		this.#uiContext = noOpUIContext;
	}

	initialize(
		actions: ExtensionActions,
		contextActions: ExtensionContextActions,
		commandContextActions?: ExtensionCommandContextActions,
		uiContext?: ExtensionUIContext,
	): void {
		// Copy actions into the shared runtime (all extension APIs reference this)
		// 将动作实现拷贝到共享 runtime，所有扩展 API 都通过它转发
		this.runtime.sendMessage = actions.sendMessage;
		this.runtime.sendUserMessage = actions.sendUserMessage;
		this.runtime.appendEntry = actions.appendEntry;
		this.runtime.getActiveTools = actions.getActiveTools;
		this.runtime.getAllTools = actions.getAllTools;
		this.runtime.setActiveTools = actions.setActiveTools;
		this.runtime.getCommands = actions.getCommands;
		this.runtime.setModel = actions.setModel;
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		this.runtime.setThinkingLevel = actions.setThinkingLevel;
		this.runtime.getSessionName = actions.getSessionName;
		this.runtime.setSessionName = actions.setSessionName;

		// Context actions (required)
		// 上下文动作（必填）
		this.#getModel = contextActions.getModel;
		this.#isIdleFn = contextActions.isIdle;
		this.#abortFn = contextActions.abort;
		this.#hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.#shutdownHandler = contextActions.shutdown;
		this.#getSystemPromptFn = contextActions.getSystemPrompt;

		// Command context actions (optional, only for interactive mode)
		// 命令上下文动作（可选，仅交互模式提供）
		if (commandContextActions) {
			this.#waitForIdleFn = commandContextActions.waitForIdle;
			this.#newSessionHandler = commandContextActions.newSession;
			this.#branchHandler = commandContextActions.branch;
			this.#navigateTreeHandler = commandContextActions.navigateTree;
			this.#switchSessionHandler = commandContextActions.switchSession;
			this.#reloadHandler = commandContextActions.reload;
			this.#getContextUsageFn = commandContextActions.getContextUsage;
			this.#compactFn = commandContextActions.compact;
		}

		this.#uiContext = uiContext ?? noOpUIContext;
		this.#initialized = true;

		// Drain events buffered by emitCredentialDisabled() before initialize ran. The
		// spread adds the `type` discriminator — `event` is the pi-ai shape (no `type`).
		// Deferred by one microtask so callers that register an onError listener
		// synchronously after initialize() see handler errors routed through it.
		// 排空 initialize 前由 emitCredentialDisabled() 缓存的事件。
		// 展开运算补上 `type` 判别字段（pi-ai 原始事件无该字段）。
		// 用 microtask 延后一次，确保在 initialize() 之后同步注册的 onError
		// 监听器能接收到处理器错误。
		const pending = this.#pendingCredentialDisabled.splice(0);
		queueMicrotask(() => {
			for (const event of pending) {
				this.emit({ type: "credential_disabled", ...event }).catch((error: unknown) => {
					logger.warn("credential_disabled handler threw during initialize flush", {
						provider: event.provider,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}
		});
	}

	/**
	 * Forward a `credential_disabled` event from `AuthStorage` to extension handlers.
	 *
	 * If {@link initialize} has not yet run, the event is buffered and replayed once
	 * initialize wires the runtime/UI context. This matters because mode controllers
	 * (interactive, RPC, ACP, print, subagent) call `initialize()` AFTER `createAgentSession`
	 * returns, but `AuthStorage` can fire `credential_disabled` during startup model probes
	 * inside `createAgentSession()`. Without deferral, extension handlers would observe
	 * `hasUI=false`, an unset model, and no-op runtime actions on exactly the headline
	 * "OAuth invalid_grant during startup" path the event was designed to surface.
	 *
	 * Always returns; never throws. Errors from handlers are routed through
	 * {@link onError} via {@link emit}'s normal isolation.
	 *
	 * 将 `AuthStorage` 抛出的 `credential_disabled` 事件转发给扩展处理器。
	 *
	 * 若 {@link initialize} 尚未执行，事件会被缓冲，待 initialize 接上 runtime/UI
	 * 上下文后再回放。原因：各模式控制器在 `createAgentSession` 返回后才调用
	 * `initialize()`，但 `AuthStorage` 可能在 `createAgentSession()` 内部的启动
	 * 模型探测中就触发该事件；不延后处理会让扩展看到 `hasUI=false`、模型未设置、
	 * runtime 动作均为 no-op，恰好遗漏该事件最关键的 "启动期 OAuth invalid_grant" 场景。
	 *
	 * 始终返回、不抛错；处理器错误通过 {@link emit} 的隔离机制转给 {@link onError}。
	 */
	async emitCredentialDisabled(event: CredentialDisabledEvent): Promise<void> {
		if (!this.#initialized) {
			if (this.#pendingCredentialDisabled.length >= MAX_PENDING_CREDENTIAL_DISABLED) {
				this.#pendingCredentialDisabled.shift();
			}
			this.#pendingCredentialDisabled.push(event);
			return;
		}
		await this.emit({ type: "credential_disabled", ...event });
	}

	getUIContext(): ExtensionUIContext {
		return this.#uiContext;
	}

	hasUI(): boolean {
		return this.#uiContext !== noOpUIContext;
	}

	getExtensionPaths(): string[] {
		return this.extensions.map(e => e.path);
	}

	/** Get all registered tools from all extensions.
	 * 获取所有扩展注册的工具集合。 */
	getAllRegisteredTools(): RegisteredTool[] {
		const tools: RegisteredTool[] = [];
		for (const ext of this.extensions) {
			for (const tool of ext.tools.values()) {
				tools.push(tool);
			}
		}
		return tools;
	}

	getFlags(): Map<string, ExtensionFlag> {
		const allFlags = new Map<string, ExtensionFlag>();
		for (const ext of this.extensions) {
			for (const [name, flag] of ext.flags) {
				allFlags.set(name, flag);
			}
		}
		return allFlags;
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
	}

	static readonly #RESERVED_SHORTCUTS = new Set([
		"ctrl+c",
		"ctrl+d",
		"ctrl+z",
		"ctrl+k",
		"ctrl+p",
		"ctrl+l",
		"ctrl+o",
		"ctrl+t",
		"ctrl+g",
		"shift+tab",
		"shift+ctrl+p",
		"alt+enter",
		"escape",
		"enter",
	]);

	getShortcuts(): Map<KeyId, ExtensionShortcut> {
		const allShortcuts = new Map<KeyId, ExtensionShortcut>();
		for (const ext of this.extensions) {
			for (const [key, shortcut] of ext.shortcuts) {
				const normalizedKey = key.toLowerCase() as KeyId;

				if (ExtensionRunner.#RESERVED_SHORTCUTS.has(normalizedKey)) {
					logger.warn("Extension shortcut conflicts with built-in shortcut", {
						key,
						extensionPath: shortcut.extensionPath,
					});
					continue;
				}

				const existing = allShortcuts.get(normalizedKey);
				if (existing) {
					logger.warn("Extension shortcut conflict", {
						key,
						extensionPath: shortcut.extensionPath,
						existingExtensionPath: existing.extensionPath,
					});
				}
				allShortcuts.set(normalizedKey, shortcut);
			}
		}
		return allShortcuts;
	}

	onError(listener: ExtensionErrorListener): () => void {
		this.#errorListeners.add(listener);
		return () => this.#errorListeners.delete(listener);
	}

	emitError(error: ExtensionError): void {
		for (const listener of this.#errorListeners) {
			listener(error);
		}
	}

	hasHandlers(eventType: string): boolean {
		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	getRegisteredCommands(reserved?: Set<string>): RegisteredCommand[] {
		this.#commandDiagnostics = [];

		const commands = new Map<string, RegisteredCommand>();
		for (const ext of this.extensions) {
			for (const command of ext.commands.values()) {
				if (reserved?.has(command.name)) {
					const message = `Extension command '${command.name}' from ${ext.path} conflicts with built-in commands. Skipping.`;
					this.#commandDiagnostics.push({ type: "warning", message, path: ext.path });
					if (!this.hasUI()) {
						logger.warn(message);
					}
					continue;
				}

				commands.set(command.name, command);
			}
		}
		return [...commands.values()];
	}

	getCommandDiagnostics(): Array<{ type: string; message: string; path: string }> {
		return this.#commandDiagnostics;
	}

	getCommand(name: string): RegisteredCommand | undefined {
		for (let index = this.extensions.length - 1; index >= 0; index -= 1) {
			const command = this.extensions[index]?.commands.get(name);
			if (command) {
				return command;
			}
		}
		return undefined;
	}

	createContext(): ExtensionContext {
		const getModel = this.#getModel;
		return {
			ui: this.#uiContext,
			getContextUsage: () => this.#getContextUsageFn(),
			compact: instructionsOrOptions => this.#compactFn(instructionsOrOptions),
			hasUI: this.hasUI(),
			cwd: this.cwd,
			sessionManager: this.sessionManager,
			modelRegistry: this.modelRegistry,
			get model() {
				return getModel();
			},
			isIdle: () => this.#isIdleFn(),
			abort: () => this.#abortFn(),
			hasPendingMessages: () => this.#hasPendingMessagesFn(),
			shutdown: () => this.#shutdownHandler(),
			getSystemPrompt: () => this.#getSystemPromptFn(),
			hasQueuedMessages: () => this.#hasPendingMessagesFn(), // deprecated alias
		};
	}

	/**
	 * Request a graceful shutdown. Called by extension tools and event handlers.
	 * 请求优雅关停；扩展工具与事件处理器可调用该方法。
	 */
	shutdown(): void {
		this.#shutdownHandler();
	}

	createCommandContext(): ExtensionCommandContext {
		return {
			...this.createContext(),
			getContextUsage: () => this.#getContextUsageFn(),
			waitForIdle: () => this.#waitForIdleFn(),
			newSession: options => this.#newSessionHandler(options),
			branch: entryId => this.#branchHandler(entryId),
			navigateTree: (targetId, options) => this.#navigateTreeHandler(targetId, options),
			switchSession: sessionPath => this.#switchSessionHandler(sessionPath),
			reload: () => this.#reloadHandler(),
			compact: instructionsOrOptions => this.#compactFn(instructionsOrOptions),
		};
	}

	#isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
		return (
			event.type === "session_before_switch" ||
			event.type === "session_before_branch" ||
			event.type === "session_before_compact" ||
			event.type === "session_before_tree"
		);
	}

	async #runHandlerWithTimeout<TEvent extends { type: string }, TResult>(
		handler: (event: TEvent, ctx: ExtensionContext) => Promise<TResult | undefined> | TResult | undefined,
		event: TEvent,
		ctx: ExtensionContext,
		ext: Extension,
		timeoutMs: number,
	): Promise<TResult | undefined> {
		try {
			const handlerResult = await Promise.race([
				Promise.resolve(handler(event, ctx)),
				Bun.sleep(timeoutMs).then(() => EXTENSION_HANDLER_TIMEOUT),
			]);
			if (handlerResult === EXTENSION_HANDLER_TIMEOUT) {
				const error = `handler timed out after ${timeoutMs}ms`;
				logger.warn("Extension handler timed out", {
					extensionPath: ext.path,
					event: event.type,
					timeoutMs,
				});
				this.emitError({
					extensionPath: ext.path,
					event: event.type,
					error,
				});
				return undefined;
			}
			return handlerResult as TResult | undefined;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? err.stack : undefined;
			this.emitError({
				extensionPath: ext.path,
				event: event.type,
				error: message,
				stack,
			});
			return undefined;
		}
	}

	async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		const ctx = this.createContext();
		let result: SessionBeforeEventResult | SessionCompactingResult | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(event.type);
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);

				if (this.#isSessionBeforeEvent(event) && handlerResult) {
					result = handlerResult as SessionBeforeEventResult;
					if (result.cancel) {
						return result as RunnerEmitResult<TEvent>;
					}
				}

				if (event.type === "session.compacting" && handlerResult) {
					result = handlerResult as SessionCompactingResult;
				}
			}
		}

		return result as RunnerEmitResult<TEvent>;
	}

	async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		const ctx = this.createContext();
		const currentEvent: ToolResultEvent = { ...event };
		let modified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_result");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = (await this.#runHandlerWithTimeout(
					handler,
					currentEvent,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				)) as ToolResultEventResult | undefined;
				if (!handlerResult) continue;

				if (handlerResult.content !== undefined) {
					currentEvent.content = handlerResult.content;
					modified = true;
				}
				if (handlerResult.details !== undefined) {
					currentEvent.details = handlerResult.details;
					modified = true;
				}
				if (handlerResult.isError !== undefined) {
					currentEvent.isError = handlerResult.isError;
					modified = true;
				}
			}
		}

		if (!modified) return undefined;

		return {
			content: currentEvent.content,
			details: currentEvent.details,
			isError: currentEvent.isError,
		};
	}

	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		const ctx = this.createContext();
		let result: ToolCallEventResult | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_call");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = await handler(event, ctx);

					if (handlerResult) {
						result = handlerResult as ToolCallEventResult;
						if (result.block) {
							return result;
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "tool_call",
						error: message,
						stack,
					});
					return { block: true, reason: `Extension ${ext.path} failed: ${message}` };
				}
			}
		}

		return result;
	}

	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		return this.emitUserEvent<UserBashEventResult>(event, "user_bash");
	}

	async emitUserPython(event: UserPythonEvent): Promise<UserPythonEventResult | undefined> {
		return this.emitUserEvent<UserPythonEventResult>(event, "user_python");
	}

	private async emitUserEvent<R>(
		event: UserBashEvent | UserPythonEvent,
		eventName: "user_bash" | "user_python",
	): Promise<R | undefined> {
		const ctx = this.createContext();

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventName);
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);
				if (handlerResult) {
					return handlerResult as R;
				}
			}
		}

		return undefined;
	}

	async emitResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverEvent["reason"],
	): Promise<{
		skillPaths: Array<{ path: string; extensionPath: string }>;
		promptPaths: Array<{ path: string; extensionPath: string }>;
		themePaths: Array<{ path: string; extensionPath: string }>;
	}> {
		const ctx = this.createContext();
		const skillPaths: Array<{ path: string; extensionPath: string }> = [];
		const promptPaths: Array<{ path: string; extensionPath: string }> = [];
		const themePaths: Array<{ path: string; extensionPath: string }> = [];

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("resources_discover");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: ResourcesDiscoverEvent = { type: "resources_discover", cwd, reason };
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);
				const result = handlerResult as ResourcesDiscoverResult | undefined;

				if (result?.skillPaths?.length) {
					skillPaths.push(...result.skillPaths.map(path => ({ path, extensionPath: ext.path })));
				}
				if (result?.promptPaths?.length) {
					promptPaths.push(...result.promptPaths.map(path => ({ path, extensionPath: ext.path })));
				}
				if (result?.themePaths?.length) {
					themePaths.push(...result.themePaths.map(path => ({ path, extensionPath: ext.path })));
				}
			}
		}

		return { skillPaths, promptPaths, themePaths };
	}

	/** Emit input event. Transforms chain, "handled" short-circuits.
	 * 派发 input 事件；多个处理器按链式累积转换，遇到 `handled` 即短路。 */
	async emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: "interactive" | "rpc" | "extension",
	): Promise<InputEventResult> {
		const ctx = this.createContext();
		let currentText = text;
		let currentImages = images;

		for (const ext of this.extensions) {
			for (const handler of ext.handlers.get("input") ?? []) {
				const event: InputEvent = { type: "input", text: currentText, images: currentImages, source };
				const result = (await this.#runHandlerWithTimeout(handler, event, ctx, ext, extensionHandlerTimeoutMs)) as
					| InputEventResult
					| undefined;
				if (result?.handled) return result;
				if (result?.text !== undefined) {
					currentText = result.text;
					currentImages = result.images ?? currentImages;
				}
			}
		}
		return currentText !== text || currentImages !== images ? { text: currentText, images: currentImages } : {};
	}

	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		const ctx = this.createContext();

		// Check if any extensions actually have context handlers before cloning
		// 在执行深拷贝前先检查是否真的有扩展订阅了 context 事件
		let hasContextHandlers = false;
		for (const ext of this.extensions) {
			if (ext.handlers.get("context")?.length) {
				hasContextHandlers = true;
				break;
			}
		}
		if (!hasContextHandlers) return messages;

		let currentMessages: AgentMessage[];
		try {
			currentMessages = structuredClone(messages);
		} catch {
			// Messages may contain non-cloneable objects (e.g. in ToolResultMessage.details
			// or ProviderPayload). Fall back to a shallow array clone — extensions should
			// return new message arrays rather than mutating in place.
			// 消息中可能存在无法 structuredClone 的对象（如 ToolResultMessage.details
			// 或 ProviderPayload），退化为浅拷贝；扩展应返回新数组而非原地修改。
			currentMessages = [...messages];
		}

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("context");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: ContextEvent = { type: "context", messages: currentMessages };
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);

				if (handlerResult && (handlerResult as ContextEventResult).messages) {
					currentMessages = (handlerResult as ContextEventResult).messages!;
				}
			}
		}

		return currentMessages;
	}

	async emitBeforeProviderRequest(payload: unknown): Promise<BeforeProviderRequestEventResult> {
		const ctx = this.createContext();
		let currentPayload = payload;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_provider_request");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: BeforeProviderRequestEvent = {
					type: "before_provider_request",
					payload: currentPayload,
				};
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);
				if (handlerResult !== undefined) {
					currentPayload = handlerResult;
				}
			}
		}

		return currentPayload;
	}

	async emitAfterProviderResponse(response: ProviderResponseMetadata, _model?: Model): Promise<void> {
		const ctx = this.createContext();

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("after_provider_response");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: AfterProviderResponseEvent = {
					type: "after_provider_response",
					status: response.status,
					headers: response.headers,
					requestId: response.requestId,
					metadata: response.metadata,
				};
				await this.#runHandlerWithTimeout(handler, event, ctx, ext, extensionHandlerTimeoutMs);
			}
		}
	}

	async emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPrompt: string[],
	): Promise<BeforeAgentStartCombinedResult | undefined> {
		const ctx = this.createContext();
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
		let currentSystemPrompt = systemPrompt;
		let systemPromptModified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_agent_start");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const event: BeforeAgentStartEvent = {
					type: "before_agent_start",
					prompt,
					images,
					systemPrompt: currentSystemPrompt,
				};
				const handlerResult = await this.#runHandlerWithTimeout(
					handler,
					event,
					ctx,
					ext,
					extensionHandlerTimeoutMs,
				);

				if (handlerResult) {
					const result = handlerResult as BeforeAgentStartEventResult;
					if (result.message) {
						messages.push(result.message);
					}
					if (result.systemPrompt !== undefined) {
						currentSystemPrompt = result.systemPrompt;
						systemPromptModified = true;
					}
				}
			}
		}

		if (messages.length > 0 || systemPromptModified) {
			return {
				messages: messages.length > 0 ? messages : undefined,
				systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
			};
		}

		return undefined;
	}
}


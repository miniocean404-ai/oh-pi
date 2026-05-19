
/**
 * Hook runner - executes hooks and manages their lifecycle.
 * Hook 运行器 —— 调度 hook 执行并管理其生命周期。
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../config/model-registry";
import type { SessionManager } from "../../session/session-manager";
import { createNoOpUIContext } from "../utils";
import type {
	AppendEntryHandler,
	BranchHandler,
	LoadedHook,
	NavigateTreeHandler,
	NewSessionHandler,
	SendMessageHandler,
} from "./loader";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ContextEvent,
	ContextEventResult,
	HookCommandContext,
	HookContext,
	HookError,
	HookEvent,
	HookMessageRenderer,
	HookUIContext,
	RegisteredCommand,
	SessionBeforeCompactResult,
	SessionBeforeTreeResult,
	SessionCompactingResult,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEventResult,
} from "./types";

/**
 * Listener for hook errors.
 * Hook 错误监听器签名。
 */
export type HookErrorListener = (error: HookError) => void;

// Re-export execCommand for backward compatibility
// 为向后兼容再次导出 execCommand
export { execCommand } from "../../exec/exec";

/**
 * HookRunner executes hooks and manages event emission.
 * HookRunner 负责执行 hook 并管理事件派发。
 */
export class HookRunner {
	#uiContext: HookUIContext;
	#hasUI: boolean;
	#errorListeners: Set<HookErrorListener> = new Set();
	#getModel: () => Model | undefined = () => undefined;
	#isIdleFn: () => boolean = () => true;
	#waitForIdleFn: () => Promise<void> = async () => {};
	#abortFn: () => void = () => {};
	#hasQueuedMessagesFn: () => boolean = () => false;
	#newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	#branchHandler: BranchHandler = async () => ({ cancelled: false });
	#navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });

	constructor(
		private readonly hooks: LoadedHook[],
		private readonly cwd: string,
		private readonly sessionManager: SessionManager,
		private readonly modelRegistry: ModelRegistry,
	) {
		this.#uiContext = createNoOpUIContext();
		this.#hasUI = false;
	}

	/**
	 * Initialize HookRunner with all required context.
	 * Modes call this once the agent session is fully set up.
	 *
	 * 使用所需的全部上下文初始化 HookRunner。
	 * 运行模式会在 agent 会话完全建立后调用一次。
	 */
	initialize(options: {
		/** Function to get the current model */
		getModel: () => Model | undefined;
		/** Handler for hooks to send messages */
		sendMessageHandler: SendMessageHandler;
		/** Handler for hooks to append entries */
		appendEntryHandler: AppendEntryHandler;
		/** Handler for creating new sessions (for HookCommandContext) */
		newSessionHandler?: NewSessionHandler;
		/** Handler for branching sessions (for HookCommandContext) */
		branchHandler?: BranchHandler;
		/** Handler for navigating session tree (for HookCommandContext) */
		navigateTreeHandler?: NavigateTreeHandler;
		/** Function to check if agent is idle */
		isIdle?: () => boolean;
		/** Function to wait for agent to be idle */
		waitForIdle?: () => Promise<void>;
		/** Function to abort current operation (fire-and-forget) */
		abort?: () => void;
		/** Function to check if there are queued messages */
		hasQueuedMessages?: () => boolean;
		/** UI context for interactive prompts */
		uiContext?: HookUIContext;
		/** Whether UI is available */
		hasUI?: boolean;
	}): void {
		this.#getModel = options.getModel;
		this.#isIdleFn = options.isIdle ?? (() => true);
		this.#waitForIdleFn = options.waitForIdle ?? (async () => {});
		this.#abortFn = options.abort ?? (() => {});
		this.#hasQueuedMessagesFn = options.hasQueuedMessages ?? (() => false);
		// Store session handlers for HookCommandContext
		// 缓存 HookCommandContext 所需的会话控制处理器
		if (options.newSessionHandler) {
			this.#newSessionHandler = options.newSessionHandler;
		}
		if (options.branchHandler) {
			this.#branchHandler = options.branchHandler;
		}
		if (options.navigateTreeHandler) {
			this.#navigateTreeHandler = options.navigateTreeHandler;
		}
		// Set per-hook handlers for pi.sendMessage() and pi.appendEntry()
		// 为每个 hook 注入 pi.sendMessage() / pi.appendEntry() 的实际实现
		for (const hook of this.hooks) {
			hook.setSendMessageHandler(options.sendMessageHandler);
			hook.setAppendEntryHandler(options.appendEntryHandler);
		}
		this.#uiContext = options.uiContext ?? createNoOpUIContext();
		this.#hasUI = options.hasUI ?? false;
	}

	/**
	 * Get the UI context (set by mode).
	 * 获取由运行模式注入的 UI 上下文。
	 */
	getUIContext(): HookUIContext | null {
		return this.#uiContext;
	}

	/**
	 * Get whether UI is available.
	 * 当前是否具备可交互 UI。
	 */
	getHasUI(): boolean {
		return this.#hasUI;
	}

	/**
	 * Get the paths of all loaded hooks.
	 * 获取所有已加载 hook 的路径。
	 */
	getHookPaths(): string[] {
		return this.hooks.map(h => h.path);
	}

	/**
	 * Subscribe to hook errors.
	 * @returns Unsubscribe function
	 *
	 * 订阅 hook 错误事件。
	 * @returns 用于取消订阅的函数
	 */
	onError(listener: HookErrorListener): () => void {
		this.#errorListeners.add(listener);
		return () => this.#errorListeners.delete(listener);
	}

	/**
	 * Emit an error to all listeners.
	 */
	/**
	 * Emit an error to all error listeners.
	 * 向所有错误监听器派发一条 hook 错误。
	 */
	emitError(error: HookError): void {
		for (const listener of this.#errorListeners) {
			listener(error);
		}
	}

	/**
	 * Check if any hooks have handlers for the given event type.
	 * 判断是否有任何 hook 订阅了指定事件类型。
	 */
	hasHandlers(eventType: string): boolean {
		for (const hook of this.hooks) {
			const handlers = hook.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Get a message renderer for the given customType.
	 * Returns the first renderer found across all hooks, or undefined if none.
	 *
	 * 获取指定 customType 的消息渲染器，返回所有 hook 中首个匹配的渲染器。
	 */
	getMessageRenderer(customType: string): HookMessageRenderer | undefined {
		for (const hook of this.hooks) {
			const renderer = hook.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	/**
	 * Get all registered commands from all hooks.
	 * 汇总所有 hook 注册的 slash 命令。
	 */
	getRegisteredCommands(): RegisteredCommand[] {
		const commands: RegisteredCommand[] = [];
		for (const hook of this.hooks) {
			for (const command of hook.commands.values()) {
				commands.push(command);
			}
		}
		return commands;
	}

	/**
	 * Get a registered command by name.
	 * Returns the first command found across all hooks, or undefined if none.
	 *
	 * 按名称查找命令，返回所有 hook 中首个匹配项；未找到时返回 undefined。
	 */
	getCommand(name: string): RegisteredCommand | undefined {
		for (const hook of this.hooks) {
			const command = hook.commands.get(name);
			if (command) {
				return command;
			}
		}
		return undefined;
	}

	/**
	 * Create the event context for handlers.
	 * 为事件处理器构造一个 HookContext 实例。
	 */
	#createContext(): HookContext {
		return {
			ui: this.#uiContext,
			hasUI: this.#hasUI,
			cwd: this.cwd,
			sessionManager: this.sessionManager,
			modelRegistry: this.modelRegistry,
			model: this.#getModel(),
			isIdle: () => this.#isIdleFn(),
			abort: () => this.#abortFn(),
			hasQueuedMessages: () => this.#hasQueuedMessagesFn(),
		};
	}

	/**
	 * Create the command context for slash command handlers.
	 * Extends HookContext with session control methods that are only safe in commands.
	 *
	 * 为 slash 命令处理器构造 HookCommandContext，
	 * 在 HookContext 基础上加入仅在命令中安全使用的会话控制方法。
	 */
	createCommandContext(): HookCommandContext {
		return {
			...this.#createContext(),
			waitForIdle: () => this.#waitForIdleFn(),
			newSession: options => this.#newSessionHandler(options),
			branch: entryId => this.#branchHandler(entryId),
			navigateTree: (targetId, options) => this.#navigateTreeHandler(targetId, options),
		};
	}

	/**
	 * Check if event type is a session "before_*" event that can be cancelled.
	 * 判断事件类型是否属于可取消的 session `before_*` 系列。
	 */
	#isSessionBeforeEvent(
		type: string,
	): type is "session_before_switch" | "session_before_branch" | "session_before_compact" | "session_before_tree" {
		return (
			type === "session_before_switch" ||
			type === "session_before_branch" ||
			type === "session_before_compact" ||
			type === "session_before_tree"
		);
	}

	/**
	 * Emit an event to all hooks.
	 * Returns the result from session before_* / tool_result events (if any handler returns one).
	 *
	 * 向所有 hook 派发事件；若是 session before_* 或 tool_result 事件
	 * 且有处理器返回了结果，则把该结果一并返回。
	 */
	async emit(
		event: HookEvent,
	): Promise<
		SessionBeforeCompactResult | SessionBeforeTreeResult | SessionCompactingResult | ToolResultEventResult | undefined
	> {
		const ctx = this.#createContext();
		let result:
			| SessionBeforeCompactResult
			| SessionBeforeTreeResult
			| SessionCompactingResult
			| ToolResultEventResult
			| undefined;

		for (const hook of this.hooks) {
			const handlers = hook.handlers.get(event.type);
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = await handler(event, ctx);

					// For session before_* events, capture the result (for cancellation)
					// 对 session before_* 事件，捕获结果以便支持取消
					if (this.#isSessionBeforeEvent(event.type) && handlerResult) {
						result = handlerResult as SessionBeforeCompactResult | SessionBeforeTreeResult;
						// If cancelled, stop processing further hooks
						// 已取消则不再继续派发给后续 hook
						if (result.cancel) {
							return result;
						}
					}

					// For tool_result events, capture the result
					// tool_result 事件：保留处理器修改后的结果
					if (event.type === "tool_result" && handlerResult) {
						result = handlerResult as ToolResultEventResult;
					}
					if (event.type === "session.compacting" && handlerResult) {
						result = handlerResult as SessionCompactingResult;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					this.emitError({
						hookPath: hook.path,
						event: event.type,
						error: message,
					});
				}
			}
		}

		return result;
	}

	/**
	 * Emit a tool_call event to all hooks.
	 * No timeout - user prompts can take as long as needed.
	 * Errors are thrown (not swallowed) so caller can block on failure.
	 *
	 * 向所有 hook 派发 tool_call 事件。
	 * 不设置超时（用户审批等场景可能耗时较长）；
	 * 错误会上抛而不被吞掉，以便调用方在失败时阻断执行。
	 */
	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		const ctx = this.#createContext();
		let result: ToolCallEventResult | undefined;

		for (const hook of this.hooks) {
			const handlers = hook.handlers.get("tool_call");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				// No timeout - let user take their time
				// 不限制超时，给用户充足的审批时间
				const handlerResult = await handler(event, ctx);

				if (handlerResult) {
					result = handlerResult as ToolCallEventResult;
					// If blocked, stop processing further hooks
					// 一旦阻断，停止派发给后续 hook
					if (result.block) {
						return result;
					}
				}
			}
		}

		return result;
	}

	/**
	 * Emit a context event to all hooks.
	 * Handlers are chained - each gets the previous handler's output (if any).
	 * Returns the final modified messages, or the original if no modifications.
	 *
	 * Note: Messages are already deep-copied by the caller (pi-ai preprocessor).
	 *
	 * 向所有 hook 派发 context 事件。
	 * 处理器按链式执行，每个处理器都会拿到上一个处理器的输出（若有）。
	 * 返回最终修改后的消息；若没有修改则返回原消息。
	 *
	 * 注意：调用方（pi-ai 预处理器）已经对 messages 做过深拷贝。
	 */
	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		const ctx = this.#createContext();
		let currentMessages = messages;

		for (const hook of this.hooks) {
			const handlers = hook.handlers.get("context");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: ContextEvent = { type: "context", messages: currentMessages };
					const handlerResult = await handler(event, ctx);

					if (handlerResult && (handlerResult as ContextEventResult).messages) {
						currentMessages = (handlerResult as ContextEventResult).messages!;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					this.emitError({
						hookPath: hook.path,
						event: "context",
						error: message,
					});
				}
			}
		}

		return currentMessages;
	}

	/**
	 * Emit before_agent_start event to all hooks.
	 * Returns the first message to inject (if any handler returns one).
	 *
	 * 向所有 hook 派发 before_agent_start 事件。
	 * 若有处理器返回了消息，则采用第一个返回的消息作为注入内容。
	 */
	async emitBeforeAgentStart(
		prompt: string,
		images?: import("@oh-my-pi/pi-ai").ImageContent[],
	): Promise<BeforeAgentStartEventResult | undefined> {
		const ctx = this.#createContext();
		let result: BeforeAgentStartEventResult | undefined;

		for (const hook of this.hooks) {
			const handlers = hook.handlers.get("before_agent_start");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: BeforeAgentStartEvent = { type: "before_agent_start", prompt, images };
					const handlerResult = await handler(event, ctx);

					// Take the first message returned
					// 只采用第一个返回的消息，后续 hook 的结果忽略
					if (handlerResult && (handlerResult as BeforeAgentStartEventResult).message && !result) {
						result = handlerResult as BeforeAgentStartEventResult;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					this.emitError({
						hookPath: hook.path,
						event: "before_agent_start",
						error: message,
					});
				}
			}
		}

		return result;
	}
}


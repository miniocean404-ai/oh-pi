
/**
 * Hook loader - loads TypeScript hook modules using native Bun import.
 * Hook 加载器 —— 通过 Bun 原生 import 加载 TypeScript hook 模块。
 */
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import * as zod from "zod/v4";
import { hookCapability } from "../../capability/hook";
import type { Hook } from "../../discovery";
import { loadCapability } from "../../discovery";
import type { HookMessage } from "../../session/messages";
import type { SessionManager } from "../../session/session-manager";
import * as typebox from "../typebox";
import { resolvePath } from "../utils";
import { execCommand } from "./runner";
import type { ExecOptions, HookAPI, HookFactory, HookMessageRenderer, RegisteredCommand } from "./types";

/**
 * Generic handler function type.
 * 通用的处理器函数类型。
 */
type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Send message handler type for pi.sendMessage().
 * `pi.sendMessage()` 实际执行处理器的签名。
 */
export type SendMessageHandler = <T = unknown>(
	message: Pick<HookMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
) => void;

/**
 * Append entry handler type for pi.appendEntry().
 * `pi.appendEntry()` 实际执行处理器的签名。
 */
export type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

/**
 * New session handler type for ctx.newSession() in HookCommandContext.
 * HookCommandContext 中 `ctx.newSession()` 处理器签名。
 */
export type NewSessionHandler = (options?: {
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

/**
 * Branch handler type for ctx.branch() in HookCommandContext.
 * HookCommandContext 中 `ctx.branch()` 处理器签名。
 */
export type BranchHandler = (entryId: string) => Promise<{ cancelled: boolean }>;

/**
 * Navigate tree handler type for ctx.navigateTree() in HookCommandContext.
 * HookCommandContext 中 `ctx.navigateTree()` 处理器签名。
 */
export type NavigateTreeHandler = (
	targetId: string,
	options?: { summarize?: boolean },
) => Promise<{ cancelled: boolean }>;

/**
 * Registered handlers for a loaded hook.
 * 已加载 hook 注册的处理器集合。
 */
export interface LoadedHook {
	/** Original path from config */
	path: string;
	/** Resolved absolute path */
	resolvedPath: string;
	/** Map of event type to handler functions */
	handlers: Map<string, HandlerFn[]>;
	/** Map of customType to hook message renderer */
	messageRenderers: Map<string, HookMessageRenderer>;
	/** Map of command name to registered command */
	commands: Map<string, RegisteredCommand>;
	/** Set the send message handler for this hook's pi.sendMessage() */
	setSendMessageHandler: (handler: SendMessageHandler) => void;
	/** Set the append entry handler for this hook's pi.appendEntry() */
	setAppendEntryHandler: (handler: AppendEntryHandler) => void;
}

/**
 * Result of loading hooks.
 * Hook 加载结果。
 */
export interface LoadHooksResult {
	/** Successfully loaded hooks */
	hooks: LoadedHook[];
	/** Errors encountered during loading */
	errors: Array<{ path: string; error: string }>;
}

/**
 * Create a HookAPI instance that collects handlers, renderers, and commands.
 * Returns the API, maps, and functions to set handlers later.
 *
 * 创建一个 HookAPI 实例，用于在工厂函数中收集事件处理器、消息渲染器和命令。
 * 返回 API 本身、各内部映射，以及稍后注入 sendMessage/appendEntry 处理器的函数。
 */
async function createHookAPI(
	handlers: Map<string, HandlerFn[]>,
	cwd: string,
): Promise<{
	api: HookAPI;
	messageRenderers: Map<string, HookMessageRenderer>;
	commands: Map<string, RegisteredCommand>;
	setSendMessageHandler: (handler: SendMessageHandler) => void;
	setAppendEntryHandler: (handler: AppendEntryHandler) => void;
}> {
	let sendMessageHandler: SendMessageHandler | null = null;
	let appendEntryHandler: AppendEntryHandler | null = null;
	const messageRenderers = new Map<string, HookMessageRenderer>();
	const commands = new Map<string, RegisteredCommand>();

	// Cast to HookAPI - the implementation is more general (string event names)
	// but the interface has specific overloads for type safety in hooks
	// 强制转换为 HookAPI：实现接受任意字符串事件名，
	// 而对外接口提供了具体的重载以保证 hook 编写时的类型安全。
	const api = {
		on(event: string, handler: HandlerFn): void {
			if (!handlers.has(event)) {
				handlers.set(event, []);
			}
			handlers.get(event)!.push(handler);
		},
		sendMessage<T = unknown>(
			message: HookMessage<T>,
			options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
		): void {
			if (!sendMessageHandler) {
				throw new Error("sendMessage handler not initialized");
			}
			sendMessageHandler(message, options);
		},
		appendEntry<T = unknown>(customType: string, data?: T): void {
			if (!appendEntryHandler) {
				throw new Error("appendEntry handler not initialized");
			}
			appendEntryHandler(customType, data);
		},
		registerMessageRenderer<T = unknown>(customType: string, renderer: HookMessageRenderer<T>): void {
			messageRenderers.set(customType, renderer as HookMessageRenderer);
		},
		registerCommand(name: string, options: { description?: string; handler: RegisteredCommand["handler"] }): void {
			commands.set(name, { name, ...options });
		},
		exec(command: string, args: string[], options?: ExecOptions) {
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},
		logger,
		typebox,
		zod,
		pi: await import("@oh-my-pi/pi-coding-agent"),
	} as HookAPI;

	return {
		api,
		messageRenderers,
		commands,
		setSendMessageHandler: (handler: SendMessageHandler) => {
			sendMessageHandler = handler;
		},
		setAppendEntryHandler: (handler: AppendEntryHandler) => {
			appendEntryHandler = handler;
		},
	};
}

/**
 * Load a single hook module using native Bun import.
 * 通过 Bun 原生 import 加载单个 hook 模块。
 */
async function loadHook(hookPath: string, cwd: string): Promise<{ hook: LoadedHook | null; error: string | null }> {
	const resolvedPath = resolvePath(hookPath, cwd);

	try {
		// Import the module using native Bun import
		// 通过 Bun 原生 import 引入模块
		const module = await import(resolvedPath);
		const factory = module.default as HookFactory;

		if (typeof factory !== "function") {
			return { hook: null, error: "Hook must export a default function" };
		}

		// Create handlers map and API
		// 创建处理器映射以及 HookAPI 实例
		const handlers = new Map<string, HandlerFn[]>();
		const { api, messageRenderers, commands, setSendMessageHandler, setAppendEntryHandler } = await createHookAPI(
			handlers,
			cwd,
		);

		// Call factory to register handlers
		// 调用工厂函数，让 hook 完成 handler/renderer/command 注册
		factory(api);

		return {
			hook: {
				path: hookPath,
				resolvedPath,
				handlers,
				messageRenderers,
				commands,
				setSendMessageHandler,
				setAppendEntryHandler,
			},
			error: null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { hook: null, error: `Failed to load hook: ${message}` };
	}
}

/**
 * Load all hooks from configuration.
 * @param paths - Array of hook file paths
 * @param cwd - Current working directory for resolving relative paths
 *
 * 根据配置批量加载 hooks。
 * @param paths - hook 文件路径列表
 * @param cwd - 用于解析相对路径的当前工作目录
 */
export async function loadHooks(paths: string[], cwd: string): Promise<LoadHooksResult> {
	const hooks: LoadedHook[] = [];
	const errors: Array<{ path: string; error: string }> = [];

	for (const hookPath of paths) {
		const { hook, error } = await loadHook(hookPath, cwd);

		if (error) {
			errors.push({ path: hookPath, error });
			continue;
		}

		if (hook) {
			hooks.push(hook);
		}
	}

	return { hooks, errors };
}

/**
 * Discover and load hooks from all registered providers.
 * Uses the capability API to discover hook paths from:
 * 1. OMP native configs (.omp/.pi hooks/)
 * 2. Installed plugins
 * 3. Other editor/IDE configurations
 *
 * Plus any explicitly configured paths from settings.
 *
 * 从所有已注册 provider 发现并加载 hooks。
 * 通过 capability API 发现来自以下来源的 hook 路径：
 * 1. OMP 原生配置（.omp/.pi 的 hooks/ 目录）
 * 2. 已安装的插件
 * 3. 其他编辑器/IDE 配置
 *
 * 同时加上 settings 中显式配置的路径。
 */
export async function discoverAndLoadHooks(configuredPaths: string[], cwd: string): Promise<LoadHooksResult> {
	const allPaths: string[] = [];
	const seen = new Set<string>();

	// Helper to add paths without duplicates
	// 去重后追加路径
	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	// 1. Discover hooks via capability API
	// 1. 通过 capability API 发现 hook
	const discovered = await loadCapability<Hook>(hookCapability.id, { cwd });
	addPaths(discovered.items.map(hook => hook.path));

	// 2. Explicitly configured paths (can override/add)
	// 2. 显式配置的路径（可追加或覆盖）
	addPaths(configuredPaths.map(p => resolvePath(p, cwd)));

	return loadHooks(allPaths, cwd);
}


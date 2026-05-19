
/**
 * MCP Server Manager.
 * MCP 服务器管理器。
 *
 * Discovers, connects to, and manages MCP servers.
 * Handles tool loading and lifecycle.
 * 发现、连接和管理 MCP 服务器。处理工具加载和生命周期。
 */
import * as path from "node:path";
import * as url from "node:url";
import type { TSchema } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { SourceMeta } from "../capability/types";
import { resolveConfigValue } from "../config/resolve-config-value";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { AuthStorage } from "../session/auth-storage";
import {
	connectToServer,
	disconnectServer,
	getPrompt,
	listPrompts,
	listResources,
	listResourceTemplates,
	listTools,
	readResource,
	serverSupportsPrompts,
	serverSupportsResources,
	subscribeToResources,
	unsubscribeFromResources,
} from "./client";
import { loadAllMCPConfigs, validateServerConfig } from "./config";
import { refreshMCPOAuthToken } from "./oauth-flow";
import type { MCPToolDetails } from "./tool-bridge";
import { DeferredMCPTool, MCPTool } from "./tool-bridge";
import type { MCPToolCache } from "./tool-cache";
import { HttpTransport } from "./transports/http";
import type {
	MCPGetPromptResult,
	MCPPrompt,
	MCPRequestOptions,
	MCPResource,
	MCPResourceReadResult,
	MCPResourceTemplate,
	MCPServerConfig,
	MCPServerConnection,
	MCPToolDefinition,
} from "./types";
import { MCPNotificationMethods } from "./types";

/** 工具加载结果 */
type ToolLoadResult = {
	/** 服务器连接 */
	connection: MCPServerConnection;
	/** 服务器工具定义列表 */
	serverTools: MCPToolDefinition[];
};

/** 带状态追踪的 Promise 包装类型 */
type TrackedPromise<T> = {
	/** 原始 Promise */
	promise: Promise<T>;
	/** 当前状态 */
	status: "pending" | "fulfilled" | "rejected";
	/** 成功时的返回值 */
	value?: T;
	/** 失败时的错误原因 */
	reason?: unknown;
};

/** 启动超时时间（毫秒） */
const STARTUP_TIMEOUT_MS = 250;

/** 追踪 Promise 的状态和结果 */
function trackPromise<T>(promise: Promise<T>): TrackedPromise<T> {
	const tracked: TrackedPromise<T> = { promise, status: "pending" };
	promise.then(
		value => {
			tracked.status = "fulfilled";
			tracked.value = value;
		},
		reason => {
			tracked.status = "rejected";
			tracked.reason = reason;
		},
	);
	return tracked;
}

/** 延迟指定毫秒数 */
function delay(ms: number): Promise<void> {
	return Bun.sleep(ms);
}

/**
 * Stable, total ordering on MCP tools by name.
 * 按名称对 MCP 工具进行稳定的全序排序。
 *
 * Anthropic prompt caching keys on byte-identical tool definitions: any reorder
 * of the tools array invalidates the tools cache breakpoint and forces a full
 * prefix rebuild on the next request. MCP servers connect/reconnect at arbitrary
 * times, so the natural "insertion order" of `#tools` is non-deterministic.
 * Sorting after every mutation makes the array bytes independent of connection
 * sequence.
 * Anthropic 提示词缓存基于字节一致的工具定义：工具数组的任何重排都会使缓存断点失效，
 * 并在下次请求时强制完整的前缀重建。MCP 服务器在任意时间连接/重连，
 * 因此 `#tools` 的自然"插入顺序"是不确定的。每次变更后排序使数组字节与连接顺序无关。
 */
export function sortMCPToolsByName<T extends { name: string }>(tools: T[]): T[] {
	tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return tools;
}

/**
 * 解析订阅后续动作。
 * 根据通知启用状态和 epoch 决定是回滚、忽略还是应用订阅。
 */
export function resolveSubscriptionPostAction(
	notificationsEnabled: boolean,
	currentEpoch: number,
	subscriptionEpoch: number,
): "rollback" | "ignore" | "apply" {
	if (!notificationsEnabled) return "rollback";
	if (currentEpoch !== subscriptionEpoch) return "ignore";
	return "apply";
}
/** Result of loading MCP tools */
/** MCP 工具加载结果 */
export interface MCPLoadResult {
	/** Loaded tools as CustomTool instances */
	/** 加载的工具（CustomTool 实例列表） */
	tools: CustomTool<TSchema, MCPToolDetails>[];
	/** Connection errors by server name */
	/** 按服务器名称索引的连接错误 */
	errors: Map<string, string>;
	/** Connected server names */
	/** 已连接的服务器名称列表 */
	connectedServers: string[];
	/** Extracted Exa API keys from filtered MCP servers */
	/** 从过滤的 MCP 服务器中提取的 Exa API 密钥 */
	exaApiKeys: string[];
}

/** Options for discovering and connecting to MCP servers */
/** MCP 服务器发现和连接选项 */
export interface MCPDiscoverOptions {
	/** Whether to load project-level config (default: true) */
	/** 是否加载项目级配置（默认：true） */
	enableProjectConfig?: boolean;
	/** Whether to filter out Exa MCP servers (default: true) */
	/** 是否过滤 Exa MCP 服务器（默认：true） */
	filterExa?: boolean;
	/** Whether to filter out browser MCP servers when builtin browser tool is enabled (default: false) */
	/** 当内置浏览器工具启用时是否过滤浏览器 MCP 服务器（默认：false） */
	filterBrowser?: boolean;
	/** Called when starting to connect to servers */
	/** 开始连接服务器时的回调 */
	onConnecting?: (serverNames: string[]) => void;
}

/**
 * MCP Server Manager.
 * MCP 服务器管理器。
 *
 * Manages connections to MCP servers and provides tools to the agent.
 * 管理与 MCP 服务器的连接，并为 Agent 提供工具。
 */
export class MCPManager {
	static #instance: MCPManager | undefined;

	/** Process-global instance shared by internal URL protocol handlers and tools. */
	/** 进程全局实例，供内部 URL 协议处理器和工具共享。 */
	static instance(): MCPManager | undefined {
		return MCPManager.#instance;
	}

	/** Install or clear the process-global instance. */
	/** 设置或清除进程全局实例。 */
	static setInstance(value: MCPManager | undefined): void {
		MCPManager.#instance = value;
	}

	/** Reset the process-global instance. Test-only. */
	/** 重置进程全局实例。仅用于测试。 */
	static resetForTests(): void {
		MCPManager.#instance = undefined;
	}

	/** 已建立的服务器连接 */
	#connections = new Map<string, MCPServerConnection>();
	/** 已加载的工具列表 */
	#tools: CustomTool<TSchema, MCPToolDetails>[] = [];
	/** 正在进行的连接 Promise */
	#pendingConnections = new Map<string, Promise<MCPServerConnection>>();
	/** 正在进行的工具加载 Promise */
	#pendingToolLoads = new Map<string, Promise<ToolLoadResult>>();
	/** 服务器来源元数据 */
	#sources = new Map<string, SourceMeta>();
	/** 认证存储 */
	#authStorage: AuthStorage | null = null;
	/** 服务器通知回调 */
	#onNotification?: (serverName: string, method: string, params: unknown) => void;
	/** 工具变更回调 */
	#onToolsChanged?: (tools: CustomTool<TSchema, MCPToolDetails>[]) => void;
	/** 资源变更回调 */
	#onResourcesChanged?: (serverName: string, uri: string) => void;
	/** 提示词变更回调 */
	#onPromptsChanged?: (serverName: string) => void;
	/** 是否启用通知 */
	#notificationsEnabled = false;
	/** 通知 epoch（用于失效检测） */
	#notificationsEpoch = 0;
	/** 已订阅的资源（按服务器名称索引） */
	#subscribedResources = new Map<string, Set<string>>();
	/** 待处理的资源刷新 */
	#pendingResourceRefresh = new Map<string, { connection: MCPServerConnection; promise: Promise<void> }>();
	/** 待处理的重连 */
	#pendingReconnections = new Map<string, Promise<MCPServerConnection | null>>();
	/** Preserved configs for reconnection after connection loss. */
	/** 保留的配置，用于连接丢失后的重连。 */
	#serverConfigs = new Map<string, MCPServerConfig>();
	/** Monotonic epoch incremented on disconnectAll to invalidate stale reconnections. */
	/** 单调递增的 epoch，在 disconnectAll 时递增以使过期的重连失效。 */
	#epoch = 0;

	constructor(
		private cwd: string,
		private toolCache: MCPToolCache | null = null,
	) {}

	/**
	 * Set a callback to receive all server notifications.
	 * 设置接收所有服务器通知的回调。
	 */
	setOnNotification(handler: (serverName: string, method: string, params: unknown) => void): void {
		this.#onNotification = handler;
	}

	/**
	 * Set a callback to fire when any server's tools change.
	 * 设置任意服务器工具变更时触发的回调。
	 */
	setOnToolsChanged(handler: (tools: CustomTool<TSchema, MCPToolDetails>[]) => void): void {
		this.#onToolsChanged = handler;
	}

	/**
	 * Set a callback to fire when any server's resources change.
	 * 设置任意服务器资源变更时触发的回调。
	 */
	setOnResourcesChanged(handler: (serverName: string, uri: string) => void): void {
		this.#onResourcesChanged = handler;
	}

	/**
	 * Set a callback to fire when any server's prompts change.
	 * 设置任意服务器提示词变更时触发的回调。
	 */
	setOnPromptsChanged(handler: (serverName: string) => void): void {
		this.#onPromptsChanged = handler;
		// 对已加载提示词的服务器立即触发回调
		for (const [name, connection] of this.#connections) {
			if (connection.prompts?.length) {
				handler(name);
			}
		}
	}

	/** 订阅资源并追踪订阅状态 */
	#subscribeAndTrack(name: string, connection: MCPServerConnection, uris: string[], notificationEpoch: number): void {
		void subscribeToResources(connection, uris)
			.then(() => {
				const action = resolveSubscriptionPostAction(
					this.#notificationsEnabled,
					this.#notificationsEpoch,
					notificationEpoch,
				);
				if (action === "rollback") {
					void unsubscribeFromResources(connection, uris).catch(error => {
						logger.debug("Failed to rollback stale MCP resource subscription", {
							path: `mcp:${name}`,
							error,
						});
					});
					return;
				}
				if (action === "ignore") {
					return;
				}
				this.#subscribedResources.set(name, new Set(uris));
			})
			.catch(error => {
				logger.debug("Failed to subscribe to MCP resources", { path: `mcp:${name}`, error });
			});
	}

	/** 设置是否启用通知。启用时订阅所有已连接服务器的资源，禁用时取消订阅。 */
	setNotificationsEnabled(enabled: boolean): void {
		const wasEnabled = this.#notificationsEnabled;
		this.#notificationsEnabled = enabled;
		if (enabled === wasEnabled) return;

		this.#notificationsEpoch += 1;
		const notificationEpoch = this.#notificationsEpoch;

		if (enabled) {
			// 订阅所有支持资源订阅的已连接服务器
			for (const [name, connection] of this.#connections) {
				if (connection.capabilities.resources?.subscribe && connection.resources) {
					const uris = connection.resources.map(r => r.uri);
					this.#subscribeAndTrack(name, connection, uris, notificationEpoch);
				}
			}
			return;
		}

		// 取消所有服务器的订阅
		for (const [name, connection] of this.#connections) {
			const uris = this.#subscribedResources.get(name);
			if (uris && uris.size > 0) {
				void unsubscribeFromResources(connection, Array.from(uris)).catch(error => {
					logger.debug("Failed to unsubscribe MCP resources", { path: `mcp:${name}`, error });
				});
			}
		}
		this.#subscribedResources.clear();
	}

	/**
	 * Set the auth storage for resolving OAuth credentials.
	 * 设置用于解析 OAuth 凭据的认证存储。
	 */
	setAuthStorage(authStorage: AuthStorage): void {
		this.#authStorage = authStorage;
	}

	/**
	 * Discover and connect to all MCP servers from .mcp.json files.
	 * Returns tools and any connection errors.
	 * 从 .mcp.json 文件中发现并连接所有 MCP 服务器。返回工具和连接错误。
	 */
	async discoverAndConnect(options?: MCPDiscoverOptions): Promise<MCPLoadResult> {
		const { configs, exaApiKeys, sources } = await loadAllMCPConfigs(this.cwd, {
			enableProjectConfig: options?.enableProjectConfig,
			filterExa: options?.filterExa,
			filterBrowser: options?.filterBrowser,
		});
		const result = await this.connectServers(configs, sources, options?.onConnecting);
		result.exaApiKeys = exaApiKeys;
		return result;
	}

	/**
	 * Connect to specific MCP servers.
	 * Connections are made in parallel for faster startup.
	 * 连接到指定的 MCP 服务器。并行建立连接以加快启动速度。
	 */
	async connectServers(
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, SourceMeta>,
		onConnecting?: (serverNames: string[]) => void,
	): Promise<MCPLoadResult> {
		type ConnectionTask = {
			name: string;
			config: MCPServerConfig;
			tracked: TrackedPromise<ToolLoadResult>;
			toolsPromise: Promise<ToolLoadResult>;
		};

		const errors = new Map<string, string>();
		const connectedServers = new Set<string>();
		const allTools: CustomTool<TSchema, MCPToolDetails>[] = [];
		const reportedErrors = new Set<string>();
		let allowBackgroundLogging = false;

		// 准备连接任务
		const connectionTasks: ConnectionTask[] = [];

		for (const [name, config] of Object.entries(configs)) {
			if (sources[name]) {
				this.#sources.set(name, sources[name]);
				const existing = this.#connections.get(name);
				if (existing) {
					existing._source = sources[name];
				}
			}

			// 跳过已连接的服务器
			if (this.#connections.has(name)) {
				connectedServers.add(name);
				continue;
			}

			if (
				this.#pendingConnections.has(name) ||
				this.#pendingToolLoads.has(name) ||
				this.#pendingReconnections.has(name)
			) {
				continue;
			}

			// 验证配置
			const validationErrors = validateServerConfig(name, config);
			if (validationErrors.length > 0) {
				errors.set(name, validationErrors.join("; "));
				reportedErrors.add(name);
				continue;
			}

			// 提前保存配置，即使初始连接超时回退到缓存/延迟工具，重连仍可工作
			this.#serverConfigs.set(name, config);

			// 连接前解析认证配置，每个服务器并行处理
			const connectionPromise = (async () => {
				const resolvedConfig = await this.#resolveAuthConfig(config);
				return connectToServer(name, resolvedConfig, {
					onNotification: (method, params) => {
						this.#handleServerNotification(name, method, params);
					},
					onRequest: (method, params) => {
						return this.#handleServerRequest(method, params);
					},
				});
			})().then(
				connection => {
					// 存储原始配置（不含已解析的令牌），保持缓存键稳定并避免泄露轮换凭据
					connection.config = config;
					this.#serverConfigs.set(name, config);
					if (sources[name]) {
						connection._source = sources[name];
					}
					if (this.#pendingConnections.get(name) === connectionPromise) {
						this.#pendingConnections.delete(name);
						this.#connections.set(name, connection);
					}

					// 为 HTTP 传输注入认证刷新逻辑，使 401 错误触发令牌刷新
					if (connection.transport instanceof HttpTransport && config.auth?.type === "oauth") {
						connection.transport.onAuthError = async () => {
							const refreshed = await this.#resolveAuthConfig(config, true);
							if (refreshed.type === "http" || refreshed.type === "sse") {
								return refreshed.headers ?? null;
							}
							return null;
						};
					}

					// 传输关闭时重新建立连接（服务器重启、网络中断等场景）
					connection.transport.onClose = () => {
						logger.debug("MCP transport lost, triggering reconnect", { path: `mcp:${name}` });
						void this.reconnectServer(name);
					};

					return connection;
				},
				error => {
					if (this.#pendingConnections.get(name) === connectionPromise) {
						this.#pendingConnections.delete(name);
					}
					throw error;
				},
			);
			this.#pendingConnections.set(name, connectionPromise);

			const toolsPromise = connectionPromise.then(async connection => {
				const serverTools = await listTools(connection);
				return { connection, serverTools };
			});
			this.#pendingToolLoads.set(name, toolsPromise);

			const tracked = trackPromise(toolsPromise);
			connectionTasks.push({ name, config, tracked, toolsPromise });

			void toolsPromise
				.then(async ({ connection, serverTools }) => {
					if (this.#pendingToolLoads.get(name) !== toolsPromise) return;
					this.#pendingToolLoads.delete(name);
					const reconnect = () => this.reconnectServer(name);
					const customTools = MCPTool.fromTools(connection, serverTools, reconnect);
					this.#replaceServerTools(name, customTools);
					this.#onToolsChanged?.(this.#tools);
					void this.toolCache?.set(name, config, serverTools);

					await this.#loadServerResourcesAndPrompts(name, connection);
				})
				.catch(error => {
					if (this.#pendingToolLoads.get(name) !== toolsPromise) return;
					this.#pendingToolLoads.delete(name);
					if (!allowBackgroundLogging || reportedErrors.has(name)) return;
					const message = error instanceof Error ? error.message : String(error);
					logger.error("MCP tool load failed", { path: `mcp:${name}`, error: message });
				});
		}

		// 通知正在连接的服务器
		if (connectionTasks.length > 0 && onConnecting) {
			onConnecting(connectionTasks.map(task => task.name));
		}

		if (connectionTasks.length > 0) {
			await Promise.race([
				Promise.allSettled(connectionTasks.map(task => task.tracked.promise)),
				delay(STARTUP_TIMEOUT_MS),
			]);

			const cachedTools = new Map<string, MCPToolDefinition[]>();
			const pendingTasks = connectionTasks.filter(task => task.tracked.status === "pending");

			if (pendingTasks.length > 0) {
				if (this.toolCache) {
					await Promise.all(
						pendingTasks.map(async task => {
							const cached = await this.toolCache?.get(task.name, task.config);
							if (cached) {
								cachedTools.set(task.name, cached);
							}
						}),
					);
				}

				const pendingWithoutCache = pendingTasks.filter(task => !cachedTools.has(task.name));
				if (pendingWithoutCache.length > 0) {
					await Promise.allSettled(pendingWithoutCache.map(task => task.tracked.promise));
				}
			}

			for (const task of connectionTasks) {
				const { name } = task;
				if (task.tracked.status === "fulfilled") {
					const value = task.tracked.value;
					if (!value) continue;
					const { connection, serverTools } = value;
					connectedServers.add(name);
					const reconnect = () => this.reconnectServer(name);
					allTools.push(...MCPTool.fromTools(connection, serverTools, reconnect));
				} else if (task.tracked.status === "rejected") {
					const message =
						task.tracked.reason instanceof Error ? task.tracked.reason.message : String(task.tracked.reason);
					errors.set(name, message);
					reportedErrors.add(name);
				} else {
					const cached = cachedTools.get(name);
					if (cached) {
						const source = this.#sources.get(name);
						const reconnect = () => this.reconnectServer(name);
						allTools.push(
							...DeferredMCPTool.fromTools(name, cached, () => this.waitForConnection(name), source, reconnect),
						);
					}
				}
			}
		}

		// 按名称稳定排序，使顺序与连接完成顺序无关。
		// 参见 `sortMCPToolsByName` 了解缓存稳定性的原因。
		sortMCPToolsByName(allTools);

		// 更新缓存的工具
		this.#tools = allTools;
		allowBackgroundLogging = true;

		return {
			tools: allTools,
			errors,
			connectedServers: Array.from(connectedServers),
			exaApiKeys: [], // Will be populated by discoverAndConnect
		};
	}

	/** 替换指定服务器的工具列表 */
	#replaceServerTools(name: string, tools: CustomTool<TSchema, MCPToolDetails>[]): void {
		this.#tools = this.#tools.filter(t => !t.name.startsWith(`mcp__${name}_`));
		this.#tools.push(...tools);
		// 按名称稳定排序，使重连顺序不影响数组。
		// 参见 `sortMCPToolsByName` 了解缓存稳定性的原因。
		sortMCPToolsByName(this.#tools);
	}

	/** 触发通知驱动的刷新（工具/资源/提示词） */
	#triggerNotificationRefresh(serverName: string, kind: "tools" | "resources" | "prompts"): void {
		const refresh = (() => {
			switch (kind) {
				case "tools":
					return this.refreshServerTools(serverName);
				case "resources":
					return this.refreshServerResources(serverName);
				case "prompts":
					return this.refreshServerPrompts(serverName);
			}
		})();
		void refresh.catch(error => {
			logger.debug("Failed MCP notification refresh", { path: `mcp:${serverName}`, kind, error });
		});
	}
	/** 处理服务器通知消息 */
	#handleServerNotification(serverName: string, method: string, params: unknown): void {
		logger.debug("MCP notification received", { path: `mcp:${serverName}`, method });

		switch (method) {
			case MCPNotificationMethods.TOOLS_LIST_CHANGED:
				this.#triggerNotificationRefresh(serverName, "tools");
				break;
			case MCPNotificationMethods.RESOURCES_LIST_CHANGED:
				this.#triggerNotificationRefresh(serverName, "resources");
				break;
			case MCPNotificationMethods.RESOURCES_UPDATED: {
				const uri = (params as { uri?: string })?.uri;
				const subscribed = this.#subscribedResources.get(serverName);
				if (uri && subscribed?.has(uri)) {
					this.#onResourcesChanged?.(serverName, uri);
				}
				break;
			}
			case MCPNotificationMethods.PROMPTS_LIST_CHANGED:
				this.#triggerNotificationRefresh(serverName, "prompts");
				break;
			default:
				break;
		}

		this.#onNotification?.(serverName, method, params);
	}

	/** Handle server-to-client JSON-RPC requests (e.g. ping, roots/list). */
	/** 处理服务器到客户端的 JSON-RPC 请求（如 ping、roots/list）。 */
	async #handleServerRequest(method: string, _params: unknown): Promise<unknown> {
		switch (method) {
			case "ping":
				return {};
			case "roots/list":
				return this.#getRoots();
			default:
				throw Object.assign(new Error(`Unsupported server request: ${method}`), { code: -32601 });
		}
	}

	/** 获取项目根目录列表 */
	#getRoots(): { roots: Array<{ uri: string; name: string }> } {
		return {
			roots: [
				{
					uri: url.pathToFileURL(this.cwd).href,
					name: path.basename(this.cwd),
				},
			],
		};
	}

	/**
	 * Get all loaded tools.
	 * 获取所有已加载的工具。
	 */
	getTools(): CustomTool<TSchema, MCPToolDetails>[] {
		return this.#tools;
	}

	/**
	 * Get a specific connection.
	 * 获取指定名称的连接。
	 */
	getConnection(name: string): MCPServerConnection | undefined {
		return this.#connections.get(name);
	}

	/**
	 * Get current connection status for a server.
	 * 获取服务器的当前连接状态。
	 */
	getConnectionStatus(name: string): "connected" | "connecting" | "disconnected" {
		if (this.#connections.has(name)) return "connected";
		if (
			this.#pendingConnections.has(name) ||
			this.#pendingToolLoads.has(name) ||
			this.#pendingReconnections.has(name)
		)
			return "connecting";
		return "disconnected";
	}

	/**
	 * Get the source metadata for a server.
	 * 获取服务器的来源元数据。
	 */
	getSource(name: string): SourceMeta | undefined {
		return this.#sources.get(name) ?? this.#connections.get(name)?._source;
	}

	/**
	 * Wait for a connection to complete (or fail).
	 * 等待连接完成（或失败）。
	 */
	async waitForConnection(name: string): Promise<MCPServerConnection> {
		const connection = this.#connections.get(name);
		if (connection) return connection;
		const pending = this.#pendingConnections.get(name);
		if (pending) return pending;
		// 如果正在进行重连，等待其完成
		const reconnecting = this.#pendingReconnections.get(name);
		if (reconnecting) {
			const result = await reconnecting;
			if (result) return result;
		}
		throw new Error(`MCP server not connected: ${name}`);
	}

	/**
	 * Resolve auth and shell-command substitutions in config before connecting.
	 * 连接前解析配置中的认证和 shell 命令替换。
	 */
	async prepareConfig(config: MCPServerConfig): Promise<MCPServerConfig> {
		return this.#resolveAuthConfig(config);
	}

	/**
	 * Get all connected server names.
	 * 获取所有已连接的服务器名称。
	 */
	getConnectedServers(): string[] {
		return Array.from(this.#connections.keys());
	}

	/**
	 * Get all known server names (connected, connecting, or discovered).
	 * 获取所有已知的服务器名称（已连接、连接中或已发现）。
	 */
	getAllServerNames(): string[] {
		return Array.from(
			new Set([...this.#sources.keys(), ...this.#connections.keys(), ...this.#pendingConnections.keys()]),
		);
	}

	/**
	 * Disconnect from a specific server.
	 * 断开与指定服务器的连接。
	 */
	async disconnectServer(name: string): Promise<void> {
		this.#pendingConnections.delete(name);
		this.#pendingToolLoads.delete(name);
		this.#pendingReconnections.delete(name);
		this.#sources.delete(name);
		this.#serverConfigs.delete(name);
		this.#pendingResourceRefresh.delete(name);

		const connection = this.#connections.get(name);

		const subscribedUris = this.#subscribedResources.get(name);
		if (subscribedUris && subscribedUris.size > 0 && connection) {
			void unsubscribeFromResources(connection, Array.from(subscribedUris)).catch(() => {});
		}
		this.#subscribedResources.delete(name);

		if (connection) {
			// 分离 onClose 以防止 close() 触发错误的重连
			connection.transport.onClose = undefined;
			await disconnectServer(connection);
			this.#connections.delete(name);
		}

		// 移除该服务器的工具并通知消费者
		const hadTools = this.#tools.some(t => t.name.startsWith(`mcp__${name}_`));
		this.#tools = this.#tools.filter(t => !t.name.startsWith(`mcp__${name}_`));
		if (hadTools) this.#onToolsChanged?.(this.#tools);

		// 通知提示词消费者以清除过期的命令
		if (connection?.prompts?.length) this.#onPromptsChanged?.(name);
	}

	/**
	 * Disconnect from all servers.
	 * 断开与所有服务器的连接。
	 */
	async disconnectAll(): Promise<void> {
		// 使所有正在进行的重连尝试失效。
		// 它们捕获了旧的 epoch；递增后将检测到过期。
		this.#epoch++;
		// 关闭前分离 onClose 以防止错误的重连尝试
		for (const conn of this.#connections.values()) {
			conn.transport.onClose = undefined;
		}
		const promises = Array.from(this.#connections.values()).map(conn => disconnectServer(conn));
		await Promise.allSettled(promises);

		this.#pendingConnections.clear();
		this.#pendingToolLoads.clear();
		this.#pendingReconnections.clear();
		this.#pendingResourceRefresh.clear();
		this.#sources.clear();
		this.#serverConfigs.clear();
		this.#connections.clear();
		this.#tools = [];
		this.#subscribedResources.clear();
	}

	/**
	 * Reconnect to a server after a connection failure.
	 * Tears down the stale connection, re-resolves auth, establishes a new
	 * connection, reloads tools, and notifies consumers.
	 * Concurrent calls for the same server share one reconnection attempt.
	 * Returns the new connection, or null if reconnection failed.
	 * 连接失败后重连服务器。拆除过期连接、重新解析认证、建立新连接、
	 * 重新加载工具并通知消费者。同一服务器的并发调用共享一次重连尝试。
	 * 返回新连接，若重连失败则返回 null。
	 */
	async reconnectServer(name: string): Promise<MCPServerConnection | null> {
		const pending = this.#pendingReconnections.get(name);
		if (pending) return pending;

		const attempt = this.#doReconnect(name);
		this.#pendingReconnections.set(name, attempt);
		return attempt.finally(() => this.#pendingReconnections.delete(name));
	}

	/** 执行实际的重连逻辑，支持带退避的重试 */
	async #doReconnect(name: string): Promise<MCPServerConnection | null> {
		const oldConnection = this.#connections.get(name);
		const config = oldConnection?.config ?? this.#serverConfigs.get(name);
		const source = this.#sources.get(name) ?? oldConnection?._source;
		if (!config) return null;

		logger.debug("MCP reconnecting", { path: `mcp:${name}` });

		// 关闭旧传输但不移除工具或通知消费者。
		// 在建立新连接期间，工具保持可用（过期状态）。
		// 即发即忘：不等待 close — HttpTransport.close() 发送
		// 带 config.timeout（默认 30 秒）的 DELETE 请求，
		// 阻塞等待会在每次服务器重启时延迟重连循环。
		const reconnectEpoch = this.#epoch;
		if (oldConnection) {
			// 分离 onClose 以防止 close 自身触发重入式重连
			oldConnection.transport.onClose = undefined;
			void oldConnection.transport.close().catch(() => {});
			this.#connections.delete(name);
		}
		this.#pendingConnections.delete(name);
		this.#pendingToolLoads.delete(name);

		// 带退避重试 — 服务器可能仍在启动中
		const delays = [500, 1000, 2000, 4000];
		for (let attempt = 0; attempt <= delays.length; attempt++) {
			if (this.#epoch !== reconnectEpoch) {
				logger.debug("MCP reconnect aborted before attempt after configuration changed", {
					path: `mcp:${name}`,
					storedEpoch: reconnectEpoch,
					currentEpoch: this.#epoch,
				});
				return null;
			}
			try {
				const connection = await this.#connectAndWireServer(name, config, source, reconnectEpoch);
				logger.debug("MCP reconnected", { path: `mcp:${name}`, tools: connection.tools?.length ?? 0 });
				return connection;
			} catch (error) {
				if (this.#epoch !== reconnectEpoch) {
					logger.debug("MCP reconnect aborted after configuration changed", {
						path: `mcp:${name}`,
						storedEpoch: reconnectEpoch,
						currentEpoch: this.#epoch,
					});
					return null;
				}

				const msg = error instanceof Error ? error.message : String(error);
				if (attempt < delays.length) {
					logger.debug("MCP reconnect attempt failed, retrying", {
						path: `mcp:${name}`,
						attempt: attempt + 1,
						error: msg,
					});
					await Bun.sleep(delays[attempt]);
				} else {
					logger.error("MCP reconnect failed after retries", { path: `mcp:${name}`, error: msg });
					// 不移除过期工具 — 保留在注册表中使其仍可被选中。
					// 调用将失败并返回 MCP 错误，触发工具级重连，
					// 或用户可手动运行 /mcp reconnect <name>。
				}
			}
		}
		return null;
	}

	/** Establish a new connection to a server, wire handlers, load tools. */
	/** 建立与服务器的新连接，注册处理器，加载工具。 */
	async #connectAndWireServer(
		name: string,
		config: MCPServerConfig,
		source: SourceMeta | undefined,
		reconnectEpoch: number,
	): Promise<MCPServerConnection> {
		const resolvedConfig = await this.#resolveAuthConfig(config);
		const connection = await connectToServer(name, resolvedConfig, {
			onNotification: (method, params) => {
				this.#handleServerNotification(name, method, params);
			},
			onRequest: (method, params) => {
				return this.#handleServerRequest(method, params);
			},
		});

		connection.config = config;
		if (source) connection._source = source;

		// 如果在连接过程中服务器被断开或管理器被重置（如 /mcp reload 调用了 disconnectAll），则中止
		if (!this.#serverConfigs.has(name) || this.#epoch !== reconnectEpoch) {
			await connection.transport.close().catch(() => {});
			throw new Error(`Server "${name}" was disconnected during reconnection`);
		}

		this.#connections.set(name, connection);

		// 为 HTTP 传输注入认证刷新逻辑，为任意传输注入重连逻辑
		if (connection.transport instanceof HttpTransport && config.auth?.type === "oauth") {
			connection.transport.onAuthError = async () => {
				const refreshed = await this.#resolveAuthConfig(config, true);
				if (refreshed.type === "http" || refreshed.type === "sse") {
					return refreshed.headers ?? null;
				}
				return null;
			};
		}
		connection.transport.onClose = () => {
			logger.debug("MCP transport lost, triggering reconnect", { path: `mcp:${name}` });
			void this.reconnectServer(name);
		};
		try {
			const serverTools = await listTools(connection);
			const reconnect = () => this.reconnectServer(name);
			const customTools = MCPTool.fromTools(connection, serverTools, reconnect);
			void this.toolCache?.set(name, config, serverTools);
			this.#replaceServerTools(name, customTools);
			this.#onToolsChanged?.(this.#tools);
			void this.#loadServerResourcesAndPrompts(name, connection);
			return connection;
		} catch (error) {
			// 清理连接以避免僵尸传输
			connection.transport.onClose = undefined;
			await connection.transport.close().catch(() => {});
			this.#connections.delete(name);
			throw error;
		}
	}

	/**
	 * Best-effort loading of resources, resource subscriptions, and prompts.
	 * Shared between initial connection and reconnection.
	 * 尽力加载资源、资源订阅和提示词。初始连接和重连共享此逻辑。
	 */
	async #loadServerResourcesAndPrompts(name: string, connection: MCPServerConnection): Promise<void> {
		if (serverSupportsResources(connection.capabilities)) {
			try {
				const [resources] = await Promise.all([listResources(connection), listResourceTemplates(connection)]);

				if (this.#notificationsEnabled && connection.capabilities.resources?.subscribe) {
					const uris = resources.map(r => r.uri);
					const notificationEpoch = this.#notificationsEpoch;
					this.#subscribeAndTrack(name, connection, uris, notificationEpoch);
				}
			} catch (error) {
				logger.debug("Failed to load MCP resources", { path: `mcp:${name}`, error });
			}
		}

		if (serverSupportsPrompts(connection.capabilities)) {
			try {
				await listPrompts(connection);
				this.#onPromptsChanged?.(name);
			} catch (error) {
				logger.debug("Failed to load MCP prompts", { path: `mcp:${name}`, error });
			}
		}
	}

	/**
	 * Refresh tools from a specific server.
	 * 刷新指定服务器的工具列表。
	 */
	async refreshServerTools(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection) return;

		// 清除缓存的工具
		connection.tools = undefined;

		// 重新加载工具
		const serverTools = await listTools(connection);
		const reconnect = () => this.reconnectServer(name);
		const customTools = MCPTool.fromTools(connection, serverTools, reconnect);
		void this.toolCache?.set(name, connection.config, serverTools);

		// 替换该服务器的工具
		this.#replaceServerTools(name, customTools);
		this.#onToolsChanged?.(this.#tools);
	}

	/**
	 * Refresh tools from all servers.
	 * 刷新所有服务器的工具列表。
	 */
	async refreshAllTools(): Promise<void> {
		const promises = Array.from(this.#connections.keys()).map(name => this.refreshServerTools(name));
		await Promise.allSettled(promises);
	}

	/**
	 * Refresh resources from a specific server.
	 * 刷新指定服务器的资源列表。
	 */
	async refreshServerResources(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection || !serverSupportsResources(connection.capabilities)) return;

		const existing = this.#pendingResourceRefresh.get(name);
		if (existing && existing.connection === connection) return existing.promise;

		const doRefresh = async (): Promise<void> => {
			// 清除缓存的资源
			connection.resources = undefined;
			connection.resourceTemplates = undefined;

			// 重新加载
			const [resources] = await Promise.all([listResources(connection), listResourceTemplates(connection)]);
			if (this.#notificationsEnabled && connection.capabilities.resources?.subscribe) {
				const newUris = new Set(resources.map(r => r.uri));
				const oldUris = this.#subscribedResources.get(name);
				const notificationEpoch = this.#notificationsEpoch;

				// 取消已移除的 URI 的订阅
				if (oldUris) {
					const removed = [...oldUris].filter(uri => !newUris.has(uri));
					if (removed.length > 0) {
						try {
							await unsubscribeFromResources(connection, removed);
						} catch (error) {
							logger.debug("Failed to unsubscribe stale MCP resources", { path: `mcp:${name}`, error });
						}
					}
				}

				// 订阅当前集合并原子地更新追踪
				try {
					const allUris = [...newUris];
					await subscribeToResources(connection, allUris);
					const action = resolveSubscriptionPostAction(
						this.#notificationsEnabled,
						this.#notificationsEpoch,
						notificationEpoch,
					);
					if (action === "rollback") {
						await unsubscribeFromResources(connection, allUris).catch(error => {
							logger.debug("Failed to rollback stale MCP resource subscription", { path: `mcp:${name}`, error });
						});
						return;
					}
					if (action === "ignore") {
						return;
					}
					this.#subscribedResources.set(name, newUris);
				} catch (error) {
					logger.debug("Failed to re-subscribe to MCP resources", { path: `mcp:${name}`, error });
				}
			}
		};

		const promise = doRefresh().finally(() => {
			const pending = this.#pendingResourceRefresh.get(name);
			if (pending?.promise === promise) {
				this.#pendingResourceRefresh.delete(name);
			}
		});
		this.#pendingResourceRefresh.set(name, { connection, promise });
		return promise;
	}

	/**
	 * Refresh prompts from a specific server.
	 * 刷新指定服务器的提示词列表。
	 */
	async refreshServerPrompts(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection || !serverSupportsPrompts(connection.capabilities)) return;

		connection.prompts = undefined;
		await listPrompts(connection);

		this.#onPromptsChanged?.(name);
	}

	/**
	 * Get resources and templates for a specific server.
	 * 获取指定服务器的资源和模板。
	 */
	getServerResources(name: string): { resources: MCPResource[]; templates: MCPResourceTemplate[] } | undefined {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return {
			resources: connection.resources ?? [],
			templates: connection.resourceTemplates ?? [],
		};
	}

	/**
	 * Read a specific resource from a server.
	 * 从服务器读取指定资源。
	 */
	async readServerResource(
		name: string,
		uri: string,
		options?: MCPRequestOptions,
	): Promise<MCPResourceReadResult | undefined> {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return readResource(connection, uri, options);
	}

	/**
	 * Get prompts for a specific server.
	 * 获取指定服务器的提示词列表。
	 */
	getServerPrompts(name: string): MCPPrompt[] | undefined {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return connection.prompts ?? [];
	}

	/**
	 * Get a specific prompt from a server.
	 * 从服务器获取并执行指定提示词。
	 */
	async executePrompt(
		name: string,
		promptName: string,
		args?: Record<string, string>,
		options?: MCPRequestOptions,
	): Promise<MCPGetPromptResult | undefined> {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return getPrompt(connection, promptName, args, options);
	}

	/**
	 * Get all server instructions (for system prompt injection).
	 * 获取所有服务器指令（用于系统提示词注入）。
	 */
	getServerInstructions(): Map<string, string> {
		const instructions = new Map<string, string>();
		for (const [name, connection] of this.#connections) {
			if (connection.instructions) {
				instructions.set(name, connection.instructions);
			}
		}
		return instructions;
	}

	/**
	 * Get notification state for display.
	 * 获取通知状态（用于显示）。
	 */
	getNotificationState(): { enabled: boolean; subscriptions: Map<string, ReadonlySet<string>> } {
		return {
			enabled: this.#notificationsEnabled,
			subscriptions: this.#subscribedResources as Map<string, ReadonlySet<string>>,
		};
	}

	/**
	 * Resolve OAuth credentials and shell commands in config.
	 * 解析配置中的 OAuth 凭据和 shell 命令。
	 */
	async #resolveAuthConfig(config: MCPServerConfig, forceRefresh = false): Promise<MCPServerConfig> {
		let resolved: MCPServerConfig = { ...config };

		const auth = config.auth;
		if (auth?.type === "oauth" && auth.credentialId && this.#authStorage) {
			const credentialId = auth.credentialId;
			try {
				let credential = this.#authStorage.get(credentialId);
				if (credential?.type === "oauth") {
					// 主动刷新：过期前 5 分钟的缓冲期
					// 强制刷新：在 401/403 认证错误时（令牌被撤销、时钟偏差、缺少过期时间）
					const REFRESH_BUFFER_MS = 5 * 60_000;
					const shouldRefresh =
						forceRefresh || (credential.expires && Date.now() >= credential.expires - REFRESH_BUFFER_MS);
					if (shouldRefresh && credential.refresh && auth.tokenUrl) {
						try {
							const refreshed = await refreshMCPOAuthToken(
								auth.tokenUrl,
								credential.refresh,
								auth.clientId,
								auth.clientSecret,
							);
							const refreshedCredential = { type: "oauth" as const, ...refreshed };
							await this.#authStorage.set(credentialId, refreshedCredential);
							credential = refreshedCredential;
						} catch (refreshError) {
							logger.warn("MCP OAuth refresh failed, using existing token", {
								credentialId,
								error: refreshError,
							});
						}
					}

					if (resolved.type === "http" || resolved.type === "sse") {
						resolved = {
							...resolved,
							headers: {
								...resolved.headers,
								Authorization: `Bearer ${credential.access}`,
							},
						};
					} else {
						resolved = {
							...resolved,
							env: {
								...resolved.env,
								OAUTH_ACCESS_TOKEN: credential.access,
							},
						};
					}
				}
			} catch (error) {
				logger.warn("Failed to resolve OAuth credential", { credentialId, error });
			}
		}

		if (resolved.type !== "http" && resolved.type !== "sse") {
			if (resolved.env) {
				const nextEnv: Record<string, string> = {};
				for (const [key, value] of Object.entries(resolved.env)) {
					const resolvedValue = await resolveConfigValue(value);
					if (resolvedValue) nextEnv[key] = resolvedValue;
				}
				resolved = { ...resolved, env: nextEnv };
			}
		} else {
			if (resolved.headers) {
				const nextHeaders: Record<string, string> = {};
				for (const [key, value] of Object.entries(resolved.headers)) {
					const resolvedValue = await resolveConfigValue(value);
					if (resolvedValue) nextHeaders[key] = resolvedValue;
				}
				resolved = { ...resolved, headers: nextHeaders };
			}
		}

		return resolved;
	}
}

/**
 * Create an MCP manager and discover servers.
 * Convenience function for quick setup.
 * 创建 MCP 管理器并发现服务器。快速设置的便捷函数。
 */
export async function createMCPManager(
	cwd: string,
	options?: MCPDiscoverOptions,
): Promise<{
	manager: MCPManager;
	result: MCPLoadResult;
}> {
	const manager = new MCPManager(cwd);
	const result = await manager.discoverAndConnect(options);
	return { manager, result };
}


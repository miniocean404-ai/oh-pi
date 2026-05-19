
/**
 * MCP Client.
 * MCP 客户端。
 *
 * Handles connection initialization, tool listing, and tool calling.
 * 处理连接初始化、工具列表获取和工具调用。
 */
import * as path from "node:path";
import * as url from "node:url";
import { getProjectDir, logger, withTimeout } from "@oh-my-pi/pi-utils";
import { createHttpTransport } from "./transports/http";
import { createStdioTransport } from "./transports/stdio";
import type {
	MCPGetPromptParams,
	MCPGetPromptResult,
	MCPHttpServerConfig,
	MCPInitializeParams,
	MCPInitializeResult,
	MCPPrompt,
	MCPPromptsListResult,
	MCPRequestOptions,
	MCPResource,
	MCPResourceReadParams,
	MCPResourceReadResult,
	MCPResourceSubscribeParams,
	MCPResourcesListResult,
	MCPResourceTemplate,
	MCPResourceTemplatesListResult,
	MCPServerCapabilities,
	MCPServerConfig,
	MCPServerConnection,
	MCPSseServerConfig,
	MCPStdioServerConfig,
	MCPToolCallParams,
	MCPToolCallResult,
	MCPToolDefinition,
	MCPToolsListResult,
	MCPTransport,
} from "./types";

/** MCP protocol version we support */
/** 我们支持的 MCP 协议版本 */
const PROTOCOL_VERSION = "2025-03-26";

/** Default connection timeout in ms */
/** 默认连接超时时间（毫秒） */
const CONNECTION_TIMEOUT_MS = 30_000;

/** Client info sent during initialization */
/** 初始化时发送的客户端信息 */
const CLIENT_INFO = {
	name: "omp-coding-agent",
	version: "1.0.0",
};

/**
 * Default handler for standard MCP server-to-client requests.
 * 标准 MCP 服务器到客户端请求的默认处理器。
 * Handles `ping` and `roots/list`; rejects unknown methods with -32601.
 * 处理 `ping` 和 `roots/list`；未知方法返回 -32601 错误。
 * Reads getProjectDir() at call time so the root stays stable even if
 * the process cwd changes during tool execution.
 * 在调用时读取 getProjectDir()，即使进程 cwd 在工具执行期间变更，根目录也保持稳定。
 */
async function defaultRequestHandler(method: string, _params: unknown): Promise<unknown> {
	switch (method) {
		case "ping":
			return {};
		case "roots/list": {
			const cwd = getProjectDir();
			return {
				roots: [{ uri: url.pathToFileURL(cwd).href, name: path.basename(cwd) }],
			};
		}
		default:
			throw Object.assign(new Error(`Unsupported server request: ${method}`), { code: -32601 });
	}
}

/**
 * Create a transport for the given server config.
 * 为给定的服务器配置创建传输层。
 */
async function createTransport(config: MCPServerConfig): Promise<MCPTransport> {
	const serverType = config.type ?? "stdio";

	switch (serverType) {
		case "stdio":
			return createStdioTransport(config as MCPStdioServerConfig);
		case "http":
		case "sse":
			return createHttpTransport(config as MCPHttpServerConfig | MCPSseServerConfig);
		default:
			throw new Error(`Unknown server type: ${serverType}`);
	}
}

/**
 * Initialize connection with MCP server.
 * 初始化与 MCP 服务器的连接。
 */
async function initializeConnection(
	transport: MCPTransport,
	options?: {
		signal?: AbortSignal;
		/** Called after the initialize response (which sets the session ID) but before notifications/initialized. */
		onInitialized?: () => void | Promise<void>;
	},
): Promise<MCPInitializeResult> {
	const params: MCPInitializeParams = {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: {
			roots: { listChanged: false },
		},
		clientInfo: CLIENT_INFO,
	};

	const result = await transport.request<MCPInitializeResult>(
		"initialize",
		params as unknown as Record<string, unknown>,
		{ signal: options?.signal },
	);

	if (options?.signal?.aborted) {
		throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted");
	}

	// 挂载点：传输层现在已从初始化响应中获取会话 ID。
	// 对于 HTTP，此时应打开 SSE 流，以便由 notifications/initialized
	// 触发的服务器到客户端请求（如 roots/list）能够被送达。
	await options?.onInitialized?.();

	// 发送 initialized 通知
	await transport.notify("notifications/initialized");

	return result;
}

/**
 * Connect to an MCP server.
 * 连接到 MCP 服务器。
 * Has a 30 second timeout to prevent blocking startup.
 * 设有 30 秒超时以防止阻塞启动。
 */
export async function connectToServer(
	name: string,
	config: MCPServerConfig,
	options?: {
		signal?: AbortSignal;
		onNotification?: (method: string, params: unknown) => void;
		onRequest?: (method: string, params: unknown) => Promise<unknown>;
	},
): Promise<MCPServerConnection> {
	const timeoutMs = config.timeout ?? CONNECTION_TIMEOUT_MS;
	let transport: MCPTransport | undefined;

	const connect = async (): Promise<MCPServerConnection> => {
		transport = await createTransport(config);
		if (options?.onNotification) {
			transport.onNotification = options.onNotification;
		}

		// 始终处理标准的 MCP 服务器到客户端请求（ping、roots/list）。
		// 初始化请求声明了 roots 能力，因此必须响应
		// roots/list —— 即使是短暂的测试连接也不例外。
		transport.onRequest = options?.onRequest ?? defaultRequestHandler;

		try {
			const initResult = await initializeConnection(transport, {
				signal: options?.signal,
				async onInitialized() {
					// 在发送 initialized 之前打开 SSE 流，以确保由 on_initialized
					// 触发的服务器到客户端请求（如 roots/list）能够被送达。
					if ("startSSEListener" in transport! && typeof transport!.startSSEListener === "function") {
						await (transport as { startSSEListener(): Promise<void> }).startSSEListener();
					}
				},
			});

			return {
				name,
				config,
				transport,
				serverInfo: initResult.serverInfo,
				capabilities: initResult.capabilities,
				instructions: initResult.instructions,
			};
		} catch (error) {
			await transport.close();
			throw error;
		}
	};

	try {
		return await withTimeout(
			connect(),
			timeoutMs,
			`Connection to MCP server "${name}" timed out after ${timeoutMs}ms`,
			options?.signal,
		);
	} catch (error) {
		// 如果 withTimeout 在 connect() 仍在等待时拒绝（超时/中止），
		// 传输层可能仍活跃且有打开的 SSE 监听器。关闭它。
		if (transport) {
			void transport.close().catch(() => {});
		}
		throw error;
	}
}

/**
 * List tools from a connected server.
 * 从已连接的服务器获取工具列表。
 */
export async function listTools(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPToolDefinition[]> {
	// 检查服务器是否支持工具
	if (!connection.capabilities.tools) {
		return [];
	}

	// 如果有缓存则返回缓存的工具
	if (connection.tools) {
		return connection.tools;
	}

	const allTools: MCPToolDefinition[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await connection.transport.request<MCPToolsListResult>("tools/list", params, options);
		allTools.push(...result.tools);
		cursor = result.nextCursor;
	} while (cursor);

	// 缓存工具列表
	connection.tools = allTools;

	return allTools;
}

/**
 * Call a tool on a connected server.
 * 调用已连接服务器上的工具。
 */
export async function callTool(
	connection: MCPServerConnection,
	toolName: string,
	args: Record<string, unknown> = {},
	options?: MCPRequestOptions,
): Promise<MCPToolCallResult> {
	const params: MCPToolCallParams = {
		name: toolName,
		arguments: args,
	};

	return connection.transport.request<MCPToolCallResult>(
		"tools/call",
		params as unknown as Record<string, unknown>,
		options,
	);
}

/**
 * Disconnect from a server.
 * 断开与服务器的连接。
 */
export async function disconnectServer(connection: MCPServerConnection): Promise<void> {
	await connection.transport.close();
}

/**
 * Check if a server supports tools.
 * 检查服务器是否支持工具。
 */
export function serverSupportsTools(capabilities: MCPServerCapabilities): boolean {
	return capabilities.tools !== undefined;
}

/**
 * List resources from a connected server.
 * 从已连接的服务器获取资源列表。
 */
export async function listResources(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPResource[]> {
	if (!connection.capabilities.resources) {
		return [];
	}

	if (connection.resources) {
		return connection.resources;
	}

	const allResources: MCPResource[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await connection.transport.request<MCPResourcesListResult>("resources/list", params, options);
		allResources.push(...result.resources);
		cursor = result.nextCursor;
	} while (cursor);

	connection.resources = allResources;
	return allResources;
}

/**
 * List resource templates from a connected server.
 * 从已连接的服务器获取资源模板列表。
 */
export async function listResourceTemplates(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPResourceTemplate[]> {
	if (!connection.capabilities.resources) {
		return [];
	}

	if (connection.resourceTemplates) {
		return connection.resourceTemplates;
	}

	const allTemplates: MCPResourceTemplate[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await connection.transport.request<MCPResourceTemplatesListResult>(
			"resources/templates/list",
			params,
			options,
		);
		allTemplates.push(...result.resourceTemplates);
		cursor = result.nextCursor;
	} while (cursor);

	connection.resourceTemplates = allTemplates;
	return allTemplates;
}

/**
 * Read a resource from a connected server.
 * 从已连接的服务器读取资源。
 */
export async function readResource(
	connection: MCPServerConnection,
	uri: string,
	options?: MCPRequestOptions,
): Promise<MCPResourceReadResult> {
	const params: MCPResourceReadParams = { uri };
	return connection.transport.request<MCPResourceReadResult>(
		"resources/read",
		params as unknown as Record<string, unknown>,
		options,
	);
}

/**
 * Subscribe to resource update notifications.
 * 订阅资源更新通知。
 */
export async function subscribeToResources(
	connection: MCPServerConnection,
	uris: string[],
	options?: MCPRequestOptions,
): Promise<void> {
	if (uris.length === 0 || !connection.capabilities.resources?.subscribe) return;
	const results = await Promise.allSettled(
		uris.map(uri => {
			const params: MCPResourceSubscribeParams = { uri };
			return connection.transport.request(
				"resources/subscribe",
				params as unknown as Record<string, unknown>,
				options,
			);
		}),
	);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("Failed to subscribe to MCP resource", { error: result.reason });
		}
	}
}

/**
 * Unsubscribe from resource update notifications.
 * 取消订阅资源更新通知。
 */
export async function unsubscribeFromResources(
	connection: MCPServerConnection,
	uris: string[],
	options?: MCPRequestOptions,
): Promise<void> {
	if (uris.length === 0 || !connection.capabilities.resources?.subscribe) return;
	const results = await Promise.allSettled(
		uris.map(uri => {
			const params: MCPResourceSubscribeParams = { uri };
			return connection.transport.request(
				"resources/unsubscribe",
				params as unknown as Record<string, unknown>,
				options,
			);
		}),
	);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("Failed to unsubscribe from MCP resource", { error: result.reason });
		}
	}
}

/**
 * Check if a server supports resource subscriptions.
 * 检查服务器是否支持资源订阅。
 */
export function serverSupportsResourceSubscriptions(capabilities: MCPServerCapabilities): boolean {
	return capabilities.resources?.subscribe === true;
}

/**
 * Check if a server supports resources.
 * 检查服务器是否支持资源。
 */
export function serverSupportsResources(capabilities: MCPServerCapabilities): boolean {
	return capabilities.resources !== undefined;
}

/**
 * List prompts from a connected server.
 * 从已连接的服务器获取提示词列表。
 */
export async function listPrompts(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPPrompt[]> {
	if (!connection.capabilities.prompts) {
		return [];
	}

	if (connection.prompts) {
		return connection.prompts;
	}

	const allPrompts: MCPPrompt[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await connection.transport.request<MCPPromptsListResult>("prompts/list", params, options);
		allPrompts.push(...result.prompts);
		cursor = result.nextCursor;
	} while (cursor);

	connection.prompts = allPrompts;
	return allPrompts;
}

/**
 * Get a specific prompt from a connected server.
 * 从已连接的服务器获取特定提示词。
 */
export async function getPrompt(
	connection: MCPServerConnection,
	name: string,
	args?: Record<string, string>,
	options?: MCPRequestOptions,
): Promise<MCPGetPromptResult> {
	const params: MCPGetPromptParams = { name };
	if (args && Object.keys(args).length > 0) {
		params.arguments = args;
	}

	return connection.transport.request<MCPGetPromptResult>(
		"prompts/get",
		params as unknown as Record<string, unknown>,
		options,
	);
}

/**
 * Check if a server supports prompts.
 * 检查服务器是否支持提示词。
 */
export function serverSupportsPrompts(capabilities: MCPServerCapabilities): boolean {
	return capabilities.prompts !== undefined;
}


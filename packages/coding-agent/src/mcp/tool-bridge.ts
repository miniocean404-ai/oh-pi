
/**
 * MCP to CustomTool bridge.
 * MCP 到 CustomTool 的桥接层。
 *
 * Converts MCP tool definitions to CustomTool format for the agent.
 * 将 MCP 工具定义转换为 Agent 使用的 CustomTool 格式。
 */
import type { AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { TSchema } from "@oh-my-pi/pi-ai";
import { normalizeSchemaForMCP } from "@oh-my-pi/pi-ai/utils/schema";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { SourceMeta } from "../capability/types";
import type {
	CustomTool,
	CustomToolContext,
	CustomToolResult,
	RenderResultOptions,
} from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import { callTool } from "./client";
import { renderMCPCall, renderMCPResult } from "./render";
import type { MCPContent, MCPServerConnection, MCPToolCallParams, MCPToolCallResult, MCPToolDefinition } from "./types";

/** Reconnect callback: tears down stale connection, returns new one or null. */
/** 重连回调：拆除过期连接，返回新连接或 null。 */
export type MCPReconnect = () => Promise<MCPServerConnection | null>;

/**
 * Network-level and stale-session errors that warrant a reconnect + single retry.
 * Conservative: only catches errors where the server is likely alive but the
 * connection object is stale (dead SSE, expired session, refused after restart).
 * 网络层和过期会话错误，值得重连并重试一次。
 * 保守策略：仅捕获服务器可能存活但连接对象过期的错误
 * （死掉的 SSE、过期会话、重启后拒绝连接）。
 */
const RETRIABLE_PATTERNS = [
	"econnrefused",
	"econnreset",
	"epipe",
	"enetunreach",
	"ehostunreach",
	"fetch failed",
	"transport not connected",
	"transport closed",
	"network error",
];

/** 判断错误是否为可重试的连接错误 */
export function isRetriableConnectionError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();
	// 过期会话（服务器已重启，旧会话 ID 不存在）
	if (/^http (404|502|503):/.test(msg)) return true;
	return RETRIABLE_PATTERNS.some(p => msg.includes(p));
}

/** MCP 工具参数类型 */
type MCPToolArgs = NonNullable<MCPToolCallParams["arguments"]>;

/** 规范化工具参数，确保返回对象类型 */
function normalizeToolArgs(value: unknown): MCPToolArgs {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	return value as MCPToolArgs;
}

/** Details included in MCP tool results for rendering */
/** MCP 工具结果中包含的详情信息，用于渲染 */
export interface MCPToolDetails {
	/** Server name */
	/** 服务器名称 */
	serverName: string;
	/** Original MCP tool name */
	/** 原始 MCP 工具名称 */
	mcpToolName: string;
	/** Whether the call resulted in an error */
	/** 调用是否产生了错误 */
	isError?: boolean;
	/** Raw content from MCP response */
	/** MCP 响应的原始内容 */
	rawContent?: MCPContent[];
	/** Provider ID (e.g., "claude", "mcp-json") */
	/** 提供商 ID（如 "claude"、"mcp-json"） */
	provider?: string;
	/** Provider display name (e.g., "Claude Code", "MCP Config") */
	/** 提供商显示名称（如 "Claude Code"、"MCP Config"） */
	providerName?: string;
}
/**
 * Format MCP content for LLM consumption.
 * 将 MCP 内容格式化为 LLM 可消费的文本。
 */
function formatMCPContent(content: MCPContent[]): string {
	const parts: string[] = [];

	for (const item of content) {
		switch (item.type) {
			case "text":
				parts.push(item.text);
				break;
			case "image":
				parts.push(`[Image: ${item.mimeType}]`);
				break;
			case "resource":
				if (item.resource.text) {
					parts.push(`[Resource: ${item.resource.uri}]\n${item.resource.text}`);
				} else {
					parts.push(`[Resource: ${item.resource.uri}]`);
				}
				break;
		}
	}

	return parts.join("\n\n");
}

/** Build a CustomToolResult from a callTool response. */
/** 从 callTool 响应构建 CustomToolResult。 */
function buildResult(
	result: MCPToolCallResult,
	serverName: string,
	mcpToolName: string,
	provider?: string,
	providerName?: string,
): CustomToolResult<MCPToolDetails> {
	const text = formatMCPContent(result.content);
	const details: MCPToolDetails = {
		serverName,
		mcpToolName,
		isError: result.isError,
		rawContent: result.content,
		provider,
		providerName,
	};
	if (result.isError) {
		return { content: [{ type: "text", text: `Error: ${text}` }], details };
	}
	return { content: [{ type: "text", text }], details };
}

/** Build an error CustomToolResult from a caught exception. */
/** 从捕获的异常构建错误 CustomToolResult。 */
function buildErrorResult(
	error: unknown,
	serverName: string,
	mcpToolName: string,
	provider?: string,
	providerName?: string,
): CustomToolResult<MCPToolDetails> {
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [{ type: "text", text: `MCP error: ${message}` }],
		details: { serverName, mcpToolName, isError: true, provider, providerName },
	};
}

/** Re-throw abort-related errors so they bypass error-result handling. */
/** 重新抛出中止相关的错误，使其绕过错误结果处理。 */
function rethrowIfAborted(error: unknown, signal?: AbortSignal): void {
	if (error instanceof ToolAbortError) throw error;
	if (error instanceof Error && error.name === "AbortError") throw new ToolAbortError();
	if (signal?.aborted) throw new ToolAbortError();
}

/** 支持中止信号的重连操作 */
async function reconnectWithAbort(reconnect: MCPReconnect, signal?: AbortSignal): Promise<MCPServerConnection | null> {
	try {
		return await untilAborted(signal, reconnect);
	} catch (error) {
		rethrowIfAborted(error, signal);
		return null;
	}
}

/**
 * Create a unique tool name for an MCP tool.
 * 为 MCP 工具创建唯一的工具名称。
 *
 * Prefixes with server name to avoid conflicts. If the tool name already
 * starts with the server name (e.g., server "puppeteer" with tool
 * "puppeteer_screenshot"), strips the redundant prefix to produce
 * "mcp__puppeteer_screenshot" instead of "mcp__puppeteer_puppeteer_screenshot".
 * 以服务器名称为前缀以避免冲突。如果工具名已以服务器名开头
 * （如服务器 "puppeteer" 的工具 "puppeteer_screenshot"），
 * 则去除冗余前缀，生成 "mcp__puppeteer_screenshot" 而非 "mcp__puppeteer_puppeteer_screenshot"。
 */
/** 清理 MCP 工具名称部分，仅保留小写字母和下划线 */
function sanitizeMCPToolNamePart(value: string, fallback: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

	return sanitized.length > 0 ? sanitized : fallback;
}

/** 根据服务器名和工具名创建 MCP 工具的唯一名称 */
export function createMCPToolName(serverName: string, toolName: string): string {
	const sanitizedServerName = sanitizeMCPToolNamePart(serverName, "server");
	const sanitizedToolName = sanitizeMCPToolNamePart(toolName, "tool");

	// 如果存在，去除工具名中冗余的服务器名前缀
	const prefixWithUnderscore = `${sanitizedServerName}_`;

	let normalizedToolName = sanitizedToolName;
	if (sanitizedToolName.startsWith(prefixWithUnderscore)) {
		normalizedToolName = sanitizedToolName.slice(prefixWithUnderscore.length);
	}

	return `mcp__${sanitizedServerName}_${normalizedToolName}`;
}

/**
 * Parse an MCP tool name back to server and tool components.
 * 将 MCP 工具名称解析回服务器名和工具名组件。
 *
 * Note: This returns the normalized tool name (with server prefix stripped).
 * The original MCP tool name may have had the server name as a prefix.
 * 注意：返回的是规范化后的工具名（已去除服务器名前缀）。
 * 原始 MCP 工具名可能以服务器名作为前缀。
 */
export function parseMCPToolName(name: string): { serverName: string; toolName: string } | null {
	if (!name.startsWith("mcp__")) return null;

	const rest = name.slice(5);
	const underscoreIdx = rest.indexOf("_");
	if (underscoreIdx === -1) return null;

	return {
		serverName: rest.slice(0, underscoreIdx),
		toolName: rest.slice(underscoreIdx + 1),
	};
}

/**
 * CustomTool wrapping an MCP tool with an active connection.
 * 包装 MCP 工具并持有活跃连接的 CustomTool 实现。
 */
export class MCPTool implements CustomTool<TSchema, MCPToolDetails> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TSchema;
	/** Original MCP tool name (before normalization) */
	/** 原始 MCP 工具名称（规范化前） */
	readonly mcpToolName: string;
	/** Server name */
	/** 服务器名称 */
	readonly mcpServerName: string;

	/** Create MCPTool instances for all tools from an MCP server connection */
	/** 从 MCP 服务器连接为所有工具创建 MCPTool 实例 */
	static fromTools(connection: MCPServerConnection, tools: MCPToolDefinition[], reconnect?: MCPReconnect): MCPTool[] {
		return tools.map(tool => new MCPTool(connection, tool, reconnect));
	}

	constructor(
		private connection: MCPServerConnection,
		private readonly tool: MCPToolDefinition,
		private readonly reconnect?: MCPReconnect,
	) {
		this.name = createMCPToolName(connection.name, tool.name);
		this.label = `${connection.name}/${tool.name}`;
		this.description = tool.description ?? `MCP tool from ${connection.name}`;
		this.parameters = normalizeSchemaForMCP(tool.inputSchema) as TSchema;
		this.mcpToolName = tool.name;
		this.mcpServerName = connection.name;
	}

	/** 渲染工具调用的 TUI 显示 */
	renderCall(args: unknown, _options: RenderResultOptions, theme: Theme) {
		return renderMCPCall(normalizeToolArgs(args), theme, this.label);
	}

	/** 渲染工具结果的 TUI 显示 */
	renderResult(result: CustomToolResult<MCPToolDetails>, options: RenderResultOptions, theme: Theme, args?: unknown) {
		return renderMCPResult(result, options, theme, normalizeToolArgs(args));
	}

	/** 执行 MCP 工具调用，支持连接错误时自动重连重试 */
	async execute(
		_toolCallId: string,
		params: unknown,
		_onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
		_ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<CustomToolResult<MCPToolDetails>> {
		throwIfAborted(signal);
		const args = normalizeToolArgs(params);
		const provider = this.connection._source?.provider;
		const providerName = this.connection._source?.providerName;

		try {
			const result = await callTool(this.connection, this.tool.name, args, { signal });
			return buildResult(result, this.connection.name, this.tool.name, provider, providerName);
		} catch (error) {
			rethrowIfAborted(error, signal);
			if (this.reconnect && isRetriableConnectionError(error)) {
				const newConn = await reconnectWithAbort(this.reconnect, signal);
				if (newConn) {
					// 重新绑定，使该实例的后续调用使用新连接
					this.connection = newConn;
					const retryProvider = newConn._source?.provider ?? provider;
					const retryProviderName = newConn._source?.providerName ?? providerName;
					try {
						const result = await callTool(newConn, this.tool.name, args, { signal });
						return buildResult(result, newConn.name, this.tool.name, retryProvider, retryProviderName);
					} catch (retryError) {
						rethrowIfAborted(retryError, signal);
						return buildErrorResult(
							retryError,
							this.connection.name,
							this.tool.name,
							retryProvider,
							retryProviderName,
						);
					}
				}
			}
			return buildErrorResult(error, this.connection.name, this.tool.name, provider, providerName);
		}
	}
}

/**
 * CustomTool wrapping an MCP tool with deferred connection resolution.
 * 包装 MCP 工具并使用延迟连接解析的 CustomTool 实现。
 */
export class DeferredMCPTool implements CustomTool<TSchema, MCPToolDetails> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TSchema;
	/** Original MCP tool name (before normalization) */
	/** 原始 MCP 工具名称（规范化前） */
	readonly mcpToolName: string;
	/** Server name */
	/** 服务器名称 */
	readonly mcpServerName: string;
	readonly #fallbackProvider: string | undefined;
	readonly #fallbackProviderName: string | undefined;

	/** Create DeferredMCPTool instances for all tools from an MCP server */
	/** 从 MCP 服务器为所有工具创建 DeferredMCPTool 实例 */
	static fromTools(
		serverName: string,
		tools: MCPToolDefinition[],
		getConnection: () => Promise<MCPServerConnection>,
		source?: SourceMeta,
		reconnect?: MCPReconnect,
	): DeferredMCPTool[] {
		return tools.map(tool => new DeferredMCPTool(serverName, tool, getConnection, source, reconnect));
	}

	constructor(
		private readonly serverName: string,
		private readonly tool: MCPToolDefinition,
		private readonly getConnection: () => Promise<MCPServerConnection>,
		source?: SourceMeta,
		private readonly reconnect?: MCPReconnect,
	) {
		this.name = createMCPToolName(serverName, tool.name);
		this.label = `${serverName}/${tool.name}`;
		this.description = tool.description ?? `MCP tool from ${serverName}`;
		this.parameters = normalizeSchemaForMCP(tool.inputSchema) as TSchema;
		this.mcpToolName = tool.name;
		this.mcpServerName = serverName;
		this.#fallbackProvider = source?.provider;
		this.#fallbackProviderName = source?.providerName;
	}

	/** 渲染工具调用的 TUI 显示 */
	renderCall(args: unknown, _options: RenderResultOptions, theme: Theme) {
		return renderMCPCall(normalizeToolArgs(args), theme, this.label);
	}

	/** 渲染工具结果的 TUI 显示 */
	renderResult(result: CustomToolResult<MCPToolDetails>, options: RenderResultOptions, theme: Theme, args?: unknown) {
		return renderMCPResult(result, options, theme, normalizeToolArgs(args));
	}

	/** 执行延迟 MCP 工具调用，先等待连接建立再执行，支持重连重试 */
	async execute(
		_toolCallId: string,
		params: unknown,
		_onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
		_ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<CustomToolResult<MCPToolDetails>> {
		throwIfAborted(signal);
		const args = normalizeToolArgs(params);
		const provider = this.#fallbackProvider;
		const providerName = this.#fallbackProviderName;

		try {
			const connection = await untilAborted(signal, () => this.getConnection());
			throwIfAborted(signal);
			try {
				const result = await callTool(connection, this.tool.name, args, { signal });
				return buildResult(
					result,
					this.serverName,
					this.tool.name,
					connection._source?.provider ?? provider,
					connection._source?.providerName ?? providerName,
				);
			} catch (callError) {
				rethrowIfAborted(callError, signal);
				if (this.reconnect && isRetriableConnectionError(callError)) {
					const newConn = await reconnectWithAbort(this.reconnect, signal);
					if (newConn) {
						const retryProvider = newConn._source?.provider ?? provider;
						const retryProviderName = newConn._source?.providerName ?? providerName;
						try {
							const result = await callTool(newConn, this.tool.name, args, { signal });
							return buildResult(result, this.serverName, this.tool.name, retryProvider, retryProviderName);
						} catch (retryError) {
							rethrowIfAborted(retryError, signal);
							return buildErrorResult(
								retryError,
								this.serverName,
								this.tool.name,
								retryProvider,
								retryProviderName,
							);
						}
					}
				}
				return buildErrorResult(callError, this.serverName, this.tool.name, provider, providerName);
			}
		} catch (connError) {
			// getConnection() 失败 — 服务器从未连接或连接已丢失。
			// 对于延迟工具，总是值得尝试重连，因为错误
			// （"MCP server not connected"）不是来自 callTool 的网络错误。
			rethrowIfAborted(connError, signal);
			if (this.reconnect) {
				const newConn = await reconnectWithAbort(this.reconnect, signal);
				if (newConn) {
					try {
						const result = await callTool(newConn, this.tool.name, args, { signal });
						return buildResult(
							result,
							this.serverName,
							this.tool.name,
							newConn._source?.provider ?? provider,
							newConn._source?.providerName ?? providerName,
						);
					} catch (retryError) {
						rethrowIfAborted(retryError, signal);
						return buildErrorResult(retryError, this.serverName, this.tool.name, provider, providerName);
					}
				}
			}
			return buildErrorResult(connError, this.serverName, this.tool.name, provider, providerName);
		}
	}
}


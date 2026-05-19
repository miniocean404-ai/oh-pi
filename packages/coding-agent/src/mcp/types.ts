
/**
 * MCP (Model Context Protocol) type definitions.
 * MCP（模型上下文协议）类型定义。
 *
 * Based on MCP specification 2025-03-26:
 * https://modelcontextprotocol.io/specification/2025-03-26/
 */

// =============================================================================
// JSON-RPC 2.0 类型
// =============================================================================

import type { SourceMeta } from "../capability/types";

/** JSON-RPC 请求 */
export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: Record<string, unknown>;
}

/** JSON-RPC 通知（无需响应） */
export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
}

/** JSON-RPC 响应 */
export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number;
	result?: unknown;
	error?: JsonRpcError;
}

/** JSON-RPC 错误 */
export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

/** JSON-RPC 消息联合类型 */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// =============================================================================
// MCP 服务器配置（.mcp.json 格式）
// =============================================================================

/** Authentication configuration for MCP servers */
/** MCP 服务器的认证配置 */
export interface MCPAuthConfig {
	/** Authentication type */
	/** 认证类型 */
	type: "oauth" | "apikey";
	/** Credential ID for OAuth (references agent.db) */
	/** OAuth 凭据 ID（引用 agent.db） */
	credentialId?: string;
	/** Token endpoint URL — persisted for proactive token refresh */
	/** 令牌端点 URL —— 持久化以支持主动令牌刷新 */
	tokenUrl?: string;
	/** Client ID — persisted for token refresh */
	/** 客户端 ID —— 持久化以支持令牌刷新 */
	clientId?: string;
	/** Client secret — persisted for token refresh */
	/** 客户端密钥 —— 持久化以支持令牌刷新 */
	clientSecret?: string;
}

/** Base server config with shared options */
/** 服务器基础配置，包含共享选项 */
interface MCPServerConfigBase {
	/** Whether this server is enabled (default: true) */
	/** 是否启用此服务器（默认: true） */
	enabled?: boolean;
	/** Connection timeout in milliseconds (default: 30000) */
	/** 连接超时时间（毫秒，默认: 30000） */
	timeout?: number;
	/** Authentication configuration (optional) */
	/** 认证配置（可选） */
	auth?: MCPAuthConfig;
	/** OAuth configuration for servers requiring explicit client credentials */
	/** 需要显式客户端凭据的服务器的 OAuth 配置 */
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		redirectUri?: string;
		callbackPort?: number;
		callbackPath?: string;
	};
}

/** Stdio server configuration */
/** 标准 IO 服务器配置 */
export interface MCPStdioServerConfig extends MCPServerConfigBase {
	type?: "stdio"; // Default if not specified
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

/** HTTP server configuration (Streamable HTTP transport) */
/** HTTP 服务器配置（流式 HTTP 传输） */
export interface MCPHttpServerConfig extends MCPServerConfigBase {
	type: "http";
	url: string;
	headers?: Record<string, string>;
}

/** SSE server configuration (deprecated, use HTTP) */
/** SSE 服务器配置（已弃用，请使用 HTTP） */
export interface MCPSseServerConfig extends MCPServerConfigBase {
	type: "sse";
	url: string;
	headers?: Record<string, string>;
}

/** MCP 服务器配置联合类型 */
export type MCPServerConfig = MCPStdioServerConfig | MCPHttpServerConfig | MCPSseServerConfig;

/** MCP 配置 JSON Schema URL */
export const MCP_CONFIG_SCHEMA_URL =
	"https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";

/** Root mcp.json/.mcp.json file structure */
/** 根 mcp.json/.mcp.json 文件结构 */
export interface MCPConfigFile {
	$schema?: string;
	mcpServers?: Record<string, MCPServerConfig>;
	disabledServers?: string[];
}

// =============================================================================
// MCP 协议类型
// =============================================================================

/** MCP implementation info */
/** MCP 实现信息 */
export interface MCPImplementation {
	name: string;
	version: string;
}

/** MCP client capabilities */
/** MCP 客户端能力 */
export interface MCPClientCapabilities {
	roots?: { listChanged?: boolean };
	sampling?: Record<string, never>;
	experimental?: Record<string, unknown>;
}

/** MCP server capabilities */
/** MCP 服务器能力 */
export interface MCPServerCapabilities {
	tools?: { listChanged?: boolean };
	resources?: { subscribe?: boolean; listChanged?: boolean };
	prompts?: { listChanged?: boolean };
	logging?: Record<string, never>;
	experimental?: Record<string, unknown>;
}

/** Initialize request params */
/** 初始化请求参数 */
export interface MCPInitializeParams {
	protocolVersion: string;
	capabilities: MCPClientCapabilities;
	clientInfo: MCPImplementation;
}

/** Initialize response result */
/** 初始化响应结果 */
export interface MCPInitializeResult {
	protocolVersion: string;
	capabilities: MCPServerCapabilities;
	serverInfo: MCPImplementation;
	instructions?: string;
}

/** MCP tool definition */
/** MCP 工具定义 */
export interface MCPToolDefinition {
	name: string;
	description?: string;
	inputSchema: {
		type: "object";
		properties?: Record<string, unknown>;
		required?: string[];
		[key: string]: unknown;
	};
}

/** tools/list response */
/** tools/list 响应 */
export interface MCPToolsListResult {
	tools: MCPToolDefinition[];
	nextCursor?: string;
}

/** tools/call params */
/** tools/call 请求参数 */
export interface MCPToolCallParams {
	name: string;
	arguments?: Record<string, unknown>;
}

/** Content types in tool results */
/** 工具结果中的内容类型 */
/** 文本内容 */
export interface MCPTextContent {
	type: "text";
	text: string;
}

/** 图片内容 */
export interface MCPImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

/** 资源内容 */
export interface MCPResourceContent {
	type: "resource";
	resource: {
		uri: string;
		mimeType?: string;
		text?: string;
		blob?: string;
	};
}

/** MCP 内容联合类型 */
export type MCPContent = MCPTextContent | MCPImageContent | MCPResourceContent;

/** tools/call response */
/** tools/call 响应 */
export interface MCPToolCallResult {
	content: MCPContent[];
	isError?: boolean;
}

// =============================================================================
// 传输层类型
// =============================================================================

/** MCP 请求选项 */
export interface MCPRequestOptions {
	/** Abort signal (e.g. Escape-to-interrupt) */
	/** 中止信号（例如按 Escape 中断） */
	signal?: AbortSignal;
}

/** Transport interface - abstracts stdio/http */
/** 传输层接口 - 抽象 stdio/http */
export interface MCPTransport {
	/** Send a request and wait for response */
	/** 发送请求并等待响应 */
	request<T = unknown>(method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<T>;

	/** Send a notification (no response expected) */
	/** 发送通知（不期望响应） */
	notify(method: string, params?: Record<string, unknown>): Promise<void>;

	/** Close the transport */
	/** 关闭传输层 */
	close(): Promise<void>;

	/** Whether the transport is connected */
	/** 传输层是否已连接 */
	readonly connected: boolean;

	/** Event handlers */
	/** 事件处理器 */
	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	/** Handler for server-to-client requests (e.g. roots/list). Returns result or throws a JsonRpcError. */
	/** 处理服务器到客户端的请求（例如 roots/list）。返回结果或抛出 JsonRpcError。 */
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
}

/** Transport factory function */
/** 传输层工厂函数 */
export type TransportFactory = (config: MCPServerConfig) => Promise<MCPTransport>;

// =============================================================================
// MCP 客户端类型
// =============================================================================

/** Connected MCP server state */
/** 已连接的 MCP 服务器状态 */
export interface MCPServerConnection {
	/** Server name from config */
	/** 来自配置的服务器名称 */
	name: string;
	/** Original config */
	/** 原始配置 */
	config: MCPServerConfig;
	/** Transport instance */
	/** 传输层实例 */
	transport: MCPTransport;
	/** Server info from initialize */
	/** 初始化时返回的服务器信息 */
	serverInfo: MCPImplementation;
	/** Server capabilities */
	/** 服务器能力 */
	capabilities: MCPServerCapabilities;
	/** Cached tools (populated on demand) */
	/** 缓存的工具列表（按需加载） */
	tools?: MCPToolDefinition[];
	/** Source metadata (for display) */
	/** 来源元数据（用于显示） */
	_source?: SourceMeta;
	/** Cached resources (populated on demand) */
	/** 缓存的资源列表（按需加载） */
	resources?: MCPResource[];
	/** Cached resource templates (populated on demand) */
	/** 缓存的资源模板列表（按需加载） */
	resourceTemplates?: MCPResourceTemplate[];
	/** Server instructions from initialize */
	/** 初始化时返回的服务器指令 */
	instructions?: string;
	/** Cached prompts (populated on demand) */
	/** 缓存的提示词列表（按需加载） */
	prompts?: MCPPrompt[];
}

/** MCP tool with server context */
/** 带服务器上下文的 MCP 工具 */
export interface MCPToolWithServer {
	server: MCPServerConnection;
	tool: MCPToolDefinition;
}

// =============================================================================
// MCP 资源类型
// =============================================================================

/** Annotations for resources, templates, and content blocks */
/** 资源、模板和内容块的注解 */
export interface MCPAnnotations {
	audience?: ("user" | "assistant")[];
	priority?: number;
	lastModified?: string;
}

/** A concrete resource exposed by an MCP server */
/** MCP 服务器暴露的具体资源 */
export interface MCPResource {
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
	annotations?: MCPAnnotations;
}

/** A parameterized resource template (RFC 6570 URI template) */
/** 参数化资源模板（RFC 6570 URI 模板） */
export interface MCPResourceTemplate {
	uriTemplate: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	annotations?: MCPAnnotations;
}

/** Result of resources/list */
/** resources/list 响应结果 */
export interface MCPResourcesListResult {
	resources: MCPResource[];
	nextCursor?: string;
}

/** Result of resources/templates/list */
/** resources/templates/list 响应结果 */
export interface MCPResourceTemplatesListResult {
	resourceTemplates: MCPResourceTemplate[];
	nextCursor?: string;
}

/** A single content item from resources/read */
/** resources/read 返回的单个内容项 */
export interface MCPResourceContentItem {
	uri: string;
	mimeType?: string;
	text?: string;
	blob?: string;
}

/** Result of resources/read */
/** resources/read 响应结果 */
export interface MCPResourceReadResult {
	contents: MCPResourceContentItem[];
}

/** Params for resources/read */
/** resources/read 请求参数 */
export interface MCPResourceReadParams {
	uri: string;
}

/** Params for resources/subscribe and resources/unsubscribe */
/** resources/subscribe 和 resources/unsubscribe 请求参数 */
export interface MCPResourceSubscribeParams {
	uri: string;
}

// =============================================================================
// MCP 提示词类型
// =============================================================================

/** An argument definition for an MCP prompt */
/** MCP 提示词的参数定义 */
export interface MCPPromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

/** A prompt definition exposed by an MCP server */
/** MCP 服务器暴露的提示词定义 */
export interface MCPPrompt {
	name: string;
	title?: string;
	description?: string;
	arguments?: MCPPromptArgument[];
}

/** Result of prompts/list */
/** prompts/list 响应结果 */
export interface MCPPromptsListResult {
	prompts: MCPPrompt[];
	nextCursor?: string;
}

/** Audio content in prompt messages */
/** 提示词消息中的音频内容 */
export interface MCPAudioContent {
	type: "audio";
	data: string;
	mimeType: string;
}

/** Content type union for prompt messages */
/** 提示词消息的内容类型联合 */
export type MCPPromptContent = MCPTextContent | MCPImageContent | MCPAudioContent | MCPResourceContent;

/** A single message in a prompt result */
/** 提示词结果中的单条消息 */
export interface MCPPromptMessage {
	role: "user" | "assistant";
	content: MCPPromptContent | MCPPromptContent[];
}

/** Params for prompts/get */
/** prompts/get 请求参数 */
export interface MCPGetPromptParams {
	name: string;
	arguments?: Record<string, string>;
}

/** Result of prompts/get */
/** prompts/get 响应结果 */
export interface MCPGetPromptResult {
	description?: string;
	messages: MCPPromptMessage[];
}

// =============================================================================
// MCP 通知方法名称
// =============================================================================

/** MCP server notification method names */
/** MCP 服务器通知方法名称 */
export const MCPNotificationMethods = {
	TOOLS_LIST_CHANGED: "notifications/tools/list_changed",
	RESOURCES_LIST_CHANGED: "notifications/resources/list_changed",
	RESOURCES_UPDATED: "notifications/resources/updated",
	PROMPTS_LIST_CHANGED: "notifications/prompts/list_changed",
} as const;

/** Extract a JsonRpcError from a thrown value. Preserves `.code` and `.message` from Error instances or plain objects. */
/** 从抛出的值中提取 JsonRpcError。保留 Error 实例或普通对象的 `.code` 和 `.message`。 */
export function toJsonRpcError(error: unknown): JsonRpcError {
	if (error instanceof Error) {
		const code = "code" in error && typeof error.code === "number" ? error.code : -32603;
		return { code, message: error.message };
	}
	if (typeof error === "object" && error !== null) {
		const obj = error as Record<string, unknown>;
		if (typeof obj.code === "number" && typeof obj.message === "string") {
			return { code: obj.code, message: obj.message };
		}
	}
	return { code: -32603, message: "Internal error" };
}


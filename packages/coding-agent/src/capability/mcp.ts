
/**
 * MCP (Model Context Protocol) Servers Capability
 * MCP（模型上下文协议）服务器能力
 *
 * Canonical shape for MCP server configurations, regardless of source format.
 * All providers translate their native format to this shape.
 * MCP 服务器配置的标准结构，与来源格式无关。
 * 所有提供者将其原生格式转换为此结构。
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * Canonical MCP server configuration.
 * 标准 MCP 服务器配置。
 */
export interface MCPServer {
	/** Server name (unique key) */
	/** 服务器名称（唯一键） */
	name: string;
	/** Whether this server is enabled (default: true) */
	/** 是否启用此服务器（默认：true） */
	enabled?: boolean;
	/** Connection timeout in milliseconds */
	/** 连接超时时间（毫秒） */
	timeout?: number;
	/** Command to run (for stdio transport) */
	/** 要执行的命令（用于 stdio 传输） */
	command?: string;
	/** Command arguments */
	/** 命令参数 */
	args?: string[];
	/** Environment variables */
	/** 环境变量 */
	env?: Record<string, string>;
	/** Working directory for stdio transport */
	/** stdio 传输的工作目录 */
	cwd?: string;
	/** URL (for HTTP/SSE transport) */
	/** URL（用于 HTTP/SSE 传输） */
	url?: string;
	/** HTTP headers (for HTTP transport) */
	/** HTTP 头部（用于 HTTP 传输） */
	headers?: Record<string, string>;
	/** Authentication configuration */
	/** 认证配置 */
	auth?: {
		type: "oauth" | "apikey";
		credentialId?: string;
		tokenUrl?: string;
		clientId?: string;
		clientSecret?: string;
	};
	/** OAuth configuration (clientId, clientSecret, redirectUri, callbackPort, callbackPath) for servers requiring explicit client credentials */
	/** OAuth 配置（clientId、clientSecret、redirectUri、callbackPort、callbackPath），用于需要显式客户端凭据的服务器 */
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		redirectUri?: string;
		callbackPort?: number;
		callbackPath?: string;
	};
	/** Transport type */
	/** 传输类型 */
	transport?: "stdio" | "sse" | "http";
	/** Source metadata (added by loader) */
	/** 来源元数据（由加载器添加） */
	_source: SourceMeta;
}

/** MCP 服务器能力定义 */
export const mcpCapability = defineCapability<MCPServer>({
	id: "mcps",
	displayName: "MCP Servers",
	description: "Model Context Protocol server configurations for external tool integrations",
	key: server => server.name,
	toExtensionId: server => `mcp:${server.name}`,
	validate: server => {
		if (!server.name) return "Missing server name";
		if (!server.command && !server.url) return "Must have command or url";

		// 验证传输方式与端点的匹配关系
		if (server.transport === "stdio" && !server.command) {
			return "stdio transport requires command field";
		}
		if ((server.transport === "http" || server.transport === "sse") && !server.url) {
			return "http/sse transport requires url field";
		}

		return undefined;
	},
});


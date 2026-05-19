
/**
 * MCP tools loader.
 * MCP 工具加载器。
 *
 * Integrates MCP tool discovery with the custom tools system.
 * 将 MCP 工具发现与自定义工具系统集成。
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { LoadedCustomTool } from "../extensibility/custom-tools/types";
import { AgentStorage } from "../session/agent-storage";
import type { AuthStorage } from "../session/auth-storage";
import { type MCPLoadResult, MCPManager } from "./manager";
import { MCPToolCache } from "./tool-cache";

/** Result from loading MCP tools */
/** 加载 MCP 工具的结果 */
export interface MCPToolsLoadResult {
	/** MCP manager (for lifecycle management) */
	/** MCP 管理器（用于生命周期管理） */
	manager: MCPManager;
	/** Loaded tools as LoadedCustomTool format */
	/** 已加载的工具（LoadedCustomTool 格式） */
	tools: LoadedCustomTool[];
	/** Errors keyed by server name */
	/** 按服务器名称分组的错误 */
	errors: Array<{ path: string; error: string }>;
	/** Connected server names */
	/** 已连接的服务器名称 */
	connectedServers: string[];
	/** Extracted Exa API keys from filtered MCP servers */
	/** 从过滤的 MCP 服务器中提取的 Exa API 密钥 */
	exaApiKeys: string[];
}

/** Options for loading MCP tools */
/** 加载 MCP 工具的选项 */
export interface MCPToolsLoadOptions {
	/** Called when starting to connect to servers */
	/** 开始连接服务器时调用 */
	onConnecting?: (serverNames: string[]) => void;
	/** Whether to load project-level config (default: true) */
	/** 是否加载项目级配置（默认: true） */
	enableProjectConfig?: boolean;
	/** Whether to filter out Exa MCP servers (default: true) */
	/** 是否过滤掉 Exa MCP 服务器（默认: true） */
	filterExa?: boolean;
	/** Whether to filter out browser MCP servers when builtin browser tool is enabled (default: false) */
	/** 当内置浏览器工具启用时是否过滤掉浏览器 MCP 服务器（默认: false） */
	filterBrowser?: boolean;
	/** SQLite storage for MCP tool cache (null disables cache) */
	/** MCP 工具缓存的 SQLite 存储（null 表示禁用缓存） */
	cacheStorage?: AgentStorage | null;
	/** Auth storage used to resolve OAuth credentials before initial MCP connect */
	/** 用于在初始 MCP 连接之前解析 OAuth 凭据的认证存储 */
	authStorage?: AuthStorage;
}

/** 解析工具缓存实例 */
async function resolveToolCache(storage: AgentStorage | null | undefined): Promise<MCPToolCache | null> {
	if (storage === null) return null;
	try {
		const resolved = storage ?? (await AgentStorage.open());
		return new MCPToolCache(resolved);
	} catch (error) {
		logger.warn("MCP tool cache unavailable", { error: String(error) });
		return null;
	}
}

/**
 * Discover and load MCP tools from .mcp.json files.
 * 从 .mcp.json 文件中发现并加载 MCP 工具。
 *
 * @param cwd Working directory (project root) 工作目录（项目根目录）
 * @param options Load options including progress callbacks 加载选项，包括进度回调
 * @returns MCP tools in LoadedCustomTool format for integration 用于集成的 LoadedCustomTool 格式的 MCP 工具
 */
export async function discoverAndLoadMCPTools(cwd: string, options?: MCPToolsLoadOptions): Promise<MCPToolsLoadResult> {
	const toolCache = await resolveToolCache(options?.cacheStorage);
	const manager = new MCPManager(cwd, toolCache);
	if (options?.authStorage) {
		manager.setAuthStorage(options.authStorage);
	}

	let result: MCPLoadResult;
	try {
		result = await manager.discoverAndConnect({
			onConnecting: options?.onConnecting,
			enableProjectConfig: options?.enableProjectConfig,
			filterExa: options?.filterExa,
			filterBrowser: options?.filterBrowser,
		});
	} catch (error) {
		// 如果发现完全失败，返回空结果
		const message = error instanceof Error ? error.message : String(error);
		return {
			manager,
			tools: [],
			errors: [{ path: ".mcp.json", error: message }],
			connectedServers: [],
			exaApiKeys: [],
		};
	}

	// 将 MCP 工具转换为 LoadedCustomTool 格式
	const loadedTools: LoadedCustomTool[] = result.tools.map(tool => {
		// MCPTool and DeferredMCPTool have these properties
		const mcpTool = tool as { mcpServerName?: string };
		const serverName = mcpTool.mcpServerName;

		// Get provider info from manager's connection if available
		const connection = serverName ? manager.getConnection(serverName) : undefined;
		const source = serverName ? manager.getSource(serverName) : undefined;
		const providerName =
			connection?._source?.providerName ?? source?.providerName ?? connection?._source?.provider ?? source?.provider;

		// Format path with provider info if available
		// Format: "mcp:serverName via providerName" (e.g., "mcp:agentx via Claude Code")
		const path = serverName && providerName ? `mcp:${serverName} via ${providerName}` : `mcp:${tool.name}`;

		return {
			path,
			resolvedPath: `mcp:${tool.name}`,
			tool: tool as any, // MCPToolDetails is compatible with CustomTool<TSchema, any>
		};
	});

	// 将错误映射转换为数组格式
	const errors: Array<{ path: string; error: string }> = [];
	for (const [serverName, errorMsg] of result.errors) {
		errors.push({ path: `mcp:${serverName}`, error: errorMsg });
	}

	return {
		manager,
		tools: loadedTools,
		errors,
		connectedServers: result.connectedServers,
		exaApiKeys: result.exaApiKeys,
	};
}


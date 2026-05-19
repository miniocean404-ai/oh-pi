
/**
 * MCP configuration loader.
 * MCP 配置加载器。
 *
 * Uses the capability system to load MCP servers from multiple sources.
 * 使用能力系统从多个来源加载 MCP 服务器。
 */

import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import { mcpCapability } from "../capability/mcp";
import type { SourceMeta } from "../capability/types";
import type { MCPServer } from "../discovery";
import { loadCapability } from "../discovery";
import { readDisabledServers } from "./config-writer";
import type { MCPServerConfig } from "./types";

/** Options for loading MCP configs */
/** 加载 MCP 配置的选项 */
export interface LoadMCPConfigsOptions {
	/** Whether to load project-level config (default: true) */
	/** 是否加载项目级配置（默认: true） */
	enableProjectConfig?: boolean;
	/** Whether to filter out Exa MCP servers (default: true) */
	/** 是否过滤掉 Exa MCP 服务器（默认: true） */
	filterExa?: boolean;
	/** Whether to filter out browser MCP servers when builtin browser tool is enabled (default: false) */
	/** 当内置浏览器工具启用时是否过滤掉浏览器 MCP 服务器（默认: false） */
	filterBrowser?: boolean;
}

/** Result of loading MCP configs */
/** 加载 MCP 配置的结果 */
export interface LoadMCPConfigsResult {
	/** Loaded server configs */
	/** 已加载的服务器配置 */
	configs: Record<string, MCPServerConfig>;
	/** Extracted Exa API keys (if any were filtered) */
	/** 提取的 Exa API 密钥（如果有被过滤的话） */
	exaApiKeys: string[];
	/** Source metadata for each server */
	/** 每个服务器的来源元数据 */
	sources: Record<string, SourceMeta>;
}

/**
 * Convert canonical MCPServer to legacy MCPServerConfig.
 * 将规范的 MCPServer 转换为旧版 MCPServerConfig 格式。
 */
function convertToLegacyConfig(server: MCPServer): MCPServerConfig {
	// 确定传输类型
	const transport = server.transport ?? (server.command ? "stdio" : server.url ? "http" : "stdio");
	const shared = {
		enabled: server.enabled,
		timeout: server.timeout,
		auth: server.auth,
		oauth: server.oauth,
	};

	if (transport === "stdio") {
		const config: MCPServerConfig = {
			...shared,
			type: "stdio" as const,
			command: server.command ?? "",
		};
		if (server.args) config.args = server.args;
		if (server.env) config.env = server.env;
		if (server.cwd) config.cwd = server.cwd;
		return config;
	}

	if (transport === "http") {
		const config: MCPServerConfig = {
			...shared,
			type: "http" as const,
			url: server.url ?? "",
		};
		if (server.headers) config.headers = server.headers;
		return config;
	}

	if (transport === "sse") {
		const config: MCPServerConfig = {
			...shared,
			type: "sse" as const,
			url: server.url ?? "",
		};
		if (server.headers) config.headers = server.headers;
		return config;
	}

	// 回退到 stdio
	return {
		...shared,
		type: "stdio" as const,
		command: server.command ?? "",
	};
}

/**
 * Load all MCP server configs from standard locations.
 * 从标准位置加载所有 MCP 服务器配置。
 * Uses the capability system for multi-source discovery.
 * 使用能力系统进行多源发现。
 *
 * @param cwd Working directory (project root) 工作目录（项目根目录）
 * @param options Load options 加载选项
 */
export async function loadAllMCPConfigs(cwd: string, options?: LoadMCPConfigsOptions): Promise<LoadMCPConfigsResult> {
	const enableProjectConfig = options?.enableProjectConfig ?? true;
	const filterExa = options?.filterExa ?? true;
	const filterBrowser = options?.filterBrowser ?? false;

	// 通过能力系统加载 MCP 服务器
	const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd });

	// 如果禁用，则过滤掉项目级配置
	const servers = enableProjectConfig
		? result.items
		: result.items.filter(server => server._source.level !== "project");

	// 加载用户级别的禁用服务器列表
	const disabledServers = new Set(await readDisabledServers(getMCPConfigPath("user", cwd)));
	// 转换为旧版格式并保留来源元数据
	let configs: Record<string, MCPServerConfig> = {};
	let sources: Record<string, SourceMeta> = {};
	for (const server of servers) {
		const config = convertToLegacyConfig(server);
		if (config.enabled === false || disabledServers.has(server.name)) {
			continue;
		}
		configs[server.name] = config;
		sources[server.name] = server._source;
	}

	let exaApiKeys: string[] = [];

	if (filterExa) {
		const exaResult = filterExaMCPServers(configs, sources);
		configs = exaResult.configs;
		sources = exaResult.sources;
		exaApiKeys = exaResult.exaApiKeys;
	}

	if (filterBrowser) {
		const browserResult = filterBrowserMCPServers(configs, sources);
		configs = browserResult.configs;
		sources = browserResult.sources;
	}

	return { configs, exaApiKeys, sources };
}

/** Pattern to match Exa MCP servers */
/** 匹配 Exa MCP 服务器的模式 */
const EXA_MCP_URL_PATTERN = /mcp\.exa\.ai/i;
const EXA_API_KEY_PATTERN = /exaApiKey=([^&\s]+)/i;

/**
 * Check if a server config is an Exa MCP server.
 * 检查服务器配置是否为 Exa MCP 服务器。
 */
export function isExaMCPServer(name: string, config: MCPServerConfig): boolean {
	// 通过服务器名称检查
	if (name.toLowerCase() === "exa") {
		return true;
	}

	// 通过 URL 检查 HTTP/SSE 服务器
	if (config.type === "http" || config.type === "sse") {
		const httpConfig = config as { url?: string };
		if (httpConfig.url && EXA_MCP_URL_PATTERN.test(httpConfig.url)) {
			return true;
		}
	}

	// 通过 args 检查 stdio 服务器（例如 mcp-remote 到 exa）
	if (!config.type || config.type === "stdio") {
		const stdioConfig = config as { args?: string[] };
		if (stdioConfig.args?.some(arg => EXA_MCP_URL_PATTERN.test(arg))) {
			return true;
		}
	}

	return false;
}

/**
 * Extract Exa API key from an MCP server config.
 * 从 MCP 服务器配置中提取 Exa API 密钥。
 */
export function extractExaApiKey(config: MCPServerConfig): string | undefined {
	// 检查 HTTP/SSE 服务器的 URL
	if (config.type === "http" || config.type === "sse") {
		const httpConfig = config as { url?: string };
		if (httpConfig.url) {
			const match = EXA_API_KEY_PATTERN.exec(httpConfig.url);
			if (match) return match[1];
		}
	}

	// 检查 stdio 服务器的参数
	if (!config.type || config.type === "stdio") {
		const stdioConfig = config as { args?: string[] };
		if (stdioConfig.args) {
			for (const arg of stdioConfig.args) {
				const match = EXA_API_KEY_PATTERN.exec(arg);
				if (match) return match[1];
			}
		}
	}

	// 检查环境变量
	if ("env" in config && config.env) {
		const envConfig = config as { env: Record<string, string> };
		if (envConfig.env.EXA_API_KEY) {
			return envConfig.env.EXA_API_KEY;
		}
	}

	return undefined;
}

/** Result of filtering Exa MCP servers */
/** 过滤 Exa MCP 服务器的结果 */
export interface ExaFilterResult {
	/** Configs with Exa servers removed */
	/** 移除 Exa 服务器后的配置 */
	configs: Record<string, MCPServerConfig>;
	/** Extracted Exa API keys (if any) */
	/** 提取的 Exa API 密钥（如果有的话） */
	exaApiKeys: string[];
	/** Source metadata for remaining servers */
	/** 剩余服务器的来源元数据 */
	sources: Record<string, SourceMeta>;
}

/**
 * Filter out Exa MCP servers and extract their API keys.
 * 过滤掉 Exa MCP 服务器并提取其 API 密钥。
 * Since we have native Exa integration, we don't need the MCP server.
 * 因为我们有原生 Exa 集成，所以不需要 MCP 服务器。
 */
export function filterExaMCPServers(
	configs: Record<string, MCPServerConfig>,
	sources: Record<string, SourceMeta>,
): ExaFilterResult {
	const filtered: Record<string, MCPServerConfig> = {};
	const filteredSources: Record<string, SourceMeta> = {};
	const exaApiKeys: string[] = [];

	for (const [name, config] of Object.entries(configs)) {
		if (isExaMCPServer(name, config)) {
			// 在过滤前提取 API 密钥
			const apiKey = extractExaApiKey(config);
			if (apiKey) {
				exaApiKeys.push(apiKey);
			}
		} else {
			filtered[name] = config;
			if (sources[name]) {
				filteredSources[name] = sources[name];
			}
		}
	}

	return { configs: filtered, exaApiKeys, sources: filteredSources };
}

/**
 * Validate server config has required fields.
 * 验证服务器配置是否包含必填字段。
 */
export function validateServerConfig(name: string, config: MCPServerConfig): string[] {
	const errors: string[] = [];

	const serverType = config.type ?? "stdio";

	// 检查冲突的传输字段
	const hasCommand = "command" in config && config.command;
	const hasUrl = "url" in config && (config as { url?: string }).url;
	if (hasCommand && hasUrl) {
		errors.push(
			`Server "${name}": both "command" and "url" are set - server should be either stdio (command) OR http/sse (url), not both`,
		);
	}

	if (serverType === "stdio") {
		const stdioConfig = config as { command?: string };
		if (!stdioConfig.command) {
			errors.push(`Server "${name}": stdio server requires "command" field`);
		}
	} else if (serverType === "http" || serverType === "sse") {
		const httpConfig = config as { url?: string };
		if (!httpConfig.url) {
			errors.push(`Server "${name}": ${serverType} server requires "url" field`);
		}
	} else {
		errors.push(`Server "${name}": unknown server type "${serverType}"`);
	}

	return errors;
}

/** Known browser automation MCP server names (lowercase) */
/** 已知的浏览器自动化 MCP 服务器名称（小写） */
const BROWSER_MCP_NAMES = new Set([
	"puppeteer",
	"playwright",
	"browserbase",
	"browser-tools",
	"browser-use",
	"browser",
]);

/** Patterns matching browser MCP package names in command/args */
/** 匹配命令/参数中浏览器 MCP 包名的模式 */
const BROWSER_MCP_PKG_PATTERN =
	// Official packages
	// - @modelcontextprotocol/server-puppeteer
	// - @playwright/mcp
	// - @browserbasehq/mcp-server-browserbase
	// - @agentdeskai/browser-tools-mcp
	// - @agent-infra/mcp-server-browser
	// Community packages: puppeteer-mcp-server, playwright-mcp, pptr-mcp, etc.
	/(?:@modelcontextprotocol\/server-puppeteer|@playwright\/mcp|@browserbasehq\/mcp-server-browserbase|@agentdeskai\/browser-tools-mcp|@agent-infra\/mcp-server-browser|puppeteer-mcp|playwright-mcp|pptr-mcp|browser-use-mcp|mcp-browser-use)/i;

/** URL patterns for hosted browser MCP services */
/** 托管浏览器 MCP 服务的 URL 模式 */
const BROWSER_MCP_URL_PATTERN = /browserbase\.com|browser-use\.com/i;

/**
 * Check if a server config is a browser automation MCP server.
 * 检查服务器配置是否为浏览器自动化 MCP 服务器。
 */
export function isBrowserMCPServer(name: string, config: MCPServerConfig): boolean {
	// 通过服务器名称检查
	if (BROWSER_MCP_NAMES.has(name.toLowerCase())) {
		return true;
	}

	// 通过 URL 检查 HTTP/SSE 服务器
	if (config.type === "http" || config.type === "sse") {
		const httpConfig = config as { url?: string };
		if (httpConfig.url && BROWSER_MCP_URL_PATTERN.test(httpConfig.url)) {
			return true;
		}
	}

	// 通过命令/参数检查 stdio 服务器
	if (!config.type || config.type === "stdio") {
		const stdioConfig = config as { command?: string; args?: string[] };
		if (stdioConfig.command && BROWSER_MCP_PKG_PATTERN.test(stdioConfig.command)) {
			return true;
		}
		if (stdioConfig.args?.some(arg => BROWSER_MCP_PKG_PATTERN.test(arg))) {
			return true;
		}
	}

	return false;
}

/** Result of filtering browser MCP servers */
/** 过滤浏览器 MCP 服务器的结果 */
export interface BrowserFilterResult {
	/** Configs with browser servers removed */
	/** 移除浏览器服务器后的配置 */
	configs: Record<string, MCPServerConfig>;
	/** Source metadata for remaining servers */
	/** 剩余服务器的来源元数据 */
	sources: Record<string, SourceMeta>;
}

/**
 * Filter out browser automation MCP servers.
 * 过滤掉浏览器自动化 MCP 服务器。
 * Since we have a native browser tool, we don't need these MCP servers.
 * 因为我们有原生浏览器工具，所以不需要这些 MCP 服务器。
 */
export function filterBrowserMCPServers(
	configs: Record<string, MCPServerConfig>,
	sources: Record<string, SourceMeta>,
): BrowserFilterResult {
	const filtered: Record<string, MCPServerConfig> = {};
	const filteredSources: Record<string, SourceMeta> = {};

	for (const [name, config] of Object.entries(configs)) {
		if (!isBrowserMCPServer(name, config)) {
			filtered[name] = config;
			if (sources[name]) {
				filteredSources[name] = sources[name];
			}
		}
	}

	return { configs: filtered, sources: filteredSources };
}



/**
 * MCP tool cache.
 * MCP 工具缓存。
 *
 * Stores tool definitions per server in agent.db for fast startup.
 * 将每个服务器的工具定义存储在 agent.db 中以加速启动。
 */
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { AgentStorage } from "../session/agent-storage";
import type { MCPServerConfig, MCPToolDefinition } from "./types";

/** 缓存版本号 */
const CACHE_VERSION = 1;
/** 缓存键前缀 */
const CACHE_PREFIX = "mcp_tools:";
/** 缓存过期时间（30 天，毫秒） */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** MCP 工具缓存载荷 */
type MCPToolCachePayload = {
	/** 缓存版本 */
	version: number;
	/** 配置哈希值 */
	configHash: string;
	/** 工具定义列表 */
	tools: MCPToolDefinition[];
};

/** 深度克隆并按键名排序，确保序列化结果稳定 */
function stableClone(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => stableClone(item));
	}
	if (isRecord(value)) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = stableClone(value[key]);
		}
		return sorted;
	}
	return value;
}

/** 稳定的 JSON 序列化（键名排序后序列化） */
function stableStringify(value: unknown): string {
	return JSON.stringify(stableClone(value));
}

/** 将 ArrayBuffer 转换为十六进制字符串 */
function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let output = "";
	for (const byte of bytes) {
		output += byte.toString(16).padStart(2, "0");
	}
	return output;
}

/** 计算服务器配置的 SHA-256 哈希值 */
async function hashConfig(config: MCPServerConfig): Promise<string> {
	const stable = stableStringify(config);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable));
	return toHex(digest);
}

/** 生成缓存键 */
function cacheKey(serverName: string): string {
	return `${CACHE_PREFIX}${serverName}`;
}

/**
 * MCP 工具缓存。
 * 基于 AgentStorage 缓存工具定义，通过配置哈希校验缓存有效性。
 */
export class MCPToolCache {
	constructor(private storage: AgentStorage) {}

	/** 从缓存获取工具定义，若缓存不存在或配置已变更则返回 null */
	async get(serverName: string, config: MCPServerConfig): Promise<MCPToolDefinition[] | null> {
		const key = cacheKey(serverName);
		const raw = this.storage.getCache(key);
		if (!raw) return null;

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			logger.warn("MCP tool cache parse failed", { serverName, error: String(error) });
			return null;
		}

		if (!isRecord(parsed)) return null;
		if (parsed.version !== CACHE_VERSION) return null;
		if (typeof parsed.configHash !== "string") return null;
		if (!Array.isArray(parsed.tools)) return null;

		let currentHash: string;
		try {
			currentHash = await hashConfig(config);
		} catch (error) {
			logger.warn("MCP tool cache hash failed", { serverName, error: String(error) });
			return null;
		}

		if (parsed.configHash !== currentHash) return null;

		return parsed.tools as MCPToolDefinition[];
	}

	/** 将工具定义写入缓存 */
	async set(serverName: string, config: MCPServerConfig, tools: MCPToolDefinition[]): Promise<void> {
		let configHash: string;
		try {
			configHash = await hashConfig(config);
		} catch (error) {
			logger.warn("MCP tool cache hash failed", { serverName, error: String(error) });
			return;
		}

		const payload: MCPToolCachePayload = {
			version: CACHE_VERSION,
			configHash,
			tools,
		};

		let serialized: string;
		try {
			serialized = JSON.stringify(payload);
		} catch (error) {
			logger.warn("MCP tool cache serialize failed", { serverName, error: String(error) });
			return;
		}

		const expiresAtSec = Math.floor((Date.now() + CACHE_TTL_MS) / 1000);
		this.storage.setCache(cacheKey(serverName), serialized, expiresAtSec);
	}
}


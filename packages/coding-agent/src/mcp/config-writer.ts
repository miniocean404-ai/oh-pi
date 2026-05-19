
/**
 * MCP Configuration File Writer
 * MCP 配置文件写入器
 *
 * Utilities for reading/writing .omp/mcp.json files at user or project level.
 * 用于在用户或项目级别读写 .omp/mcp.json 文件的工具函数。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { invalidate as invalidateFsCache } from "../capability/fs";

import { validateServerConfig } from "./config";
import { MCP_CONFIG_SCHEMA_URL, type MCPConfigFile, type MCPServerConfig } from "./types";

/** 为配置添加 $schema 字段 */
function withSchema(config: MCPConfigFile): MCPConfigFile {
	return {
		$schema: config.$schema ?? MCP_CONFIG_SCHEMA_URL,
		...config,
	};
}

/**
 * Read an MCP config file.
 * 读取 MCP 配置文件。
 * Returns empty config if file doesn't exist.
 * 如果文件不存在则返回空配置。
 */
export async function readMCPConfigFile(filePath: string): Promise<MCPConfigFile> {
	try {
		const content = await fs.promises.readFile(filePath, "utf-8");
		const parsed = JSON.parse(content) as MCPConfigFile;
		return parsed;
	} catch (error) {
		if (isEnoent(error)) {
			// 文件不存在，返回空配置
			return { mcpServers: {} };
		}
		throw error;
	}
}

/**
 * Write an MCP config file atomically.
 * 原子化写入 MCP 配置文件。
 * Creates parent directories if they don't exist.
 * 如果父目录不存在则创建。
 */
export async function writeMCPConfigFile(filePath: string, config: MCPConfigFile): Promise<void> {
	// 确保父目录存在
	const dir = path.dirname(filePath);
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

	// 先写入临时文件（原子写入）
	const tmpPath = `${filePath}.tmp`;
	const content = JSON.stringify(withSchema(config), null, 2);
	await fs.promises.writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });

	// 重命名到最终路径（大多数系统上是原子操作）
	await fs.promises.rename(tmpPath, filePath);
	// 使能力文件系统缓存失效，以便后续读取能看到新内容
	invalidateFsCache(filePath);
}

/**
 * Validate server name.
 * 验证服务器名称。
 * @returns Error message if invalid, undefined if valid
 * @returns 无效时返回错误消息，有效时返回 undefined
 */
export function validateServerName(name: string): string | undefined {
	if (!name) {
		return "Server name cannot be empty";
	}
	if (name.length > 100) {
		return "Server name is too long (max 100 characters)";
	}
	// 检查无效字符（仅允许字母数字、破折号、下划线、点号）
	if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
		return "Server name can only contain letters, numbers, dash, underscore, and dot";
	}
	return undefined;
}

/**
 * Add an MCP server to a config file.
 * 向配置文件添加 MCP 服务器。
 * Validates the config before writing.
 * 写入前验证配置。
 *
 * @throws Error if server name already exists or validation fails
 * @throws 如果服务器名称已存在或验证失败则抛出错误
 */
export async function addMCPServer(filePath: string, name: string, config: MCPServerConfig): Promise<void> {
	// 验证服务器名称
	const nameError = validateServerName(name);
	if (nameError) {
		throw new Error(nameError);
	}

	// 验证配置
	const errors = validateServerConfig(name, config);
	if (errors.length > 0) {
		throw new Error(`Invalid server config: ${errors.join("; ")}`);
	}

	// 读取现有配置
	const existing = await readMCPConfigFile(filePath);

	// 检查名称是否重复
	if (existing.mcpServers?.[name]) {
		throw new Error(`Server "${name}" already exists in ${filePath}`);
	}

	// 添加服务器
	const updated: MCPConfigFile = {
		...existing,
		mcpServers: {
			...existing.mcpServers,
			[name]: config,
		},
	};

	// 写回文件
	await writeMCPConfigFile(filePath, updated);
}

/**
 * Update an existing MCP server in a config file.
 * 更新配置文件中已有的 MCP 服务器。
 * If the server doesn't exist, this will add it.
 * 如果服务器不存在则添加。
 *
 * @throws Error if validation fails
 * @throws 如果验证失败则抛出错误
 */
export async function updateMCPServer(filePath: string, name: string, config: MCPServerConfig): Promise<void> {
	// Validate server name
	const nameError = validateServerName(name);
	if (nameError) {
		throw new Error(nameError);
	}

	// Validate the config
	const errors = validateServerConfig(name, config);
	if (errors.length > 0) {
		throw new Error(`Invalid server config: ${errors.join("; ")}`);
	}

	// Read existing config
	const existing = await readMCPConfigFile(filePath);

	// Update server
	const updated: MCPConfigFile = {
		...existing,
		mcpServers: {
			...existing.mcpServers,
			[name]: config,
		},
	};

	// Write back
	await writeMCPConfigFile(filePath, updated);
}

/**
 * Remove an MCP server from a config file.
 * 从配置文件中移除 MCP 服务器。
 *
 * @throws Error if server doesn't exist
 * @throws 如果服务器不存在则抛出错误
 */
export async function removeMCPServer(filePath: string, name: string): Promise<void> {
	// Read existing config
	const existing = await readMCPConfigFile(filePath);

	// Check if server exists
	if (!existing.mcpServers?.[name]) {
		throw new Error(`Server "${name}" not found in ${filePath}`);
	}

	// Remove server
	const { [name]: _removed, ...remaining } = existing.mcpServers;
	const updated: MCPConfigFile = {
		...existing,
		mcpServers: remaining,
	};

	// Write back
	await writeMCPConfigFile(filePath, updated);
}

/**
 * Get a specific server config from a file.
 * 从文件中获取特定服务器配置。
 * Returns undefined if server doesn't exist.
 * 如果服务器不存在则返回 undefined。
 */
export async function getMCPServer(filePath: string, name: string): Promise<MCPServerConfig | undefined> {
	const config = await readMCPConfigFile(filePath);
	return config.mcpServers?.[name];
}

/**
 * List all server names in a config file.
 * 列出配置文件中的所有服务器名称。
 */
export async function listMCPServers(filePath: string): Promise<string[]> {
	const config = await readMCPConfigFile(filePath);
	return Object.keys(config.mcpServers ?? {});
}

/**
 * Read the disabled servers list from a config file.
 * 从配置文件读取禁用服务器列表。
 */
export async function readDisabledServers(filePath: string): Promise<string[]> {
	const config = await readMCPConfigFile(filePath);
	return Array.isArray(config.disabledServers) ? config.disabledServers : [];
}

/**
 * Add or remove a server name from the disabled servers list.
 * 在禁用服务器列表中添加或移除服务器名称。
 */
export async function setServerDisabled(filePath: string, name: string, disabled: boolean): Promise<void> {
	const config = await readMCPConfigFile(filePath);
	const current = new Set(config.disabledServers ?? []);

	if (disabled) {
		current.add(name);
	} else {
		current.delete(name);
	}

	const updated: MCPConfigFile = {
		...config,
		disabledServers: current.size > 0 ? Array.from(current).sort() : undefined,
	};

	if (!updated.disabledServers) {
		delete updated.disabledServers;
	}

	await writeMCPConfigFile(filePath, updated);
}


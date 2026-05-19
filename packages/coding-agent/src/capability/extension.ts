
/**
 * Extensions Capability
 * 扩展能力
 *
 * Gemini-style extensions that provide MCP servers, tools, and context.
 * Gemini 风格的扩展，提供 MCP 服务器、工具和上下文。
 */
import { defineCapability } from ".";
import type { MCPServer } from "./mcp";
import type { SourceMeta } from "./types";

/**
 * Extension manifest structure.
 * 扩展清单结构。
 */
export interface ExtensionManifest {
	/** 扩展名称 */
	name?: string;
	/** 扩展描述 */
	description?: string;
	/** MCP 服务器配置映射 */
	mcpServers?: Record<string, Omit<MCPServer, "name" | "_source">>;
	/** 工具列表 */
	tools?: unknown[];
	/** 上下文数据 */
	context?: unknown;
}

/**
 * A loaded extension.
 * 已加载的扩展。
 */
export interface Extension {
	/** Extension name (from manifest.name or directory name) */
	/** 扩展名称（来自 manifest.name 或目录名） */
	name: string;
	/** Absolute path to extension directory */
	/** 扩展目录的绝对路径 */
	path: string;
	/** Parsed manifest data */
	/** 已解析的清单数据 */
	manifest: ExtensionManifest;
	/** Source level */
	/** 来源层级 */
	level: "user" | "project";
	/** Source metadata */
	/** 来源元数据 */
	_source: SourceMeta;
}

/** 扩展能力定义 */
export const extensionCapability = defineCapability<Extension>({
	id: "extensions",
	displayName: "Extensions",
	description: "Gemini-style extensions providing MCP servers, tools, and context",
	key: ext => ext.name,
	validate: ext => {
		if (!ext.name) return "Missing extension name";
		if (!ext.path) return "Missing extension path";
		return undefined;
	},
});


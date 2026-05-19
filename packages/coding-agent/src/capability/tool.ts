
/**
 * Custom Tools Capability
 * 自定义工具能力
 *
 * User-defined tools that extend agent capabilities.
 * 用户定义的工具，扩展代理的能力。
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A custom tool definition.
 * 自定义工具定义。
 */
export interface CustomTool {
	/** Tool name (unique key) */
	/** 工具名称（唯一键） */
	name: string;
	/** Absolute path to tool definition file */
	/** 工具定义文件的绝对路径 */
	path: string;
	/** Tool description */
	/** 工具描述 */
	description: string;
	/** Tool implementation (script path or inline) */
	/** 工具实现（脚本路径或内联代码） */
	implementation?: string;
	/** Source level */
	/** 来源层级 */
	level: "user" | "project";
	/** Source metadata */
	/** 来源元数据 */
	_source: SourceMeta;
}

/** 自定义工具能力定义 */
export const toolCapability = defineCapability<CustomTool>({
	id: "tools",
	displayName: "Custom Tools",
	description: "User-defined tools that extend agent capabilities",
	key: tool => tool.name,
	toExtensionId: tool => `tool:${tool.name}`,
	validate: tool => {
		if (!tool.name) return "Missing name";
		if (!tool.path) return "Missing path";
		return undefined;
	},
});


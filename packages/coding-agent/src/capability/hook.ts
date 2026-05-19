
/**
 * Hooks Capability
 * 钩子能力
 *
 * Pre/post tool execution hooks defined as shell scripts.
 * 以 shell 脚本定义的工具执行前/后钩子。
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A hook script.
 * 钩子脚本。
 */
export interface Hook {
	/** Hook name (filename without extension) */
	/** 钩子名称（不含扩展名的文件名） */
	name: string;
	/** Absolute path to hook file */
	/** 钩子文件的绝对路径 */
	path: string;
	/** Hook type (pre/post) and associated tool */
	/** 钩子类型（前置/后置）及关联的工具 */
	type: "pre" | "post";
	/** Tool this hook applies to, or "*" for all */
	/** 此钩子应用的工具，"*" 表示所有工具 */
	tool: string;
	/** Source level */
	/** 来源层级 */
	level: "user" | "project";
	/** Source metadata */
	/** 来源元数据 */
	_source: SourceMeta;
}

/** 钩子能力定义 */
export const hookCapability = defineCapability<Hook>({
	id: "hooks",
	displayName: "Hooks",
	description: "Pre/post tool execution hooks",
	key: hook => `${hook.type}:${hook.tool}:${hook.name}`,
	toExtensionId: hook => `hook:${hook.type}:${hook.tool}:${hook.name}`,
	validate: hook => {
		if (!hook.name) return "Missing name";
		if (!hook.path) return "Missing path";
		if (hook.type !== "pre" && hook.type !== "post") return "Invalid type (must be 'pre' or 'post')";
		if (!hook.tool) return "Missing tool";
		return undefined;
	},
});



/**
 * Extension Modules Capability
 * 扩展模块能力
 *
 * TypeScript/JavaScript extension modules loaded by the extension system.
 * 由扩展系统加载的 TypeScript/JavaScript 扩展模块。
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A loaded extension module.
 * 已加载的扩展模块。
 */
export interface ExtensionModule {
	/** Extension module name (derived from path) */
	/** 扩展模块名称（从路径派生） */
	name: string;
	/** Absolute path to extension entrypoint */
	/** 扩展入口文件的绝对路径 */
	path: string;
	/** Source level */
	/** 来源层级 */
	level: "user" | "project";
	/** Source metadata */
	/** 来源元数据 */
	_source: SourceMeta;
}

/** 扩展模块能力定义 */
export const extensionModuleCapability = defineCapability<ExtensionModule>({
	id: "extension-modules",
	displayName: "Extension Modules",
	description: "TypeScript/JavaScript extension modules loaded by the extension system",
	key: ext => ext.name,
	toExtensionId: ext => `extension-module:${ext.name}`,
	validate: ext => {
		if (!ext.name) return "Missing name";
		if (!ext.path) return "Missing path";
		return undefined;
	},
});


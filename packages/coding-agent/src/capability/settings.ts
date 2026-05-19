
/**
 * Settings Capability
 * 设置能力
 *
 * Configuration settings from various sources (JSON, TOML, etc.)
 * 来自各种来源（JSON、TOML 等）的配置设置。
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A settings file.
 * 设置文件。
 */
export interface Settings {
	/** Absolute path to settings file */
	/** 设置文件的绝对路径 */
	path: string;
	/** Parsed settings data */
	/** 已解析的设置数据 */
	data: Record<string, unknown>;
	/** Source level */
	/** 来源层级 */
	level: "user" | "project";
	/** Source metadata */
	/** 来源元数据 */
	_source: SourceMeta;
}

/** 设置能力定义 */
export const settingsCapability = defineCapability<Settings>({
	id: "settings",
	displayName: "Settings",
	description: "Configuration settings from various sources",
	// Settings are merged, not deduplicated by key
	// 设置项会合并，不按键去重
	key: () => undefined,
	validate: settings => {
		if (!settings.path) return "Missing path";
		if (!settings.data || typeof settings.data !== "object") return "Missing or invalid data";
		return undefined;
	},
});


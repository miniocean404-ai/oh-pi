
/**
 * Prompts Capability
 * 提示词能力
 *
 * Reusable prompt templates (Codex format) available via /prompts: menu.
 * 可通过 /prompts: 菜单使用的可复用提示词模板（Codex 格式）。
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A reusable prompt template.
 * 可复用的提示词模板。
 */
export interface Prompt {
	/** Prompt name (filename without extension) */
	/** 提示词名称（不含扩展名的文件名） */
	name: string;
	/** Absolute path to prompt file */
	/** 提示词文件的绝对路径 */
	path: string;
	/** Prompt content (markdown) */
	/** 提示词内容（markdown 格式） */
	content: string;
	/** Source metadata */
	/** 来源元数据 */
	_source: SourceMeta;
}

/** 提示词能力定义 */
export const promptCapability = defineCapability<Prompt>({
	id: "prompts",
	displayName: "Prompts",
	description: "Reusable prompt templates available via /prompts: menu",
	key: prompt => prompt.name,
	toExtensionId: prompt => `prompt:${prompt.name}`,
	validate: prompt => {
		if (!prompt.name) return "Missing name";
		if (!prompt.path) return "Missing path";
		if (prompt.content === undefined) return "Missing content";
		return undefined;
	},
});


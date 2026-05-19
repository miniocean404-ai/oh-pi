
/**
 * System Prompt Capability
 * 系统提示能力
 *
 * Custom system prompt files (SYSTEM.md) that modify the agent's base system prompt.
 * Distinct from context-files which are user instructions shown in conversation.
 * 自定义系统提示文件（SYSTEM.md），用于修改代理的基础系统提示。
 * 与上下文文件（在对话中显示的用户指令）不同。
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A system prompt customization file.
 * 系统提示自定义文件。
 */
export interface SystemPrompt {
	/** Absolute path to the file */
	/** 文件的绝对路径 */
	path: string;
	/** File content */
	/** 文件内容 */
	content: string;
	/** Which level this came from */
	/** 来源层级 */
	level: "user" | "project";
	/** Source metadata */
	/** 来源元数据 */
	_source: SourceMeta;
}

/** 系统提示能力定义 */
export const systemPromptCapability = defineCapability<SystemPrompt>({
	id: "system-prompt",
	displayName: "System Prompt",
	description: "Custom system prompt files (SYSTEM.md) that modify agent behavior",
	key: sp => sp.level,
	validate: sp => {
		if (!sp.path) return "Missing path";
		if (sp.content === undefined) return "Missing content";
		return undefined;
	},
});


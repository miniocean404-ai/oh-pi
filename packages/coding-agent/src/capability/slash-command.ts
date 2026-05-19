
/**
 * Slash Commands Capability
 * 斜杠命令能力
 *
 * File-based slash commands defined as markdown files.
 * 以 markdown 文件定义的基于文件的斜杠命令。
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A file-based slash command.
 * 基于文件的斜杠命令。
 */
export interface SlashCommand {
	/** Command name (without leading slash) */
	/** 命令名称（不含前导斜杠） */
	name: string;
	/** Absolute path to command file */
	/** 命令文件的绝对路径 */
	path: string;
	/** Command content (markdown template) */
	/** 命令内容（markdown 模板） */
	content: string;
	/** Source level */
	/** 来源层级 */
	level: "user" | "project" | "native";
	/** Source metadata */
	/** 来源元数据 */
	_source: SourceMeta;
}

/** 斜杠命令能力定义 */
export const slashCommandCapability = defineCapability<SlashCommand>({
	id: "slash-commands",
	displayName: "Slash Commands",
	description: "Custom slash commands defined as markdown files",
	key: cmd => cmd.name,
	toExtensionId: cmd => `slash-command:${cmd.name}`,
	validate: cmd => {
		if (!cmd.name) return "Missing name";
		if (!cmd.path) return "Missing path";
		if (cmd.content === undefined) return "Missing content";
		if (cmd.level !== "user" && cmd.level !== "project" && cmd.level !== "native") {
			return "Invalid level: must be 'user', 'project', or 'native'";
		}
		return undefined;
	},
});


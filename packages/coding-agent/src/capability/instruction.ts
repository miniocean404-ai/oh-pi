
/**
 * Instructions Capability
 * 指令能力
 *
 * GitHub Copilot-style instructions with optional file pattern matching.
 * GitHub Copilot 风格的指令，支持可选的文件模式匹配。
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * An instruction with optional file pattern matching.
 * 带有可选文件模式匹配的指令。
 */
export interface Instruction {
	/** Instruction name (derived from filename) */
	/** 指令名称（从文件名派生） */
	name: string;
	/** Absolute path to instruction file */
	/** 指令文件的绝对路径 */
	path: string;
	/** Instruction content (markdown) */
	/** 指令内容（markdown 格式） */
	content: string;
	/** Glob pattern for files this applies to */
	/** 此指令适用的文件 glob 模式 */
	applyTo?: string;
	/** Source metadata */
	/** 来源元数据 */
	_source: SourceMeta;
}

/** 指令能力定义 */
export const instructionCapability = defineCapability<Instruction>({
	id: "instructions",
	displayName: "Instructions",
	description: "File-specific instructions with glob pattern matching (GitHub Copilot format)",
	key: inst => inst.name,
	toExtensionId: inst => `instruction:${inst.name}`,
	validate: inst => {
		if (!inst.name) return "Missing name";
		if (!inst.path) return "Missing path";
		if (inst.content === undefined) return "Missing content";
		return undefined;
	},
});


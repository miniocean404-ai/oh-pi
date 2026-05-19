
/**
 * Skills Capability
 * 技能能力
 *
 * Skills provide specialized knowledge or workflows that extend agent capabilities.
 * 技能提供专业知识或工作流，扩展代理的能力。
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * Parsed frontmatter from a skill file.
 * 从技能文件解析的前置元数据。
 */
export interface SkillFrontmatter {
	/** 技能名称 */
	name?: string;
	/** 技能描述 */
	description?: string;
	/** 适用的文件 glob 模式 */
	globs?: string[];
	/** 是否始终应用 */
	alwaysApply?: boolean;
	/**
	 * When `true`, the skill is loaded and accessible via `skill://<name>` (and
	 * `/skill:<name>` slash commands), but is omitted from the rendered system
	 * prompt's skill listing. Use for skills the user opts into explicitly
	 * rather than ones the model should auto-discover.
	 * 为 `true` 时，技能会被加载且可通过 `skill://<name>`（以及
	 * `/skill:<name>` 斜杠命令）访问，但不会出现在系统提示的技能列表中。
	 * 用于用户主动选择的技能，而非模型自动发现的技能。
	 */
	hide?: boolean;
	[key: string]: unknown;
}

/**
 * A skill that provides specialized knowledge or workflows.
 * 提供专业知识或工作流的技能。
 */
export interface Skill {
	/** Skill name (unique key, derived from filename or frontmatter) */
	/** 技能名称（唯一键，从文件名或前置元数据派生） */
	name: string;
	/** Absolute path to skill file */
	/** 技能文件的绝对路径 */
	path: string;
	/** Skill content (markdown) */
	/** 技能内容（markdown 格式） */
	content: string;
	/** Parsed frontmatter */
	/** 已解析的前置元数据 */
	frontmatter?: SkillFrontmatter;
	/** Source level */
	/** 来源层级 */
	level: "user" | "project";
	/** Source metadata */
	/** 来源元数据 */
	_source: SourceMeta;
}

/** 技能能力定义 */
export const skillCapability = defineCapability<Skill>({
	id: "skills",
	displayName: "Skills",
	description: "Specialized knowledge and workflow files that extend agent capabilities",
	key: skill => skill.name,
	toExtensionId: skill => `skill:${skill.name}`,
	validate: skill => {
		if (!skill.name) return "Missing skill name";
		if (!skill.path) return "Missing skill path";
		return undefined;
	},
});


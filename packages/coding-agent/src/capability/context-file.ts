
/**
 * Context Files Capability
 * 上下文文件能力
 *
 * System instruction files (CLAUDE.md, AGENTS.md, GEMINI.md, etc.) that provide
 * persistent guidance to the agent.
 * 系统指令文件（CLAUDE.md、AGENTS.md、GEMINI.md 等），为代理提供持久化的行为指导。
 */
import * as path from "node:path";
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A context file that provides persistent instructions to the agent.
 * 为代理提供持久化指令的上下文文件。
 */
export interface ContextFile {
	/** Absolute path to the file */
	/** 文件的绝对路径 */
	path: string;
	/** File content */
	/** 文件内容 */
	content: string;
	/** Which level this came from */
	/** 来源层级 */
	level: "user" | "project";
	/** Distance from cwd (0 = in cwd, 1 = parent, etc.) for project files */
	/** 距工作目录的深度（0 = 当前目录，1 = 父目录，以此类推），用于项目级文件 */
	depth?: number;
	/** Source metadata */
	/** 来源元数据 */
	_source: SourceMeta;
}

/** 上下文文件能力定义 */
export const contextFileCapability = defineCapability<ContextFile>({
	id: "context-files",
	displayName: "Context Files",
	description: "Persistent instruction files (CLAUDE.md, AGENTS.md, etc.) that guide agent behavior",
	// Deduplicate by scope: one user-level file, and one project-level file per directory depth.
	// 按作用域去重：每个用户级文件保留一个，每个目录深度的项目级文件保留一个。
	// Within each depth level, higher-priority providers shadow lower-priority ones.
	// 在同一深度级别中，高优先级提供者覆盖低优先级提供者。
	// This supports monorepo hierarchies where AGENTS.md exists at multiple ancestor levels.
	// 支持 monorepo 层级结构，AGENTS.md 可能存在于多个祖先目录中。
	// Clamp depth >= 0: files inside config subdirectories of an ancestor (e.g. .claude/, .github/)
	// are same-scope as the ancestor itself.
	// 将 depth 限制为 >= 0：祖先目录的配置子目录（如 .claude/、.github/）中的文件
	// 与祖先目录本身属于同一作用域。
	key: file => (file.level === "user" ? "user" : `project:${Math.max(0, file.depth ?? 0)}`),
	toExtensionId: file => `context-file:${file.level}:${path.basename(file.path)}`,
	validate: file => {
		if (!file.path) return "Missing path";
		if (file.content === undefined) return "Missing content";
		if (file.level !== "user" && file.level !== "project") return "Invalid level: must be 'user' or 'project'";
		return undefined;
	},
});


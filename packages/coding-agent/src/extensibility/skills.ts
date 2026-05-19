
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { skillCapability } from "../capability/skill";
import type { SourceMeta } from "../capability/types";
import type { SkillsSettings } from "../config/settings";
import { type Skill as CapabilitySkill, loadCapability } from "../discovery";
import { compareSkillOrder, scanSkillsFromDir } from "../discovery/helpers";
import type { SkillPromptDetails } from "../session/messages";
import { expandTilde } from "../tools/path-utils";
/** 已加载的 Skill 描述信息 */
export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	source: string;
	/**
	 * When `true`, the skill is loaded and reachable via `skill://<name>` and
	 * (when enabled) `/skill:<name>`, but is excluded from the rendered system
	 * prompt's `<skills>` listing.
	 *
	 * 为 `true` 时，skill 仍会被加载，并可通过 `skill://<name>` 以及
	 * （在启用时）`/skill:<name>` 访问，但不会出现在 system prompt 的
	 * `<skills>` 列表中。
	 */
	hide?: boolean;
	/**
	 * Source metadata for display
	 * 用于展示的来源元数据
	 */
	_source?: SourceMeta;
}

/** 加载 skill 时产生的警告信息 */
export interface SkillWarning {
	skillPath: string;
	message: string;
}

/** 加载 skill 集合的返回结果 */
export interface LoadSkillsResult {
	skills: Skill[];
	warnings: SkillWarning[];
}

let activeSkills: readonly Skill[] = [];

/**
 * Process-global snapshot of skills the active session loaded.
 * Read by internal URL protocol handlers (skill://).
 *
 * 当前进程级别的活跃 skill 快照，由内部 URL 协议处理器（skill://）读取。
 */
export function getActiveSkills(): readonly Skill[] {
	return activeSkills;
}

/**
 * Replace the active skill snapshot. Called once per top-level session.
 * 替换活跃 skill 快照。每个顶层会话调用一次。
 */
export function setActiveSkills(value: readonly Skill[]): void {
	activeSkills = value;
}

/**
 * Reset the active skill snapshot. Test-only.
 * 重置活跃 skill 快照。仅用于测试。
 */
export function resetActiveSkillsForTests(): void {
	activeSkills = [];
}

/** loadSkillsFromDir 的参数 */
export interface LoadSkillsFromDirOptions {
	/**
	 * Directory to scan for skills
	 * 用于扫描 skill 的目录
	 */
	dir: string;
	/**
	 * Source identifier for these skills
	 * 这些 skill 的来源标识
	 */
	source: string;
}

/** 从指定目录加载 skill 集合 */
export async function loadSkillsFromDir(options: LoadSkillsFromDirOptions): Promise<LoadSkillsResult> {
	const [rawProviderId, rawLevel] = options.source.split(":", 2);
	const providerId = rawProviderId || "custom";
	const level: "user" | "project" = rawLevel === "project" ? "project" : "user";
	const result = await scanSkillsFromDir(
		{ cwd: getProjectDir(), home: os.homedir(), repoRoot: null },
		{
			dir: options.dir,
			providerId,
			level,
			requireDescription: true,
		},
	);

	return {
		skills: result.items.map(capSkill => ({
			name: capSkill.name,
			description: typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
			filePath: capSkill.path,
			baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
			source: options.source,
			hide: capSkill.frontmatter?.hide === true,
			_source: capSkill._source,
		})),
		warnings: (result.warnings ?? []).map(message => ({ skillPath: options.dir, message })),
	};
}

/** loadSkills 的参数 */
export interface LoadSkillsOptions extends SkillsSettings {
	/**
	 * Working directory for project-local skills. Default: getProjectDir()
	 * 项目级 skill 的工作目录，默认 getProjectDir()
	 */
	cwd?: string;
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation warnings.
 *
 * 从所有配置的位置加载 skill，返回 skill 列表与校验过程产生的警告。
 */
export async function loadSkills(options: LoadSkillsOptions = {}): Promise<LoadSkillsResult> {
	const {
		cwd = getProjectDir(),
		enabled = true,
		enableCodexUser = true,
		enableClaudeUser = true,
		enableClaudeProject = true,
		enablePiUser = true,
		enablePiProject = true,
		customDirectories = [],
		ignoredSkills = [],
		includeSkills = [],
		disabledExtensions = [],
	} = options;

	// Early return if skills are disabled
	// 如果 skill 功能被禁用，直接返回空结果
	if (!enabled) {
		return { skills: [], warnings: [] };
	}

	const anyBuiltInSkillSourceEnabled =
		enableCodexUser || enableClaudeUser || enableClaudeProject || enablePiUser || enablePiProject;
	// Helper to check if a source is enabled
	// 判断某个来源是否启用
	function isSourceEnabled(source: SourceMeta): boolean {
		const { provider, level } = source;
		if (provider === "codex" && level === "user") return enableCodexUser;
		if (provider === "claude" && level === "user") return enableClaudeUser;
		if (provider === "claude" && level === "project") return enableClaudeProject;
		if (provider === "native" && level === "user") return enablePiUser;
		if (provider === "native" && level === "project") return enablePiProject;
		// For other providers (agents, claude-plugins, etc.), treat them as built-in skill sources.
		// 其他 provider（agents、claude-plugins 等）统一视为内置 skill 来源
		return anyBuiltInSkillSourceEnabled;
	}

	// Use capability API to load all skills
	// 通过 capability API 加载全部 skill
	const result = await loadCapability<CapabilitySkill>(skillCapability.id, { cwd, disabledExtensions });

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const collisionWarnings: SkillWarning[] = [];

	// Check if skill name matches any of the include patterns
	// 判断 skill 名是否匹配任一 include 模式
	function matchesIncludePatterns(name: string): boolean {
		if (includeSkills.length === 0) return true;
		return includeSkills.some(pattern => new Bun.Glob(pattern).match(name));
	}

	// Check if skill name matches any of the ignore patterns
	// 判断 skill 名是否匹配任一 ignore 模式
	function matchesIgnorePatterns(name: string): boolean {
		if (ignoredSkills.length === 0) return false;
		return ignoredSkills.some(pattern => new Bun.Glob(pattern).match(name));
	}

	const disabledSkillNames = new Set(
		(disabledExtensions ?? []).filter(id => id.startsWith("skill:")).map(id => id.slice(6)),
	);
	// Filter skills by source and patterns first
	// 先按来源与匹配模式过滤 skill
	const filteredSkills = result.items.filter(capSkill => {
		if (disabledSkillNames.has(capSkill.name)) return false;
		if (!isSourceEnabled(capSkill._source)) return false;
		if (matchesIgnorePatterns(capSkill.name)) return false;
		if (!matchesIncludePatterns(capSkill.name)) return false;
		return true;
	});

	// Batch resolve all real paths in parallel
	// 并行批量解析所有真实路径（处理 symlink）
	const realPaths = await Promise.all(
		filteredSkills.map(async capSkill => {
			try {
				return await fs.realpath(capSkill.path);
			} catch {
				return capSkill.path;
			}
		}),
	);

	// Process skills with resolved paths
	// 基于解析后的真实路径处理 skill
	for (let i = 0; i < filteredSkills.length; i++) {
		const capSkill = filteredSkills[i];
		const resolvedPath = realPaths[i];

		// Skip silently if we've already loaded this exact file (via symlink)
		// 如果通过 symlink 已经加载过同一个文件，则静默跳过
		if (realPathSet.has(resolvedPath)) {
			continue;
		}

		const existing = skillMap.get(capSkill.name);
		if (existing) {
			collisionWarnings.push({
				skillPath: capSkill.path,
				message: `name collision: "${capSkill.name}" already loaded from ${existing.filePath}, skipping this one`,
			});
		} else {
			skillMap.set(capSkill.name, {
				name: capSkill.name,
				description: typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
				filePath: capSkill.path,
				baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
				source: `${capSkill._source.provider}:${capSkill.level}`,
				hide: capSkill.frontmatter?.hide === true,
				_source: capSkill._source,
			});
			realPathSet.add(resolvedPath);
		}
	}

	const customDirectoryResults = await Promise.all(
		customDirectories.map(async dir => {
			const expandedDir = expandTilde(dir);
			const scanResult = await scanSkillsFromDir(
				{ cwd, home: os.homedir(), repoRoot: null },
				{
					dir: expandedDir,
					providerId: "custom",
					level: "user",
					requireDescription: true,
				},
			);
			return { expandedDir, scanResult };
		}),
	);

	const allCustomSkills: Array<{ skill: Skill; path: string }> = [];
	for (const { expandedDir, scanResult } of customDirectoryResults) {
		for (const capSkill of scanResult.items) {
			if (disabledSkillNames.has(capSkill.name)) continue;
			if (matchesIgnorePatterns(capSkill.name)) continue;
			if (!matchesIncludePatterns(capSkill.name)) continue;
			allCustomSkills.push({
				skill: {
					name: capSkill.name,
					description:
						typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
					filePath: capSkill.path,
					baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
					source: "custom:user",
					hide: capSkill.frontmatter?.hide === true,
					_source: { ...capSkill._source, providerName: "Custom" },
				},
				path: capSkill.path,
			});
		}
		collisionWarnings.push(...(scanResult.warnings ?? []).map(message => ({ skillPath: expandedDir, message })));
	}

	const customRealPaths = await Promise.all(
		allCustomSkills.map(async ({ path }) => {
			try {
				return await fs.realpath(path);
			} catch {
				return path;
			}
		}),
	);

	for (let i = 0; i < allCustomSkills.length; i++) {
		const { skill } = allCustomSkills[i];
		const resolvedPath = customRealPaths[i];
		if (realPathSet.has(resolvedPath)) continue;

		const existing = skillMap.get(skill.name);
		if (existing) {
			collisionWarnings.push({
				skillPath: skill.filePath,
				message: `name collision: "${skill.name}" already loaded from ${existing.filePath}, skipping this one`,
			});
		} else {
			skillMap.set(skill.name, skill);
			realPathSet.add(resolvedPath);
		}
	}

	const skills = Array.from(skillMap.values());
	// Deterministic ordering for prompt stability (case-insensitive, then exact name, then path).
	// 使用确定性排序，保证 prompt 内容稳定（先大小写不敏感，再精确名称，再路径）
	skills.sort((a, b) => compareSkillOrder(a.name, a.filePath, b.name, b.filePath));

	return {
		skills,
		warnings: [...(result.warnings ?? []).map(w => ({ skillPath: "", message: w })), ...collisionWarnings],
	};
}

/** 构造完成的 skill prompt 消息及其详情 */
export interface BuiltSkillPromptMessage {
	message: string;
	details: SkillPromptDetails;
}

/** 获取 skill 对应的 slash 命令名（形如 `skill:<name>`） */
export function getSkillSlashCommandName(skill: Pick<Skill, "name">): string {
	return `skill:${skill.name}`;
}

/**
 * 读取 skill 文件，去除 frontmatter，拼接元信息与用户参数，
 * 生成发送给 LLM 的最终 prompt 消息。
 */
export async function buildSkillPromptMessage(
	skill: Pick<Skill, "name" | "filePath">,
	args: string,
): Promise<BuiltSkillPromptMessage> {
	const content = await Bun.file(skill.filePath).text();
	const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
	const metaLines = [`Skill: ${skill.filePath}`];
	const trimmedArgs = args.trim();
	if (trimmedArgs) {
		metaLines.push(`User: ${trimmedArgs}`);
	}
	const message = `${body}\n\n---\n\n${metaLines.join("\n")}`;
	return {
		message,
		details: {
			name: skill.name,
			path: skill.filePath,
			args: trimmedArgs || undefined,
			lineCount: body ? body.split("\n").length : 0,
		},
	};
}


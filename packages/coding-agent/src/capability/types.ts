
/**
 * Core types for the capability-based config discovery system.
 * 基于能力的配置发现系统的核心类型定义。
 *
 * This architecture inverts control: instead of callers knowing about paths like
 * `.claude`, `.codex`, `.gemini`, they simply ask for `load("mcps")` and get back
 * a unified array of MCP servers.
 * 该架构实现了控制反转：调用方无需了解 `.claude`、`.codex`、`.gemini` 等路径，
 * 只需调用 `load("mcps")` 即可获得统一的 MCP 服务器数组。
 */

/**
 * Context passed to every provider loader.
 * 传递给每个提供者加载器的上下文。
 */
export interface LoadContext {
	/** Current working directory (project root) */
	/** 当前工作目录（项目根目录） */
	cwd: string;
	/** User home directory */
	/** 用户主目录 */
	home: string;
	/** Git repository root (directory containing .git), or null if not in a repo */
	/** Git 仓库根目录（包含 .git 的目录），不在仓库中时为 null */
	repoRoot: string | null;
}

/**
 * Result from a provider's load function.
 * 提供者加载函数的返回结果。
 */
export interface LoadResult<T> {
	/** 加载到的项目列表 */
	items: T[];
	/** Warnings encountered during loading (parse errors, etc.) */
	/** 加载过程中遇到的警告（解析错误等） */
	warnings?: string[];
}

/**
 * A provider that can load items for a capability.
 * 能够为某项能力加载配置项的提供者。
 */
export interface Provider<T> {
	/** Unique provider ID (e.g., "claude", "omp", "mcp-json", "agents-md") */
	/** 唯一的提供者 ID（如 "claude"、"omp"、"mcp-json"、"agents-md"） */
	id: string;

	/** Human-readable name for UI display (e.g., "Claude Code", "OpenAI Codex") */
	/** 用于 UI 展示的可读名称（如 "Claude Code"、"OpenAI Codex"） */
	displayName: string;

	/** Short description for settings UI (e.g., "Load config from ~/.claude and .claude/") */
	/** 用于设置界面的简短描述（如 "从 ~/.claude 和 .claude/ 加载配置"） */
	description: string;

	/**
	 * Priority (higher = checked first, wins on conflicts).
	 * 优先级（值越大越优先检查，冲突时优先采用）。
	 * Suggested ranges:
	 * 建议范围：
	 *   100+ : Primary providers (omp, pi) / 主要提供者
	 *   50-99: Tool-specific providers (claude, codex, gemini) / 工具特定提供者
	 *   1-49 : Shared standards (mcp-json, agents-md) / 共享标准
	 */
	priority: number;

	/**
	 * Load items for this capability.
	 * Returns items in provider's preferred order (usually project before user).
	 * 为此能力加载配置项。
	 * 按提供者偏好的顺序返回（通常项目级在用户级之前）。
	 */
	load(ctx: LoadContext): Promise<LoadResult<T>>;
}

/**
 * Options for loading a capability.
 * 加载能力时的选项。
 */
export interface LoadOptions {
	/** Only use these providers (by ID). Default: all registered */
	/** 仅使用这些提供者（按 ID）。默认：全部已注册的 */
	providers?: string[];
	/** Exclude these providers (by ID). Default: none */
	/** 排除这些提供者（按 ID）。默认：无 */
	excludeProviders?: string[];
	/** Custom cwd. Default: getProjectDir() */
	/** 自定义工作目录。默认：getProjectDir() */
	cwd?: string;
	/** Include items even if they fail validation. Default: false */
	/** 即使验证失败也包含这些项。默认：false */
	includeInvalid?: boolean;
	/** Include items disabled via settings. Default: false */
	/** 包含通过设置禁用的项。默认：false */
	includeDisabled?: boolean;
	/** Explicit disabled extension IDs to apply instead of settings. */
	/** 显式指定要禁用的扩展 ID，替代设置中的值。 */
	disabledExtensions?: string[];
}

/**
 * Source metadata attached to every loaded item.
 * 附加到每个已加载项上的来源元数据。
 */
export interface SourceMeta {
	/** Provider ID that loaded this item */
	/** 加载此项的提供者 ID */
	provider: string;
	/** Provider display name (for UI) */
	/** 提供者显示名称（用于 UI） */
	providerName: string;
	/** Absolute path to the source file */
	/** 源文件的绝对路径 */
	path: string;
	/** Whether this came from user-level, project-level, or native config */
	/** 标识来源层级：用户级、项目级或原生配置 */
	level: "user" | "project" | "native";
}

/**
 * Merged result from loading a capability across all providers.
 * 从所有提供者加载某项能力后的合并结果。
 */
export interface CapabilityResult<T> {
	/** Deduplicated items in priority order */
	/** 按优先级排序的去重项列表 */
	items: Array<T & { _source: SourceMeta }>;
	/** All items including shadowed duplicates (for diagnostics) */
	/** 包含被覆盖重复项的所有项（用于诊断） */
	all: Array<T & { _source: SourceMeta; _shadowed?: boolean }>;
	/** Warnings from all providers */
	/** 所有提供者产生的警告 */
	warnings: string[];
	/** Which providers contributed items (IDs) */
	/** 贡献了配置项的提供者 ID 列表 */
	providers: string[];
}

/**
 * Definition of a capability.
 * 能力的定义。
 */
export interface Capability<T> {
	/** Capability ID (e.g., "mcps", "skills", "context-files") */
	/** 能力 ID（如 "mcps"、"skills"、"context-files"） */
	id: string;

	/** Human-readable name for UI display (e.g., "MCP Servers", "Skills") */
	/** 用于 UI 展示的可读名称（如 "MCP Servers"、"Skills"） */
	displayName: string;

	/** Short description for settings/status UI */
	/** 用于设置/状态界面的简短描述 */
	description: string;

	/**
	 * Extract a unique key from an item for deduplication.
	 * Items with the same key: first one wins (highest priority provider).
	 * Return undefined to never deduplicate (all items kept).
	 * 从项中提取唯一键用于去重。
	 * 相同键的项：第一个生效（最高优先级的提供者）。
	 * 返回 undefined 则不进行去重（保留所有项）。
	 */
	key(item: T): string | undefined;

	/**
	 * Optional validation. Return error message if invalid, undefined if valid.
	 * 可选的验证方法。无效时返回错误消息，有效时返回 undefined。
	 */
	validate?(item: T): string | undefined;

	/**
	 * Optional disabledExtensions ID for this item.
	 * When present, loadCapability() can hide items disabled via settings.
	 * 可选的禁用扩展 ID。
	 * 存在时，loadCapability() 可以隐藏通过设置禁用的项。
	 */
	toExtensionId?(item: T): string | undefined;

	/** Registered providers, sorted by priority (highest first) */
	/** 已注册的提供者列表，按优先级降序排列 */
	providers: Provider<T>[];
}

/**
 * Metadata about a capability (for introspection/UI).
 * 能力的元数据（用于内省/UI 展示）。
 */
export interface CapabilityInfo {
	id: string;
	displayName: string;
	description: string;
	providers: Array<{
		id: string;
		displayName: string;
		description: string;
		priority: number;
		enabled: boolean;
	}>;
}

/**
 * Metadata about a provider (for introspection/UI).
 * 提供者的元数据（用于内省/UI 展示）。
 */
export interface ProviderInfo {
	id: string;
	displayName: string;
	description: string;
	priority: number;
	/** Which capabilities this provider is registered for */
	/** 此提供者注册的能力列表 */
	capabilities: string[];
	/** Whether this provider is currently enabled */
	/** 此提供者是否当前启用 */
	enabled: boolean;
}


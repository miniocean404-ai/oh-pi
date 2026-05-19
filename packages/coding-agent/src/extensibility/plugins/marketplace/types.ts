
/**
 * Marketplace plugin system types.
 *
 * Two registries:
 *   - MarketplacesRegistry: which marketplace catalogs the user has added (config)
 *   - InstalledPluginsRegistry: which plugins are installed (data, Claude Code-compatible)
 *
 * The installed registry MUST pass `parseClaudePluginsRegistry()` validation —
 * it uses `version: 2` (numeric) and `plugins: Record<string, ...[]>`.
 *
 * 插件市场（marketplace）系统类型定义。
 * 包含两个 registry：
 *   - MarketplacesRegistry：用户添加的市场目录列表（配置）
 *   - InstalledPluginsRegistry：已安装插件列表（兼容 Claude Code 格式）
 * 已安装 registry 的结构必须能通过 parseClaudePluginsRegistry() 校验。
 */

// ── Plugin ID helpers ────────────────────────────────────────────────
// 插件 ID 辅助函数：构造 / 解析 "name@marketplace" 形式的唯一标识

const NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const MAX_NAME_LENGTH = 64;
const MAX_ID_LENGTH = 128;

/** Validate a plugin or marketplace name segment. */
/** 校验 plugin / marketplace 名称片段是否合法 */
export function isValidNameSegment(s: string): boolean {
	return s.length > 0 && s.length <= MAX_NAME_LENGTH && NAME_RE.test(s);
}

/** Build canonical plugin ID: `"name@marketplace"`. Both segments are validated. */
/** 构造规范化的插件 ID："name@marketplace"，两个片段都会被校验 */
export function buildPluginId(name: string, marketplace: string): string {
	if (!isValidNameSegment(name)) {
		throw new Error(`Invalid plugin name: "${name}"`);
	}
	if (!isValidNameSegment(marketplace)) {
		throw new Error(`Invalid marketplace name: "${marketplace}"`);
	}
	const id = `${name}@${marketplace}`;
	if (id.length > MAX_ID_LENGTH) {
		throw new Error(`Plugin ID exceeds ${MAX_ID_LENGTH} characters: "${id}"`);
	}
	return id;
}

/** Parse `"name@marketplace"` → `{ name, marketplace }` or `null`. */
/** 将 "name@marketplace" 拆分为对象；非法时返回 null */
export function parsePluginId(id: string): { name: string; marketplace: string } | null {
	const atIndex = id.lastIndexOf("@");
	if (atIndex <= 0 || atIndex === id.length - 1) return null;

	const name = id.slice(0, atIndex);
	const marketplace = id.slice(atIndex + 1);

	if (!isValidNameSegment(name) || !isValidNameSegment(marketplace)) return null;

	return { name, marketplace };
}

// ── Marketplace catalog (from marketplace.json in a marketplace repo) ─
// 市场目录（来自 marketplace 仓库中的 marketplace.json 文件）

/** 市场目录所有者 */
export interface MarketplaceCatalogOwner {
	name: string;
	email?: string;
}

/** 市场目录元数据 */
export interface MarketplaceCatalogMetadata {
	description?: string;
	version?: string;
	/** If set, prepended to relative plugin source paths. */
	/** 若设置，会作为前缀拼接到相对插件 source 路径之前 */
	pluginRoot?: string;
}

/** 完整市场目录结构 */
export interface MarketplaceCatalog {
	name: string;
	owner: MarketplaceCatalogOwner;
	metadata?: MarketplaceCatalogMetadata;
	plugins: MarketplacePluginEntry[];
}

/** 插件作者信息 */
export interface MarketplacePluginAuthor {
	name: string;
	email?: string;
}

/** 市场目录中单个插件条目 */
export interface MarketplacePluginEntry {
	name: string;
	source: PluginSource;
	description?: string;
	version?: string;
	author?: MarketplacePluginAuthor;
	homepage?: string;
	repository?: string;
	license?: string;
	keywords?: string[];
	category?: string;
	tags?: string[];
	strict?: boolean;
	commands?: string | string[];
	agents?: string | string[];
	hooks?: string | Record<string, unknown>;
	mcpServers?: string | Record<string, unknown>;
	lspServers?: string | Record<string, unknown>;
}

// ── Plugin source variants ───────────────────────────────────────────
// 插件来源类型（字符串相对路径或具名对象变体）

/** 插件 source 联合类型：相对路径字符串或具名对象 */
export type PluginSource =
	| string // relative path "./plugins/foo"  // 相对市场仓库根的路径
	| PluginSourceGitHub
	| PluginSourceUrl
	| PluginSourceGitSubdir
	| PluginSourceNpm;

/** 来源：GitHub 仓库 */
export interface PluginSourceGitHub {
	source: "github";
	repo: string;
	ref?: string;
	sha?: string;
}

/** 来源：任意 URL（通常为 git clone URL） */
export interface PluginSourceUrl {
	source: "url";
	url: string;
	ref?: string;
	sha?: string;
}

/** 来源：git 仓库的某个子目录 */
export interface PluginSourceGitSubdir {
	source: "git-subdir";
	url: string;
	path: string;
	ref?: string;
	sha?: string;
}

/** 来源：npm 包（尚未支持） */
export interface PluginSourceNpm {
	source: "npm";
	package: string;
	version?: string;
	registry?: string;
}

// ── Marketplaces registry (stored in <configRoot>/marketplaces.json) ─
// 市场注册表（持久化于 <configRoot>/marketplaces.json）

/** 市场注册表整体结构 */
export interface MarketplacesRegistry {
	version: 1;
	marketplaces: MarketplaceRegistryEntry[];
}

/** 市场来源类型枚举 */
export type MarketplaceSourceType = "github" | "git" | "url" | "local";

/** 市场注册表中单条条目 */
export interface MarketplaceRegistryEntry {
	name: string;
	sourceType: MarketplaceSourceType;
	sourceUri: string;
	catalogPath: string;
	addedAt: string;
	updatedAt: string;
}

// ── Installed plugins registry ───────────────────────────────────────
// 已安装插件注册表：结构必须与 ClaudePluginsRegistry 一致
// （version 为数字、plugins 为 Record<string, entry[]>）以通过其校验。

/** 已安装插件注册表 */
export interface InstalledPluginsRegistry {
	/** MUST be 2 — parseClaudePluginsRegistry rejects non-numeric version. */
	/** 必须为 2，否则 Claude 校验会拒绝 */
	version: 2;
	plugins: Record<string, InstalledPluginEntry[]>;
}

/** 单个已安装插件条目 */
export interface InstalledPluginEntry {
	scope: "user" | "project";
	/** Absolute path to cached plugin directory. */
	installPath: string;
	version: string;
	/** ISO 8601 date string. */
	installedAt: string;
	/** ISO 8601 date string. */
	lastUpdated: string;
	/** For git-sourced plugins. */
	gitCommitSha?: string;
	/** OMP extension — not in Claude Code's type. CLI/UI concern only in v1. */
	enabled?: boolean;
}

/**
 * A merged view of an installed plugin, combining entries from both the user and
 * project registries. Returned by MarketplaceManager.listInstalledPlugins().
 *
 * `shadowedBy` is set on user-scoped summaries when the same plugin ID also exists
 * in the project registry — the project entry takes precedence for capability loading.
 *
 * 已安装插件的合并视图：同时融合 user 与 project 两个 registry。
 * 当用户级插件被项目级同名插件覆盖时，user 视图会标记 shadowedBy: "project"。
 */
export interface InstalledPluginSummary {
	id: string;
	scope: "user" | "project";
	entries: InstalledPluginEntry[];
	/** Set when a user-scoped plugin is overridden by a project-scoped install. */
	shadowedBy?: "project";
}



// =============================================================================
// Plugin Manifest Types (from package.json omp/pi field)
// 插件清单类型（来自 package.json 中的 omp/pi 字段）
// =============================================================================

/**
 * Feature definition for selective plugin installation.
 * Features allow plugins to expose optional functionality.
 *
 * 插件特性（feature）定义，用于按需安装/启用插件的可选功能。
 */
export interface PluginFeature {
	/** Human-readable description */
	description?: string;
	/** Whether this feature is enabled by default */
	default?: boolean;
	/** Additional extension entry points provided by this feature */
	extensions?: string[];
	/** Additional tool entry points provided by this feature */
	tools?: string[];
	/** Additional hook entry points provided by this feature */
	hooks?: string[];
	/** Additional command files provided by this feature */
	commands?: string[];
}

/**
 * Plugin manifest from package.json omp or pi field.
 *
 * 插件清单：从 package.json 的 omp 或 pi 字段读取。
 */
export interface PluginManifest {
	/** Plugin display name (defaults to package name) */
	name?: string;
	/** Plugin version (copied from package.json version) */
	version: string;
	/** Human-readable description */
	description?: string;

	/** Entry point for base tools (relative path from package root) */
	tools?: string;
	/** Entry point for base hooks (relative path from package root) */
	hooks?: string;
	/** Extension entry points (relative paths from package root) */
	extensions?: string[];
	/** Command files (relative paths from package root) */
	commands?: string[];

	/** Feature definitions for selective installation */
	features?: Record<string, PluginFeature>;

	/** Settings schema for plugin configuration */
	settings?: Record<string, PluginSettingSchema>;
}

// =============================================================================
// Plugin Settings Schema Types
// 插件设置 Schema 类型定义
// =============================================================================

/** 插件设置项支持的取值类型 */
export type PluginSettingType = "string" | "number" | "boolean" | "enum";

interface PluginSettingBase {
	/** Setting type */
	type: PluginSettingType;
	/** Human-readable description */
	description?: string;
	/** If true, mask value in UI and logs */
	secret?: boolean;
	/** Environment variable to use as fallback value */
	env?: string;
}

/** 字符串类型设置 */
export interface StringSetting extends PluginSettingBase {
	type: "string";
	default?: string;
}

/** 数值类型设置（支持 min/max/step 范围约束） */
export interface NumberSetting extends PluginSettingBase {
	type: "number";
	default?: number;
	min?: number;
	max?: number;
	step?: number;
}

/** 布尔类型设置 */
export interface BooleanSetting extends PluginSettingBase {
	type: "boolean";
	default?: boolean;
}

/** 枚举类型设置（限定在 values 列表内取值） */
export interface EnumSetting extends PluginSettingBase {
	type: "enum";
	/** Allowed values */
	/** 允许的取值列表 */
	values: string[];
	default?: string;
}

/** 插件设置 Schema 的联合类型 */
export type PluginSettingSchema = StringSetting | NumberSetting | BooleanSetting | EnumSetting;

// =============================================================================
// Installed Plugin Types
// 已安装插件相关类型
// =============================================================================

/**
 * Represents an installed plugin with full metadata.
 *
 * 表示一个已安装插件，含完整元数据。
 */
export interface InstalledPlugin {
	/** npm package name */
	name: string;
	/** Installed version */
	version: string;
	/** Absolute path to package directory */
	path: string;
	/** Parsed omp/pi manifest */
	manifest: PluginManifest;
	/**
	 * Enabled features:
	 * - null: use defaults (all features with default: true)
	 * - string[]: specific features enabled
	 */
	enabledFeatures: string[] | null;
	/** Whether the plugin is enabled */
	enabled: boolean;
}

// =============================================================================
// Runtime Config Types (stored in omp-plugins.lock.json)
// 运行时配置类型（持久化于 omp-plugins.lock.json）
// =============================================================================

/**
 * Per-plugin runtime state stored in lock file.
 *
 * 单个插件在 lock 文件中保存的运行时状态。
 */
export interface PluginRuntimeState {
	/** Installed version */
	version: string;
	/** Enabled features (null = defaults) */
	enabledFeatures: string[] | null;
	/** Whether the plugin is enabled */
	enabled: boolean;
}

/**
 * Runtime configuration persisted to omp-plugins.lock.json.
 * Tracks plugin states and settings across sessions.
 *
 * 持久化到 omp-plugins.lock.json 的运行时配置，跨会话保存插件状态和设置。
 */
export interface PluginRuntimeConfig {
	/** Plugin states keyed by package name */
	plugins: Record<string, PluginRuntimeState>;
	/** Plugin settings keyed by package name, then setting key */
	settings: Record<string, Record<string, unknown>>;
}

// =============================================================================
// Project Override Types
// 项目级覆盖配置类型
// =============================================================================

/**
 * Project-local plugin overrides (stored in .omp/plugin-overrides.json).
 * Allows per-project plugin configuration without modifying global state.
 *
 * 项目本地的插件覆盖配置（存于 .omp/plugin-overrides.json），允许按项目调整插件而不改全局状态。
 */
export interface ProjectPluginOverrides {
	/** Plugins to disable in this project */
	disabled?: string[];
	/** Per-plugin feature overrides */
	features?: Record<string, string[]>;
	/** Per-plugin setting overrides */
	settings?: Record<string, Record<string, unknown>>;
}

// =============================================================================
// Doctor Types
// 健康检查（doctor）相关类型
// =============================================================================

/** 单项健康检查结果 */
export interface DoctorCheck {
	/** Check identifier */
	name: string;
	/** Check result status */
	status: "ok" | "warning" | "error";
	/** Human-readable message */
	message: string;
	/** Whether --fix resolved this issue */
	fixed?: boolean;
}

// =============================================================================
// Install Options Types
// 安装/检查选项类型
// =============================================================================

/** install() 调用的可选参数 */
export interface InstallOptions {
	/** Overwrite existing without prompting */
	/** 不提示直接覆盖已有插件 */
	force?: boolean;
	/** Preview changes without applying */
	/** 预演模式：仅展示变更，不实际执行 */
	dryRun?: boolean;
}

/** doctor() 调用的可选参数 */
export interface DoctorOptions {
	/** Attempt automatic fixes */
	/** 是否尝试自动修复发现的问题 */
	fix?: boolean;
}


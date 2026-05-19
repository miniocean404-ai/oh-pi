
/**
 * Plugin loader - discovers and loads manifest entry points from installed plugins.
 *
 * Reads enabled plugins from the runtime config and loads their
 * tools/hooks/extensions/commands based on manifest entries and enabled features.
 *
 * 插件加载器：发现并加载已安装插件清单中声明的入口点。
 * 从运行时配置读取启用的插件，按清单条目及已启用特性加载其 tools / hooks / extensions / commands。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getPluginsLockfile, getPluginsNodeModules, getPluginsPackageJson, isEnoent } from "@oh-my-pi/pi-utils";
import { getConfigDirPaths } from "../../config";
import { installLegacyPiSpecifierShim } from "./legacy-pi-compat";
import type { InstalledPlugin, PluginManifest, PluginRuntimeConfig, ProjectPluginOverrides } from "./types";

installLegacyPiSpecifierShim();

// =============================================================================
// Runtime Config Loading
// 运行时配置加载
// =============================================================================

/**
 * Load plugin runtime config from lock file.
 *
 * 从 lock 文件加载插件运行时配置；文件不存在则返回空配置。
 */
async function loadRuntimeConfig(): Promise<PluginRuntimeConfig> {
	const lockPath = getPluginsLockfile();
	try {
		return await Bun.file(lockPath).json();
	} catch (err) {
		if (isEnoent(err)) return { plugins: {}, settings: {} };
		throw err;
	}
}

/**
 * Load project-local plugin overrides (checks .omp and .pi directories).
 *
 * 加载项目本地的插件覆盖配置（依次检查 .omp 与 .pi 目录）。
 */
async function loadProjectOverrides(cwd: string): Promise<ProjectPluginOverrides> {
	for (const overridesPath of getConfigDirPaths("plugin-overrides.json", { user: false, cwd })) {
		try {
			return await Bun.file(overridesPath).json();
		} catch (err) {
			if (isEnoent(err)) continue;
			// JSON parse error - continue to next path
			// JSON 解析错误：继续尝试下一个候选路径
		}
	}
	return {};
}
/**
 * Get list of enabled plugins with their resolved configurations.
 * Respects both global runtime config and project overrides.
 *
 * 获取所有已启用插件及其解析后的配置；同时考虑全局运行时配置与项目级覆盖。
 */
export async function getEnabledPlugins(cwd: string): Promise<InstalledPlugin[]> {
	const pkgJsonPath = getPluginsPackageJson();
	let pkg: { dependencies?: Record<string, string> };
	try {
		pkg = await Bun.file(pkgJsonPath).json();
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	const nodeModulesPath = getPluginsNodeModules();
	if (!fs.existsSync(nodeModulesPath)) {
		return [];
	}

	const deps = pkg.dependencies || {};
	const runtimeConfig = await loadRuntimeConfig();
	const projectOverrides = await loadProjectOverrides(cwd);
	const plugins: InstalledPlugin[] = [];
	for (const [name] of Object.entries(deps)) {
		const pluginPkgPath = path.join(nodeModulesPath, name, "package.json");
		let pluginPkg: { version: string; omp?: PluginManifest; pi?: PluginManifest };
		try {
			pluginPkg = await Bun.file(pluginPkgPath).json();
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}

		const manifest: PluginManifest | undefined = pluginPkg.omp || pluginPkg.pi;

		if (!manifest) {
			// Not an omp plugin, skip
			// 没有 omp/pi 字段则不是 omp 插件，跳过
			continue;
		}

		manifest.version = pluginPkg.version;

		const runtimeState = runtimeConfig.plugins[name];

		// Check if disabled globally
		// 全局禁用则跳过
		if (runtimeState && !runtimeState.enabled) {
			continue;
		}

		// Check if disabled in project
		// 项目级禁用则跳过
		if (projectOverrides.disabled?.includes(name)) {
			continue;
		}

		// Resolve enabled features (project overrides take precedence)
		// 解析启用的特性（项目覆盖优先于全局配置）
		const enabledFeatures = projectOverrides.features?.[name] ?? runtimeState?.enabledFeatures ?? null;
		plugins.push({
			name,
			version: pluginPkg.version,
			path: path.join(nodeModulesPath, name),
			manifest,
			enabledFeatures,
			enabled: true,
		});
	}

	return plugins;
}

// =============================================================================
// Path Resolution
// 入口路径解析
// =============================================================================

const MANIFEST_ENTRY_INDEX_NAMES = ["index.ts", "index.js", "index.mjs", "index.cjs"];

/**
 * Resolve a plugin manifest entry to a concrete loadable file path. Returns the
 * file path itself when the entry points at a file, the matching index file when
 * the entry points at a directory containing index.{ts,js,mjs,cjs}, and null
 * when no entry exists at the joined path.
 *
 * 将插件清单中的入口路径解析为实际可加载的文件路径：
 * - 指向文件 -> 直接返回该路径
 * - 指向目录 -> 返回目录下首个存在的 index.{ts,js,mjs,cjs}
 * - 都不存在则返回 null
 */
function resolveManifestEntryFile(joined: string): string | null {
	let stats: fs.Stats;
	try {
		stats = fs.statSync(joined);
	} catch {
		return null;
	}
	if (stats.isDirectory()) {
		for (const name of MANIFEST_ENTRY_INDEX_NAMES) {
			const candidate = path.join(joined, name);
			if (fs.existsSync(candidate)) return candidate;
		}
		return null;
	}
	return joined;
}

/**
 * Generic path resolver for plugin manifest entries (tools, hooks, commands, extensions).
 * Handles both single-string and string[] base entries, plus feature-specific entries.
 *
 * 通用的清单入口路径解析器（适用于 tools/hooks/commands/extensions）。
 * 同时处理：基础入口（单字符串或字符串数组）与按 feature 划分的额外入口。
 */
function resolvePluginPaths(plugin: InstalledPlugin, key: "tools" | "hooks" | "commands" | "extensions"): string[] {
	const paths: string[] = [];
	const manifest = plugin.manifest;

	// Base entry (always included if exists)
	// 基础入口（只要存在则始终包含）
	const base = manifest[key];
	if (base) {
		const entries = Array.isArray(base) ? base : [base];
		for (const entry of entries) {
			const resolved = resolveManifestEntryFile(path.join(plugin.path, entry));
			if (resolved) {
				paths.push(resolved);
			}
		}
	}

	// Feature-specific entries
	// 处理按 feature 划分的入口
	if (manifest.features && plugin.enabledFeatures) {
		const enabledSet = new Set(plugin.enabledFeatures);

		for (const [featName, feat] of Object.entries(manifest.features)) {
			if (!enabledSet.has(featName)) continue;

			if (feat[key]) {
				for (const entry of feat[key]) {
					const resolved = resolveManifestEntryFile(path.join(plugin.path, entry));
					if (resolved) {
						paths.push(resolved);
					}
				}
			}
		}
	} else if (manifest.features && plugin.enabledFeatures === null) {
		// null means use defaults - enable features with default: true
		// enabledFeatures 为 null 表示使用默认值：启用所有 default: true 的特性
		for (const [_featName, feat] of Object.entries(manifest.features)) {
			if (!feat.default) continue;

			if (feat[key]) {
				for (const entry of feat[key]) {
					const resolved = resolveManifestEntryFile(path.join(plugin.path, entry));
					if (resolved) {
						paths.push(resolved);
					}
				}
			}
		}
	}

	return paths;
}

/** 解析单个插件的 tool 入口路径 */
export function resolvePluginToolPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "tools");
}

/** 解析单个插件的 hook 入口路径 */
export function resolvePluginHookPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "hooks");
}

/** 解析单个插件的 command 入口路径 */
export function resolvePluginCommandPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "commands");
}

/** 解析单个插件的 extension 入口路径 */
export function resolvePluginExtensionPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "extensions");
}

// =============================================================================
// Aggregated Discovery
// 聚合发现：跨所有启用插件汇总入口
// =============================================================================

/**
 * Get all tool paths from all enabled plugins.
 *
 * 汇总所有启用插件的 tool 入口路径。
 */
export async function getAllPluginToolPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginToolPaths(plugin));
	}

	return paths;
}

/**
 * Get all hook paths from all enabled plugins.
 *
 * 汇总所有启用插件的 hook 入口路径。
 */
export async function getAllPluginHookPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginHookPaths(plugin));
	}

	return paths;
}

/**
 * Get all command paths from all enabled plugins.
 *
 * 汇总所有启用插件的 command 入口路径。
 */
export async function getAllPluginCommandPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginCommandPaths(plugin));
	}

	return paths;
}

/**
 * Get all extension module paths from all enabled plugins.
 *
 * 汇总所有启用插件的 extension 模块入口路径。
 */
export async function getAllPluginExtensionPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginExtensionPaths(plugin));
	}

	return paths;
}

/**
 * Get plugin settings for use in tool/hook contexts.
 * Merges global settings with project overrides.
 *
 * 获取插件设置，供 tool/hook 运行时使用；合并全局设置与项目级覆盖（后者优先）。
 */
export async function getPluginSettings(pluginName: string, cwd: string): Promise<Record<string, unknown>> {
	const runtimeConfig = await loadRuntimeConfig();
	const projectOverrides = await loadProjectOverrides(cwd);

	const global = runtimeConfig.settings[pluginName] || {};
	const project = projectOverrides.settings?.[pluginName] || {};

	return { ...global, ...project };
}


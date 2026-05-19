
/**
 * Registry read/write operations for the marketplace plugin system.
 *
 * Two registries:
 *   - marketplaces.json under getConfigRootDir() — which catalogs the user has added
 *   - installed_plugins.json under getPluginsDir() — which plugins are installed
 *
 * Read/write functions accept explicit file paths so callers control the
 * location. Path helpers compute the default paths from the dir singleton.
 *
 * Both use atomic write (tmp + rename). On Windows, rename over existing file
 * can fail with EPERM — fallback: unlink target then rename.
 *
 * 市场插件系统的注册表读写。
 * 两个注册表：
 *   - marketplaces.json（位于 getConfigRootDir()）—— 用户添加的市场列表
 *   - installed_plugins.json（位于 getPluginsDir()）—— 已安装的插件列表
 * 读写函数显式接收文件路径，便于测试与覆盖；写操作通过 tmp + rename 保证原子性。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getConfigRootDir, getPluginsDir, isEnoent, logger, tryParseJson } from "@oh-my-pi/pi-utils";

import type {
	InstalledPluginEntry,
	InstalledPluginsRegistry,
	MarketplaceRegistryEntry,
	MarketplacesRegistry,
} from "./types";

// ── Path helpers ─────────────────────────────────────────────────────
// 默认路径辅助函数

/** 市场注册表 marketplaces.json 的默认绝对路径 */
export function getMarketplacesRegistryPath(): string {
	return path.join(getConfigRootDir(), "marketplaces.json");
}

/** 已安装插件注册表的默认绝对路径 */
export function getInstalledPluginsRegistryPath(): string {
	return path.join(getPluginsDir(), "installed_plugins.json");
}

/** 市场克隆缓存目录的默认绝对路径 */
export function getMarketplacesCacheDir(): string {
	return path.join(getPluginsDir(), "cache", "marketplaces");
}

/** 插件缓存目录的默认绝对路径 */
export function getPluginsCacheDir(): string {
	return path.join(getPluginsDir(), "cache", "plugins");
}

// ── Atomic write ─────────────────────────────────────────────────────
// 原子写入：tmp + rename，并在 Windows 上 EPERM 时回退到 unlink + rename

/** 原子写入 JSON：先写 tmp，再 rename；Windows 上 EPERM 时先 unlink 再 rename */
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
	const content = `${JSON.stringify(data, null, 2)}\n`;
	const tmpPath = `${filePath}.tmp`;

	await Bun.write(tmpPath, content);

	try {
		await fs.rename(tmpPath, filePath);
	} catch (err) {
		// Windows EPERM fallback: unlink target, then rename
		// Windows 上 rename 可能因 EPERM 失败：先尝试 unlink 目标再 rename
		if ((err as NodeJS.ErrnoException).code === "EPERM") {
			try {
				await fs.unlink(filePath);
			} catch {
				// Target may not exist — that's fine
				// 目标不存在也无妨
			}
			await fs.rename(tmpPath, filePath);
		} else {
			// Clean up tmp on unexpected errors
			// 其他异常时清理 tmp 文件
			try {
				await fs.unlink(tmpPath);
			} catch {
				// Best effort
				// 尽力清理
			}
			throw err;
		}
	}
}

// ── Marketplaces registry ────────────────────────────────────────────
// 市场注册表的读写

/** 返回空的市场注册表骨架 */
function emptyMarketplacesRegistry(): MarketplacesRegistry {
	return { version: 1, marketplaces: [] };
}

/** 读取市场注册表；文件不存在或非法时返回空注册表 */
export async function readMarketplacesRegistry(filePath: string): Promise<MarketplacesRegistry> {
	try {
		const content = await Bun.file(filePath).text();
		const data = tryParseJson<MarketplacesRegistry>(content);
		if (!data || typeof data !== "object" || data.version !== 1 || !Array.isArray(data.marketplaces)) {
			logger.warn("Invalid marketplaces registry, returning empty", { path: filePath });
			return emptyMarketplacesRegistry();
		}
		return data;
	} catch (err) {
		if (isEnoent(err)) return emptyMarketplacesRegistry();
		throw err;
	}
}

/** 原子写入市场注册表 */
export async function writeMarketplacesRegistry(filePath: string, reg: MarketplacesRegistry): Promise<void> {
	await atomicWriteJson(filePath, reg);
}

// ── Installed plugins registry ───────────────────────────────────────
// 已安装插件注册表

/** 返回空的已安装插件注册表骨架 */
function emptyInstalledPluginsRegistry(): InstalledPluginsRegistry {
	return { version: 2, plugins: {} };
}

/** 读取已安装插件注册表；文件不存在或非法时返回空注册表 */
export async function readInstalledPluginsRegistry(filePath: string): Promise<InstalledPluginsRegistry> {
	try {
		const content = await Bun.file(filePath).text();
		const data = tryParseJson<InstalledPluginsRegistry>(content);
		if (
			!data ||
			typeof data !== "object" ||
			typeof data.version !== "number" ||
			!data.plugins ||
			typeof data.plugins !== "object" ||
			Array.isArray(data.plugins)
		) {
			logger.warn("Invalid installed plugins registry, returning empty", { path: filePath });
			return emptyInstalledPluginsRegistry();
		}
		// Accept any numeric version — forward compatible reads
		// 接受任意数字版本，向前兼容旧/新版本结构
		return { ...data, version: 2 };
	} catch (err) {
		if (isEnoent(err)) return emptyInstalledPluginsRegistry();
		throw err;
	}
}

/** 原子写入已安装插件注册表 */
export async function writeInstalledPluginsRegistry(filePath: string, reg: InstalledPluginsRegistry): Promise<void> {
	await atomicWriteJson(filePath, reg);
}

// ── Marketplace CRUD ─────────────────────────────────────────────────
// Pure functions that transform registry state. Caller is responsible for
// reading, mutating, and writing back.
// 市场注册表的纯函数式 CRUD：调用方负责读取 → 转换 → 回写

/** 向市场注册表添加一条目；重名会抛错 */
export function addMarketplaceEntry(reg: MarketplacesRegistry, entry: MarketplaceRegistryEntry): MarketplacesRegistry {
	if (reg.marketplaces.some(m => m.name === entry.name)) {
		throw new Error(`Marketplace "${entry.name}" already exists`);
	}
	return { ...reg, marketplaces: [...reg.marketplaces, entry] };
}

/** 按名字移除市场注册表条目；未找到会抛错 */
export function removeMarketplaceEntry(reg: MarketplacesRegistry, name: string): MarketplacesRegistry {
	const filtered = reg.marketplaces.filter(m => m.name !== name);
	if (filtered.length === reg.marketplaces.length) {
		throw new Error(`Marketplace "${name}" not found`);
	}
	return { ...reg, marketplaces: filtered };
}

/** 按名字查询市场注册表条目 */
export function getMarketplaceEntry(reg: MarketplacesRegistry, name: string): MarketplaceRegistryEntry | undefined {
	return reg.marketplaces.find(m => m.name === name);
}

// ── Installed plugin CRUD ────────────────────────────────────────────
// 已安装插件注册表的纯函数式 CRUD

/** 追加一条已安装插件记录（同 id 允许多条，例如 user+project 多 scope） */
export function addInstalledPlugin(
	reg: InstalledPluginsRegistry,
	id: string,
	entry: InstalledPluginEntry,
): InstalledPluginsRegistry {
	const existing = reg.plugins[id] ?? [];
	return {
		...reg,
		plugins: { ...reg.plugins, [id]: [...existing, entry] },
	};
}

/** 移除指定 pluginId 对应的全部记录；未找到会抛错 */
export function removeInstalledPlugin(reg: InstalledPluginsRegistry, id: string): InstalledPluginsRegistry {
	if (!(id in reg.plugins)) {
		throw new Error(`Plugin "${id}" not found in registry`);
	}
	const { [id]: _, ...rest } = reg.plugins;
	return { ...reg, plugins: rest };
}

/** 查询指定 pluginId 的全部记录 */
export function getInstalledPlugin(reg: InstalledPluginsRegistry, id: string): InstalledPluginEntry[] | undefined {
	return reg.plugins[id];
}

/**
 * Collect all installPath values referenced by any of the provided registries.
 * Use this before deleting a cached plugin directory to verify it is not still
 * referenced by another scope's registry.
 *
 * 收集传入的多个注册表中所引用的所有 installPath；
 * 在删除某个缓存目录前用以确认其未被其他 scope 引用。
 */
export function collectReferencedPaths(...registries: InstalledPluginsRegistry[]): Set<string> {
	return new Set(
		registries.flatMap(r =>
			Object.values(r.plugins)
				.flat()
				.map(e => e.installPath),
		),
	);
}


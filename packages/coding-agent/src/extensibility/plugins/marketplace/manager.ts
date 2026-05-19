
/**
 * MarketplaceManager — orchestrates registry, fetcher, resolver, and cache.
 *
 * Constructor takes explicit paths for testability (same pattern as registry.ts).
 * The `clearPluginRootsCache` dependency is injected so callers can provide
 * the real `clearClaudePluginRootsCache` while tests supply a counter stub.
 *
 * MarketplaceManager：协调注册表、抓取器、源解析器与缓存四个子系统。
 * 构造时显式接收路径，便于测试覆盖；`clearPluginRootsCache` 以依赖注入方式提供，
 * 生产环境传入真实实现，测试环境可传入计数桩。
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { isEnoent, logger } from "@oh-my-pi/pi-utils";

import { cachePlugin } from "./cache";
import { classifySource, fetchMarketplace, parseMarketplaceCatalog, promoteCloneToCache } from "./fetcher";
import {
	addInstalledPlugin,
	addMarketplaceEntry,
	collectReferencedPaths,
	getInstalledPlugin,
	getMarketplaceEntry,
	readInstalledPluginsRegistry,
	readMarketplacesRegistry,
	removeInstalledPlugin,
	removeMarketplaceEntry,
	writeInstalledPluginsRegistry,
	writeMarketplacesRegistry,
} from "./registry";
import { resolvePluginSource } from "./source-resolver";
import type {
	InstalledPluginEntry,
	InstalledPluginSummary,
	InstalledPluginsRegistry,
	MarketplaceCatalog,
	MarketplacePluginEntry,
	MarketplaceRegistryEntry,
} from "./types";
import { buildPluginId, parsePluginId } from "./types";

// ── Options ──────────────────────────────────────────────────────────────────
// 管理器配置选项

/** MarketplaceManager 构造选项 */
export interface MarketplaceManagerOptions {
	marketplacesRegistryPath: string;
	installedRegistryPath: string;
	/**
	 * Path to the project-scoped installed_plugins.json.
	 * Required when installPlugin / uninstallPlugin is called with scope: "project".
	 * Resolved by resolveActiveProjectRegistryPath(cwd) in callers.
	 */
	projectInstalledRegistryPath?: string;
	marketplacesCacheDir: string;
	pluginsCacheDir: string;
	/** Injected for testing; production callers pass clearClaudePluginRootsCache.
	 *  Receives any additional file paths that should also be invalidated from the fs cache.
	 */
	clearPluginRootsCache?: (extraPaths?: readonly string[]) => void;
}

// ── Manager ──────────────────────────────────────────────────────────────────
// 管理器主体实现

/** 市场插件总管理器：负责市场增删/更新、插件安装/卸载/启停/升级等编排 */
export class MarketplaceManager {
	#opts: MarketplaceManagerOptions;

	constructor(options: MarketplaceManagerOptions) {
		this.#opts = options;
	}

	// Invalidate fs caches for all registry paths the manager writes, then clear plugin roots.
	// 失效所有由本管理器写入的注册表路径的 fs 缓存，然后清空插件根缓存
	#clearCache(): void {
		const extra = this.#opts.projectInstalledRegistryPath
			? ([this.#opts.projectInstalledRegistryPath] as readonly string[])
			: undefined;
		this.#opts.clearPluginRootsCache?.(extra);
	}

	// ── Marketplace lifecycle ─────────────────────────────────────────────────
	// 市场生命周期：添加 / 移除 / 更新 / 列出

	/** 添加一个市场：抓取目录、检测重名、登记到注册表 */
	async addMarketplace(source: string): Promise<MarketplaceRegistryEntry> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const existingNames = new Set(reg.marketplaces.map(m => m.name));

		const { catalog, clonePath } = await fetchMarketplace(source, this.#opts.marketplacesCacheDir);

		if (existingNames.has(catalog.name)) {
			if (clonePath) {
				await fs.rm(clonePath, { recursive: true, force: true }).catch(() => {});
			}
			throw new Error(`Marketplace "${catalog.name}" already exists`);
		}

		// Promote the temp clone to its final cache location now that we know it's not a duplicate.
		// 确认非重名后，将临时克隆目录提升到最终缓存位置
		if (clonePath) {
			await promoteCloneToCache(clonePath, this.#opts.marketplacesCacheDir, catalog.name);
		}

		const sourceType = classifySource(source);
		const normalizedSource =
			sourceType === "local"
				? path.resolve(source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source)
				: source;

		const catalogPath = path.join(this.#opts.marketplacesCacheDir, catalog.name, "marketplace.json");

		// Persist the fetched catalog so subsequent reads don't require re-fetching.
		// 持久化抓取到的目录文件，后续读取无需再次远端抓取
		await Bun.write(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

		const now = new Date().toISOString();
		const entry: MarketplaceRegistryEntry = {
			name: catalog.name,
			sourceType,
			sourceUri: normalizedSource,
			catalogPath,
			addedAt: now,
			updatedAt: now,
		};

		const updated = addMarketplaceEntry(reg, entry);
		await writeMarketplacesRegistry(this.#opts.marketplacesRegistryPath, updated);

		logger.debug("Marketplace added", { name: catalog.name, sourceType });
		return entry;
	}

	/** 移除一个市场：从注册表删除并清理对应缓存目录 */
	async removeMarketplace(name: string): Promise<void> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		// removeMarketplaceEntry throws if not found — propagate to caller.
		// 未找到时 removeMarketplaceEntry 会抛错，原样向上抛
		const updated = removeMarketplaceEntry(reg, name);
		await writeMarketplacesRegistry(this.#opts.marketplacesRegistryPath, updated);

		await fs.rm(path.join(this.#opts.marketplacesCacheDir, name), {
			recursive: true,
			force: true,
		});

		logger.debug("Marketplace removed", { name });
	}

	/** 更新指定市场：重新抓取目录、校验名称未漂移并覆盖缓存 */
	async updateMarketplace(name: string): Promise<MarketplaceRegistryEntry> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const existing = getMarketplaceEntry(reg, name);
		if (!existing) {
			throw new Error(`Marketplace "${name}" not found`);
		}

		const { catalog, clonePath } = await fetchMarketplace(existing.sourceUri, this.#opts.marketplacesCacheDir);

		// Guard against upstream catalog silently renaming itself — the registry
		// entry is keyed by name, so a drift would corrupt the entry on next read.
		// 防御上游目录文件偷偷改名：注册表以 name 为键，名称漂移会破坏后续读取
		if (catalog.name !== name) {
			if (clonePath) {
				await fs.rm(clonePath, { recursive: true, force: true }).catch(() => {});
			}
			throw new Error(
				`Marketplace catalog name changed from "${name}" to "${catalog.name}". ` +
					`Remove and re-add the marketplace to update.`,
			);
		}

		// Promote the temp clone to its final cache location now that drift check passed.
		// 通过漂移校验后再提升临时克隆到最终缓存位置
		if (clonePath) {
			await promoteCloneToCache(clonePath, this.#opts.marketplacesCacheDir, catalog.name);
		}

		// Overwrite cached catalog
		// 覆盖缓存的目录文件
		await Bun.write(existing.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

		const updatedEntry: MarketplaceRegistryEntry = {
			...existing,
			updatedAt: new Date().toISOString(),
		};

		const updatedReg = {
			...reg,
			marketplaces: reg.marketplaces.map(m => (m.name === name ? updatedEntry : m)),
		};
		await writeMarketplacesRegistry(this.#opts.marketplacesRegistryPath, updatedReg);

		logger.debug("Marketplace updated", { name });
		return updatedEntry;
	}

	/** 顺序更新全部已添加的市场 */
	async updateAllMarketplaces(): Promise<MarketplaceRegistryEntry[]> {
		const marketplaces = await this.listMarketplaces();
		const results: MarketplaceRegistryEntry[] = [];
		for (const m of marketplaces) {
			const updated = await this.updateMarketplace(m.name);
			results.push(updated);
		}
		return results;
	}

	/** 列出当前已添加的市场 */
	async listMarketplaces(): Promise<MarketplaceRegistryEntry[]> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		return reg.marketplaces;
	}

	// ── Plugin discovery ──────────────────────────────────────────────────────
	// 插件发现

	/** 列出指定（或全部）市场中可用的插件 */
	async listAvailablePlugins(marketplace?: string): Promise<MarketplacePluginEntry[]> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);

		if (marketplace !== undefined) {
			const entry = reg.marketplaces.find(m => m.name === marketplace);
			if (!entry) {
				throw new Error(`Marketplace "${marketplace}" not found`);
			}
			const catalog = await this.#readCatalog(entry);
			return catalog.plugins;
		}

		const all: MarketplacePluginEntry[] = [];
		for (const entry of reg.marketplaces) {
			const catalog = await this.#readCatalog(entry);
			all.push(...catalog.plugins);
		}
		return all;
	}

	/** 获取指定市场中某个插件的详细信息 */
	async getPluginInfo(name: string, marketplace: string): Promise<MarketplacePluginEntry | null> {
		const plugins = await this.listAvailablePlugins(marketplace);
		return plugins.find(p => p.name === name) ?? null;
	}

	// ── Install / uninstall ───────────────────────────────────────────────────
	// 安装 / 卸载

	/** 安装指定市场中的插件，支持 force/scope 选项 */
	async installPlugin(
		name: string,
		marketplace: string,
		options?: { force?: boolean; scope?: "user" | "project" },
	): Promise<InstalledPluginEntry> {
		const force = options?.force ?? false;
		const scope = options?.scope ?? "user";
		const registryPath = this.#registryPath(scope);

		// 1. Find marketplace entry
		// 1. 查找市场注册表条目
		const mktReg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const mktEntry = getMarketplaceEntry(mktReg, marketplace);
		if (!mktEntry) {
			throw new Error(`Marketplace "${marketplace}" not found`);
		}

		// 2. Find plugin in catalog
		// 2. 在目录中定位插件条目
		const catalog = await this.#readCatalog(mktEntry);
		const pluginEntry = catalog.plugins.find(p => p.name === name);
		if (!pluginEntry) {
			throw new Error(`Plugin "${name}" not found in marketplace "${marketplace}"`);
		}

		const pluginId = buildPluginId(name, marketplace);

		// 3. Check if already installed
		// 3. 检查是否已安装；force 为 false 时拒绝重复安装
		const instReg = await readInstalledPluginsRegistry(registryPath);
		const existing = getInstalledPlugin(instReg, pluginId);
		if (existing && existing.length > 0 && !force) {
			throw new Error(`Plugin "${pluginId}" is already installed. Use force option to reinstall.`);
		}

		// 4. Resolve source path.
		// 4. 解析插件 source 的本地物理路径
		// marketplaceClonePath is the marketplace root — the directory containing .claude-plugin/
		// catalogPath is <marketplacesCacheDir>/<name>/marketplace.json, so the root is two levels up.
		// For local sources the content was fetched from a local path; the stored catalog is a copy
		// under marketplacesCacheDir. We need the original source root for resolving relative paths.
		// Use: path.dirname(catalogPath) is <cacheDir>/<name>/, and that IS the stored copy root,
		// so `path.resolve(mktEntry.catalogPath, "../..")` = parent of <name>/ inside cacheDir
		// which is wrong for local sources. Instead, derive from the stored catalog directory:
		// stored at: <marketplacesCacheDir>/<catalogName>/marketplace.json
		// The marketplace root for local sources should be the actual local path, but we only have
		// sourceUri. For local sources, use path.resolve of sourceUri; for others use the cache dir.
		const marketplaceClonePath = this.#resolveMarketplaceRoot(mktEntry);

		// URL-sourced marketplaces only cache marketplace.json, not the full plugin tree.
		// Relative string sources ("./plugins/foo") cannot be resolved against the cache dir.
		// URL 类市场仅缓存了 marketplace.json，没有完整插件树，因此不支持相对路径 source
		if (mktEntry.sourceType === "url" && typeof pluginEntry.source === "string") {
			throw new Error(
				`Plugin "${name}" uses a relative source path but marketplace "${marketplace}" was added via URL. ` +
					`Relative sources require a git or local marketplace. Re-add the marketplace using its git URL.`,
			);
		}

		const { dir: sourcePath, tempCloneRoot } = await resolvePluginSource(pluginEntry, {
			marketplaceClonePath,
			catalogMetadata: catalog.metadata,
			tmpDir: os.tmpdir(),
		});

		// 5. Determine version: catalog entry > plugin manifest > git SHA > fallback
		// 5. 决定版本号：catalog 显式版本 > 插件 manifest > git SHA > "0.0.0"
		let version!: string;
		let cachePath!: string;
		try {
			version = await this.#resolvePluginVersion(pluginEntry, sourcePath);
			cachePath = await cachePlugin(sourcePath, this.#opts.pluginsCacheDir, marketplace, name, version);
		} finally {
			// Clean up temp clone dirs created by resolvePluginSource; leave user-supplied local dirs alone
			// 仅清理 resolvePluginSource 创建的临时克隆目录，不要动用户提供的本地目录
			if (tempCloneRoot) {
				await fs.rm(tempCloneRoot, { recursive: true, force: true }).catch(() => {});
			}
		}

		// Only now clean up old entries — new cache succeeded, so it is safe to remove old ones.
		// 新缓存就绪后再清理旧条目，保证回滚安全
		if (existing && existing.length > 0) {
			// Remove from scope-appropriate registry first, then cross-check refs before disk deletion.
			// 先从对应 scope 注册表移除条目，再交叉检查是否被另一个 scope 引用，最后才物理删除
			const prunedReg = removeInstalledPlugin(await readInstalledPluginsRegistry(registryPath), pluginId);
			await writeInstalledPluginsRegistry(registryPath, prunedReg);

			// Read both registries AFTER removal — only delete paths no longer referenced by either.
			// 在删除条目之后再读取两个 scope 的注册表，只删两边都不再引用的路径
			const [userReg, projectReg] = await Promise.all([
				readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
				this.#opts.projectInstalledRegistryPath
					? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
					: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
			]);
			const referenced = collectReferencedPaths(userReg, projectReg);

			for (const entry of existing) {
				if (entry.installPath !== cachePath && !referenced.has(entry.installPath)) {
					await fs.rm(entry.installPath, { recursive: true, force: true });
				}
			}
		}

		// 6. Build and register the entry, preserving enabled state from previous install
		// 6. 构造并写入新条目；保留升级前的 enabled 状态
		const now = new Date().toISOString();
		// Carry over enabled flag from existing entry — a disabled plugin must stay disabled after upgrade
		// 若先前已被禁用，升级后必须仍保持禁用状态
		const wasDisabled = existing?.some(e => e.enabled === false);
		const installedEntry: InstalledPluginEntry = {
			scope,
			installPath: cachePath,
			version,
			installedAt: now,
			lastUpdated: now,
			...(wasDisabled ? { enabled: false } : {}),
		};

		const freshInstReg = await readInstalledPluginsRegistry(registryPath);
		const newInstReg = addInstalledPlugin(freshInstReg, pluginId, installedEntry);
		await writeInstalledPluginsRegistry(registryPath, newInstReg);

		this.#clearCache();

		logger.debug("Plugin installed", { pluginId, version, cachePath });
		return installedEntry;
	}

	/**
	 * Resolve plugin version from multiple sources:
	 * 1. Catalog entry version (if set)
	 * 2. Plugin manifest (.claude-plugin/plugin.json or package.json)
	 * 3. Git SHA from source (truncated to 7 chars)
	 * 4. Fallback "0.0.0"
	 *
	 * 按优先级解析插件版本号：catalog 显式版本 > manifest 版本 > git SHA(前 7 位) > "0.0.0"。
	 */
	async #resolvePluginVersion(entry: MarketplacePluginEntry, sourcePath: string): Promise<string> {
		// 1. Catalog entry version
		if (entry.version) return entry.version;

		// 2. Plugin manifest
		for (const manifestPath of [
			path.join(sourcePath, ".claude-plugin", "plugin.json"),
			path.join(sourcePath, "package.json"),
		]) {
			try {
				const content = await Bun.file(manifestPath).json();
				if (typeof content?.version === "string" && content.version) {
					return content.version;
				}
			} catch {
				// Missing or invalid — try next
			}
		}

		// 3. Git SHA from source definition
		if (typeof entry.source === "object" && "sha" in entry.source && entry.source.sha) {
			return entry.source.sha.slice(0, 7);
		}

		return "0.0.0";
	}

	/** 卸载指定插件；若两个 scope 都安装则必须显式指定 scope */
	async uninstallPlugin(pluginId: string, scope?: "user" | "project"): Promise<void> {
		const parsed = parsePluginId(pluginId);
		if (!parsed) {
			throw new Error(`Invalid plugin ID format: "${pluginId}". Expected "name@marketplace".`);
		}

		const { userEntries, projectEntries, userReg, projectReg } = await this.#findInBothRegistries(pluginId);

		const inUser = userEntries && userEntries.length > 0;
		const inProject = projectEntries && projectEntries.length > 0;

		if (!inUser && !inProject) {
			throw new Error(`Plugin "${pluginId}" is not installed`);
		}

		// Disambiguation: if installed in both scopes and no explicit scope, require one.
		// 当两个 scope 都安装时必须显式指定要操作的 scope
		let targetScope: "user" | "project";
		if (inUser && inProject) {
			if (!scope) {
				throw new Error(
					`Plugin "${pluginId}" is installed in both user and project scope. Use --scope user or --scope project to specify which to remove.`,
				);
			}
			targetScope = scope;
		} else if (inProject) {
			if (scope === "user") {
				throw new Error(`Plugin "${pluginId}" is not installed in user scope`);
			}
			targetScope = "project";
		} else {
			if (scope === "project") {
				throw new Error(`Plugin "${pluginId}" is not installed in project scope`);
			}
			targetScope = "user";
		}

		const targetEntries = targetScope === "project" ? projectEntries! : userEntries!;
		const targetReg = targetScope === "project" ? projectReg : userReg;
		const registryPath = this.#registryPath(targetScope);

		const updatedReg = removeInstalledPlugin(targetReg, pluginId);
		await writeInstalledPluginsRegistry(registryPath, updatedReg);

		// Read both registries AFTER removal — only delete paths no longer referenced by either.
		// 在删除条目之后再读两端，确保只移除两个 scope 都不再引用的路径
		const [freshUserReg, freshProjectReg] = await Promise.all([
			readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
			this.#opts.projectInstalledRegistryPath
				? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
				: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
		]);
		const referenced = collectReferencedPaths(freshUserReg, freshProjectReg);

		for (const entry of targetEntries) {
			if (!referenced.has(entry.installPath)) {
				await fs.rm(entry.installPath, { recursive: true, force: true });
			}
		}

		this.#clearCache();

		logger.debug("Plugin uninstalled", { pluginId, scope: targetScope });
	}

	// ── Plugin state ──────────────────────────────────────────────────────────
	// 插件状态：列出 / 启停

	/** 列出所有已安装插件（合并 user 与 project scope，并标记是否被覆盖） */
	async listInstalledPlugins(): Promise<InstalledPluginSummary[]> {
		const userReg = await readInstalledPluginsRegistry(this.#opts.installedRegistryPath);
		const projectReg = this.#opts.projectInstalledRegistryPath
			? await readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
			: null;

		// Only enabled project installs shadow user installs — a disabled project copy leaves
		// the user entry as the active one and must not be reported as shadowed.
		// 仅启用状态的项目级安装才会覆盖用户级安装；已禁用的项目级副本不构成覆盖
		const activeProjectIds = new Set(
			projectReg
				? Object.entries(projectReg.plugins)
						.filter(([, entries]) => entries.length > 0 && entries[0].enabled !== false)
						.map(([id]) => id)
				: [],
		);
		const results: InstalledPluginSummary[] = [];

		// Project entries first
		// 项目级条目先入列
		if (projectReg) {
			for (const [id, entries] of Object.entries(projectReg.plugins)) {
				results.push({ id, scope: "project", entries });
			}
		}
		// User entries (shadow-marked if overridden by project)
		// 用户级条目：若被项目级覆盖则标记 shadowedBy
		for (const [id, entries] of Object.entries(userReg.plugins)) {
			results.push({
				id,
				scope: "user",
				entries,
				...(activeProjectIds.has(id) ? { shadowedBy: "project" as const } : {}),
			});
		}
		return results;
	}

	/** 设置插件启用/禁用状态；两个 scope 都安装时需显式指定 */
	async setPluginEnabled(pluginId: string, enabled: boolean, scope?: "user" | "project"): Promise<void> {
		const { userEntries, projectEntries, userReg, projectReg } = await this.#findInBothRegistries(pluginId);

		const inUser = userEntries && userEntries.length > 0;
		const inProject = projectEntries && projectEntries.length > 0;

		if (!inUser && !inProject) {
			throw new Error(`Plugin "${pluginId}" is not installed`);
		}

		// Disambiguation: if installed in both scopes and no explicit scope, require one.
		let targetScope: "user" | "project";
		if (inUser && inProject) {
			if (!scope) {
				throw new Error(
					`Plugin "${pluginId}" is installed in both user and project scope. Use --scope user or --scope project to specify which to modify.`,
				);
			}
			targetScope = scope;
		} else if (inProject) {
			if (scope === "user") {
				throw new Error(`Plugin "${pluginId}" is not installed in user scope`);
			}
			targetScope = "project";
		} else {
			if (scope === "project") {
				throw new Error(`Plugin "${pluginId}" is not installed in project scope`);
			}
			targetScope = "user";
		}

		const reg = targetScope === "project" ? projectReg : userReg;
		const entries = targetScope === "project" ? projectEntries! : userEntries!;
		const registryPath = this.#registryPath(targetScope);

		const updated = {
			...reg,
			plugins: {
				...reg.plugins,
				[pluginId]: entries.map(e => ({ ...e, enabled })),
			},
		};
		await writeInstalledPluginsRegistry(registryPath, updated);

		this.#clearCache();

		logger.debug("Plugin enabled state changed", { pluginId, enabled, scope: targetScope });
	}

	// ── Update / upgrade ─────────────────────────────────────────────────────
	// 更新 / 升级

	// Refresh marketplace catalogs that haven't been updated in more than 24 h.
	// Per-marketplace failures are silently swallowed — offline is fine.
	/** 刷新超过 24 小时未更新的市场目录；单个市场失败时静默跳过（适配离线场景） */
	async refreshStaleMarketplaces(): Promise<void> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const staleMs = 24 * 60 * 60 * 1000;
		for (const entry of reg.marketplaces) {
			if (Date.now() - Date.parse(entry.updatedAt) >= staleMs) {
				try {
					await this.updateMarketplace(entry.name);
				} catch {
					// Network or parse failure — leave stale, try next time.
					// 网络或解析失败时保持原状，下次再尝试
				}
			}
		}
	}

	// Compare installed plugin versions against their catalog entries.
	// Returns one entry per (pluginId, scope) pair where the catalog declares a newer version.
	// Catalog entries without a version field are skipped.
	/** 对比已安装插件版本与目录中的版本，返回每个（pluginId, scope）的可更新项 */
	async checkForUpdates(): Promise<Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }>> {
		const mktReg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const updates: Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }> = [];

		// Keyed by (path, scope) so each scope is checked independently.
		// A plugin current in user scope but stale in project scope must still appear.
		// 按 (path, scope) 维度独立检查；某 scope 滞后仍需上报
		const registryEntries: Array<[string, "user" | "project"]> = [[this.#opts.installedRegistryPath, "user"]];
		if (this.#opts.projectInstalledRegistryPath) {
			registryEntries.push([this.#opts.projectInstalledRegistryPath, "project"]);
		}

		for (const [regPath, scope] of registryEntries) {
			const instReg = await readInstalledPluginsRegistry(regPath);
			for (const [pluginId, entries] of Object.entries(instReg.plugins)) {
				const parsed = parsePluginId(pluginId);
				if (!parsed) continue;
				const installed = entries[0];
				if (!installed) continue;

				const mktEntry = mktReg.marketplaces.find(m => m.name === parsed.marketplace);
				if (!mktEntry) continue;

				let catalogVersion: string | undefined;
				try {
					const catalog = await this.#readCatalog(mktEntry);
					catalogVersion = catalog.plugins.find(p => p.name === parsed.name)?.version;
				} catch {
					continue;
				}

				if (!catalogVersion || catalogVersion === installed.version) continue;

				// Treat newer semver as an update; fall back to inequality for non-semver tags.
				// 优先按 semver 判断更新；非 semver 时退化为字符串不相等
				let isNewer: boolean;
				try {
					isNewer = Bun.semver.order(catalogVersion, installed.version) > 0;
				} catch {
					isNewer = catalogVersion !== installed.version;
				}

				if (isNewer) {
					updates.push({ pluginId, scope, from: installed.version, to: catalogVersion });
				}
			}
		}

		return updates;
	}

	// Re-install a specific plugin at the latest catalog version (force-overwrites).
	/** 将指定插件强制重装为目录中的最新版本 */
	async upgradePlugin(pluginId: string, scope?: "user" | "project"): Promise<InstalledPluginEntry> {
		const parsed = parsePluginId(pluginId);
		if (!parsed) {
			throw new Error(`Invalid plugin ID: "${pluginId}". Expected "name@marketplace".`);
		}

		const { userEntries, projectEntries } = await this.#findInBothRegistries(pluginId);

		const inUser = userEntries && userEntries.length > 0;
		const inProject = projectEntries && projectEntries.length > 0;

		if (!inUser && !inProject) {
			throw new Error(`Plugin "${pluginId}" is not installed`);
		}

		let resolvedScope: "user" | "project";
		if (inUser && inProject) {
			if (!scope) {
				throw new Error(
					`Plugin "${pluginId}" is installed in both user and project scope. Use --scope user or --scope project to specify which to upgrade.`,
				);
			}
			resolvedScope = scope;
		} else if (inProject) {
			if (scope === "user") throw new Error(`Plugin "${pluginId}" is not installed in user scope`);
			resolvedScope = "project";
		} else {
			if (scope === "project") throw new Error(`Plugin "${pluginId}" is not installed in project scope`);
			resolvedScope = "user";
		}

		return this.installPlugin(parsed.name, parsed.marketplace, { force: true, scope: resolvedScope });
	}

	// Upgrade a plugin across all scopes where it is installed.
	// Returns one entry per scope upgraded (0–2 entries).
	/** 对所有安装了该插件的 scope 同时进行升级；返回 0~2 个升级结果 */
	async upgradePluginAcrossScopes(pluginId: string): Promise<InstalledPluginEntry[]> {
		const parsed = parsePluginId(pluginId);
		if (!parsed) {
			throw new Error(`Invalid plugin ID: "${pluginId}". Expected "name@marketplace".`);
		}

		const { userEntries, projectEntries } = await this.#findInBothRegistries(pluginId);

		const inUser = userEntries && userEntries.length > 0;
		const inProject = projectEntries && projectEntries.length > 0;

		if (!inUser && !inProject) {
			throw new Error(`Plugin "${pluginId}" is not installed`);
		}

		const results: InstalledPluginEntry[] = [];

		if (inProject) {
			const entry = await this.installPlugin(parsed.name, parsed.marketplace, { force: true, scope: "project" });
			results.push(entry);
		}
		if (inUser) {
			const entry = await this.installPlugin(parsed.name, parsed.marketplace, { force: true, scope: "user" });
			results.push(entry);
		}

		return results;
	}

	// Upgrade every (pluginId, scope) pair that checkForUpdates reports as outdated.
	// Only stale scopes are touched; a current user install is not re-installed when only
	// the project scope is stale. Per-entry failures are skipped — partial success is returned.
	/**
	 * 升级 checkForUpdates 报告的所有过期 (pluginId, scope)。
	 * 仅升级真正过期的 scope；单条失败时跳过并继续，允许返回部分成功结果。
	 */
	async upgradeAllPlugins(): Promise<
		Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }>
	> {
		const updates = await this.checkForUpdates();
		const results: Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }> = [];
		for (const update of updates) {
			try {
				const entry = await this.upgradePlugin(update.pluginId, update.scope);
				results.push({ pluginId: update.pluginId, scope: update.scope, from: update.from, to: entry.version });
			} catch {
				// Skip this entry; partial upgrades are better than none.
				// 单条失败时跳过，保证整体仍能产生部分升级结果
			}
		}
		return results;
	}

	// ── Private helpers ───────────────────────────────────────────────────────
	// 内部辅助函数

	/** 根据 scope 选择对应的已安装插件注册表路径 */
	#registryPath(scope: "user" | "project"): string {
		if (scope === "project") {
			if (!this.#opts.projectInstalledRegistryPath) {
				throw new Error("project-scoped install requires running inside a project directory");
			}
			return this.#opts.projectInstalledRegistryPath;
		}
		return this.#opts.installedRegistryPath;
	}

	/** 同时查询 user 与 project 两个注册表中某个 pluginId 的存在情况 */
	async #findInBothRegistries(pluginId: string): Promise<{
		userEntries: InstalledPluginEntry[] | undefined;
		projectEntries: InstalledPluginEntry[] | undefined;
		userReg: InstalledPluginsRegistry;
		projectReg: InstalledPluginsRegistry;
	}> {
		const [userReg, projectReg] = await Promise.all([
			readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
			this.#opts.projectInstalledRegistryPath
				? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
				: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
		]);
		return {
			userEntries: getInstalledPlugin(userReg, pluginId),
			projectEntries: getInstalledPlugin(projectReg, pluginId),
			userReg,
			projectReg,
		};
	}

	/** 读取并解析市场目录文件；缺失时给出更友好的提示 */
	async #readCatalog(entry: MarketplaceRegistryEntry): Promise<MarketplaceCatalog> {
		try {
			const content = await Bun.file(entry.catalogPath).text();
			return parseMarketplaceCatalog(content, entry.catalogPath);
		} catch (err) {
			if (isEnoent(err)) {
				throw new Error(
					`Marketplace catalog not found at ${entry.catalogPath}. Try: /marketplace update ${entry.name}`,
				);
			}
			throw err;
		}
	}

	/**
	 * Compute the marketplace root directory for source resolution.
	 *
	 * For local sources: sourceUri IS the local path, so resolve it directly.
	 * This gives the directory containing `.claude-plugin/marketplace.json`,
	 * which is what resolvePluginSource expects as `marketplaceClonePath`.
	 *
	 * For remote sources (git/github/url): the catalog was cloned into
	 * `<marketplacesCacheDir>/<name>/`, so the root is the parent of catalogPath.
	 *
	 * 计算市场根目录（供 source 解析使用）：
	 * - 本地 source：sourceUri 即本地路径，直接 resolve
	 * - 远端 source：克隆位于 <marketplacesCacheDir>/<name>/，取 catalogPath 的父目录
	 */
	#resolveMarketplaceRoot(entry: MarketplaceRegistryEntry): string {
		if (entry.sourceType === "local") {
			// expandHome already happened in fetcher; resolve to ensure absolute.
			// fetcher 中已处理过 ~ 展开，这里只需保证返回绝对路径
			const expanded = entry.sourceUri.startsWith("~/")
				? path.join(os.homedir(), entry.sourceUri.slice(2))
				: entry.sourceUri;
			return path.resolve(expanded);
		}
		// For git/github/url sources, the catalog lives at <cloneDir>/marketplace.json
		// under marketplacesCacheDir/<name>/; parent = <marketplacesCacheDir>/<name>/
		// 远端 source 时，catalog 位于 <cloneDir>/marketplace.json，其父目录即市场根
		return path.dirname(entry.catalogPath);
	}
}


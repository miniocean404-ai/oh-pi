
/**
 * Capability Registry
 * 能力注册表
 *
 * Central registry for capabilities and providers. Provides the main API for:
 * - Defining capabilities (what we're looking for)
 * - Registering providers (where to find it)
 * - Loading items for a capability across all providers
 * 能力和提供者的中央注册表。提供以下主要 API：
 * - 定义能力（要查找什么）
 * - 注册提供者（从哪里查找）
 * - 跨所有提供者加载某项能力的配置项
 */
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";

import type { Settings } from "../config/settings";
import { clearCache as clearFsCache, findRepoRoot, cacheStats as fsCacheStats, invalidate as invalidateFs } from "./fs";
import type {
	Capability,
	CapabilityInfo,
	CapabilityResult,
	LoadContext,
	LoadOptions,
	Provider,
	ProviderInfo,
	SourceMeta,
} from "./types";

// =============================================================================
// 注册表状态
// =============================================================================

/** Registry of all capabilities */
/** 所有能力的注册表 */
const capabilities = new Map<string, Capability<unknown>>();

/** Reverse index: provider ID -> capability IDs it's registered for */
/** 反向索引：提供者 ID -> 其注册的能力 ID 集合 */
const providerCapabilities = new Map<string, Set<string>>();

/** Provider display metadata (shared across capabilities) */
/** 提供者显示元数据（跨能力共享） */
const providerMeta = new Map<string, { displayName: string; description: string }>();

/** Disabled providers (by ID) */
/** 已禁用的提供者（按 ID） */
const disabledProviders = new Set<string>();

/** Settings manager for persistence (if set) */
/** 用于持久化的设置管理器（如已设置） */
let settings: Settings | null = null;

// =============================================================================
// 注册 API
// =============================================================================

/**
 * Define a new capability.
 * 定义一个新的能力。
 */
export function defineCapability<T>(def: Omit<Capability<T>, "providers">): Capability<T> {
	if (capabilities.has(def.id)) {
		throw new Error(`Capability "${def.id}" is already defined`);
	}
	const capability: Capability<T> = { ...def, providers: [] };
	capabilities.set(def.id, capability as Capability<unknown>);
	return capability;
}

/**
 * Register a provider for a capability.
 * 为某项能力注册一个提供者。
 */
export function registerProvider<T>(capabilityId: string, provider: Provider<T>): void {
	const capability = capabilities.get(capabilityId);
	if (!capability) {
		throw new Error(`Unknown capability: "${capabilityId}". Define it first with defineCapability().`);
	}

	// Store provider metadata (for cross-capability display)
	// 存储提供者元数据（用于跨能力展示）
	if (!providerMeta.has(provider.id)) {
		providerMeta.set(provider.id, {
			displayName: provider.displayName,
			description: provider.description,
		});
	}

	// Track which capabilities this provider is registered for
	// 追踪此提供者注册了哪些能力
	if (!providerCapabilities.has(provider.id)) {
		providerCapabilities.set(provider.id, new Set());
	}
	providerCapabilities.get(provider.id)!.add(capabilityId);

	// Insert in priority order (highest first)
	// 按优先级顺序插入（最高优先级在前）
	const providers = capability.providers as Provider<T>[];
	const idx = providers.findIndex(p => p.priority < provider.priority);
	if (idx === -1) {
		providers.push(provider);
	} else {
		providers.splice(idx, 0, provider);
	}
}

// =============================================================================
// 加载 API
// =============================================================================

/**
 * Async loading logic shared by loadCapability().
 * loadCapability() 共享的异步加载逻辑。
 */
async function loadImpl<T>(
	capability: Capability<T>,
	providers: Provider<T>[],
	ctx: LoadContext,
	options: LoadOptions,
): Promise<CapabilityResult<T>> {
	const allItems: Array<T & { _source: SourceMeta; _shadowed?: boolean }> = [];
	const allWarnings: string[] = [];
	const contributingProviders: string[] = [];
	const disabledExtensionIds = options.includeDisabled
		? new Set<string>()
		: new Set<string>(options.disabledExtensions ?? settings?.get("disabledExtensions") ?? []);

	const results = await Promise.all(
		providers.map(async provider => {
			try {
				const result = await logger.time(
					`capability:${capability.id}:${provider.id}`,
					provider.load.bind(provider),
					ctx,
				);
				return { provider, result };
			} catch (error) {
				logger.debug(`capability:${capability.id}:${provider.id}:error`);
				return { provider, error };
			}
		}),
	);

	for (const entry of results) {
		const { provider } = entry;
		if ("error" in entry) {
			allWarnings.push(`[${provider.displayName}] Failed to load: ${entry.error}`);
			continue;
		}

		const result = entry.result;
		if (!result) continue;

		if (result.warnings) {
			allWarnings.push(...result.warnings.map(w => `[${provider.displayName}] ${w}`));
		}

		let contributedItemCount = 0;
		for (const item of result.items) {
			const itemWithSource = item as T & { _source: SourceMeta };
			if (!itemWithSource._source) {
				allWarnings.push(`[${provider.displayName}] Item missing _source metadata, skipping`);
				continue;
			}

			const extensionId = capability.toExtensionId?.(itemWithSource);
			if (extensionId && disabledExtensionIds.has(extensionId)) {
				continue;
			}

			itemWithSource._source.providerName = provider.displayName;
			allItems.push(itemWithSource as T & { _source: SourceMeta; _shadowed?: boolean });
			contributedItemCount += 1;
		}

		if (contributedItemCount > 0) {
			contributingProviders.push(provider.id);
		}
	}

	// Deduplicate by key (first wins = highest priority)
	// 按键去重（第一个生效 = 最高优先级）
	const seen = new Map<string, number>();
	const deduped: Array<T & { _source: SourceMeta }> = [];

	for (let i = 0; i < allItems.length; i++) {
		const item = allItems[i];
		const key = capability.key(item);

		if (key === undefined) {
			deduped.push(item);
		} else if (!seen.has(key)) {
			seen.set(key, i);
			deduped.push(item);
		} else {
			item._shadowed = true;
		}
	}

	// Validate items (only non-shadowed items)
	// 验证项（仅验证未被覆盖的项）
	if (capability.validate && !options.includeInvalid) {
		for (let i = deduped.length - 1; i >= 0; i--) {
			const error = capability.validate(deduped[i]);
			if (error) {
				const source = deduped[i]._source;
				allWarnings.push(
					`[${source?.providerName ?? "unknown"}] Invalid item at ${source?.path ?? "unknown"}: ${error}`,
				);
				deduped.splice(i, 1);
			}
		}
	}

	return {
		items: deduped,
		all: allItems,
		warnings: allWarnings,
		providers: contributingProviders,
	};
}

/**
 * Filter providers based on options and disabled state.
 * 根据选项和禁用状态过滤提供者。
 */
function filterProviders<T>(capability: Capability<T>, options: LoadOptions): Provider<T>[] {
	let providers = (capability.providers as Provider<T>[]).filter(p => !disabledProviders.has(p.id));

	if (options.providers) {
		const allowed = new Set(options.providers);
		providers = providers.filter(p => allowed.has(p.id));
	}
	if (options.excludeProviders) {
		const excluded = new Set(options.excludeProviders);
		providers = providers.filter(p => !excluded.has(p.id));
	}

	return providers;
}

/**
 * Load a capability by ID.
 * 按 ID 加载一项能力。
 */
export async function loadCapability<T>(capabilityId: string, options: LoadOptions = {}): Promise<CapabilityResult<T>> {
	const capability = capabilities.get(capabilityId) as Capability<T> | undefined;
	if (!capability) {
		throw new Error(`Unknown capability: "${capabilityId}"`);
	}

	const cwd = options.cwd ?? getProjectDir();
	const home = os.homedir();
	const repoRoot = await findRepoRoot(cwd);
	const ctx: LoadContext = { cwd, home, repoRoot };
	const providers = filterProviders(capability, options);

	return await loadImpl(capability, providers, ctx, options);
}

// =============================================================================
// 提供者启用/禁用 API
// =============================================================================

/**
 * Initialize capability system with settings manager for persistence.
 * Call this once on startup to enable persistent provider state.
 * 使用设置管理器初始化能力系统，实现持久化。
 * 启动时调用一次以启用提供者状态持久化。
 */
export function initializeWithSettings(activeSettings: Settings): void {
	settings = activeSettings;
	// Load disabled providers from settings
	// 从设置中加载已禁用的提供者
	const disabled = settings.get("disabledProviders");
	disabledProviders.clear();
	for (const id of disabled) {
		disabledProviders.add(id);
	}
}

/**
 * Persist current disabled providers to settings.
 * 将当前禁用的提供者持久化到设置中。
 */
function persistDisabledProviders(): void {
	if (settings) {
		settings.set("disabledProviders", Array.from(disabledProviders));
	}
}

/**
 * Disable a provider globally (across all capabilities).
 * 全局禁用一个提供者（跨所有能力）。
 */
export function disableProvider(providerId: string): void {
	disabledProviders.add(providerId);
	persistDisabledProviders();
}

/**
 * Enable a previously disabled provider.
 * 启用之前被禁用的提供者。
 */
export function enableProvider(providerId: string): void {
	disabledProviders.delete(providerId);
	persistDisabledProviders();
}

/**
 * Check if a provider is enabled.
 * 检查提供者是否已启用。
 */
export function isProviderEnabled(providerId: string): boolean {
	return !disabledProviders.has(providerId);
}

/**
 * Get list of all disabled provider IDs.
 * 获取所有已禁用提供者的 ID 列表。
 */
export function getDisabledProviders(): string[] {
	return Array.from(disabledProviders);
}

/**
 * Set disabled providers from a list (replaces current set).
 * 从列表设置禁用的提供者（替换当前集合）。
 */
export function setDisabledProviders(providerIds: string[]): void {
	disabledProviders.clear();
	for (const id of providerIds) {
		disabledProviders.add(id);
	}
	persistDisabledProviders();
}

// =============================================================================
// 内省 API
// =============================================================================

/**
 * Get a capability definition (for introspection).
 * 获取能力定义（用于内省）。
 */
export function getCapability<T>(id: string): Capability<T> | undefined {
	return capabilities.get(id) as Capability<T> | undefined;
}

/**
 * List all registered capability IDs.
 * 列出所有已注册的能力 ID。
 */
export function listCapabilities(): string[] {
	return Array.from(capabilities.keys());
}

/**
 * Get capability info for UI display.
 * 获取用于 UI 展示的能力信息。
 */
export function getCapabilityInfo(capabilityId: string): CapabilityInfo | undefined {
	const capability = capabilities.get(capabilityId);
	if (!capability) return undefined;

	return {
		id: capability.id,
		displayName: capability.displayName,
		description: capability.description,
		providers: capability.providers.map(p => ({
			id: p.id,
			displayName: p.displayName,
			description: p.description,
			priority: p.priority,
			enabled: !disabledProviders.has(p.id),
		})),
	};
}

/**
 * Get all capabilities info for UI display.
 * 获取所有能力的 UI 展示信息。
 */
export function getAllCapabilitiesInfo(): CapabilityInfo[] {
	return listCapabilities().map(id => getCapabilityInfo(id)!);
}

/**
 * Get provider info for UI display.
 * 获取用于 UI 展示的提供者信息。
 */
export function getProviderInfo(providerId: string): ProviderInfo | undefined {
	const meta = providerMeta.get(providerId);
	const caps = providerCapabilities.get(providerId);
	if (!meta || !caps) return undefined;

	// Find priority from first capability's provider list
	// 从第一个能力的提供者列表中获取优先级
	let priority = 0;
	for (const capId of caps) {
		const cap = capabilities.get(capId);
		const provider = cap?.providers.find(p => p.id === providerId);
		if (provider) {
			priority = provider.priority;
			break;
		}
	}

	return {
		id: providerId,
		displayName: meta.displayName,
		description: meta.description,
		priority,
		capabilities: Array.from(caps),
		enabled: !disabledProviders.has(providerId),
	};
}

/**
 * Get all providers info for UI display (deduplicated across capabilities).
 * 获取所有提供者的 UI 展示信息（跨能力去重）。
 */
export function getAllProvidersInfo(): ProviderInfo[] {
	const providers: ProviderInfo[] = [];

	for (const providerId of providerMeta.keys()) {
		const info = getProviderInfo(providerId);
		if (info) {
			providers.push(info);
		}
	}

	// Sort by priority (highest first)
	// 按优先级排序（最高优先级在前）
	providers.sort((a, b) => b.priority - a.priority);

	return providers;
}

// =============================================================================
// 缓存管理
// =============================================================================

/**
 * Reset all caches. Call after chdir or filesystem changes.
 * 重置所有缓存。在切换目录或文件系统变更后调用。
 */
export function reset(): void {
	clearFsCache();
}

/**
 * Invalidate cache for a specific path.
 * 使指定路径的缓存失效。
 * @param filePath - Absolute or relative path to invalidate / 要失效的绝对或相对路径
 */
export function invalidate(filePath: string, cwd?: string): void {
	const resolved = cwd ? path.resolve(cwd, filePath) : filePath;
	invalidateFs(resolved);
}

/**
 * Get cache stats for diagnostics.
 * 获取缓存统计信息（用于诊断）。
 */
export function cacheStats(): { content: number; dir: number } {
	return fsCacheStats();
}

// =============================================================================
// 重新导出
// =============================================================================

export type * from "./types";


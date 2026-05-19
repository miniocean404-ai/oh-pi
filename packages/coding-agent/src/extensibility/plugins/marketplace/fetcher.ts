
/**
 * Marketplace catalog fetcher.
 *
 * Classifies a source string, resolves it, and loads the catalog.
 *
 * 市场目录抓取器：识别 source 字符串类型，解析并加载 marketplace.json 目录文件。
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import * as git from "../../../utils/git";

import type { MarketplaceCatalog, MarketplaceSourceType } from "./types";
import { isValidNameSegment } from "./types";

// ── Types ─────────────────────────────────────────────────────────────
// 类型定义

/** 抓取结果：解析出的目录 + 临时克隆目录路径（git 源才有） */
export interface FetchResult {
	catalog: MarketplaceCatalog;
	/** For git sources: path to the cloned marketplace directory. */
	/** 仅 git 源：临时克隆后的目录绝对路径 */
	clonePath?: string;
}

// ── classifySource ────────────────────────────────────────────────────
// 来源分类

/**
 * Detects Windows-style absolute paths cross-platform:
 *   C:\path, C:/path  → drive-letter + colon + separator
 *   \\server\share    → UNC path
 *
 * Needed because path.isAbsolute("C:\...") returns false on POSIX.
 */
const WIN_ABS_RE = /^[A-Za-z]:[/\\]|^\\\\/;

/**
 * GitHub owner/repo shorthand: lowercase alphanumeric + hyphens/dots, one slash.
 * Must NOT start with a protocol — that is ruled out by earlier checks.
 */
const GITHUB_SHORTHAND_RE = /^[a-z0-9-]+\/[a-z0-9._-]+$/i;

/**
 * Classify a marketplace source string into one of the four source types.
 *
 * Rules are ordered; the first match wins. Protocol/pattern checks (rules 1-3)
 * run before any path.isAbsolute() check so that SCP-style git@ URLs are
 * never misclassified as local paths on Windows.
 *
 * 将 source 字符串分类为 github/git/url/local 之一。
 * 规则按顺序匹配，先匹中者胜出；协议/模式检查放在路径绝对性检查之前，
 * 避免在 Windows 上把 git@ 风格 SSH URL 误判为本地路径。
 *
 * @throws if the source format is unrecognized.
 */
export function classifySource(source: string): MarketplaceSourceType {
	// Rule 1: HTTP(S) URLs — .json suffix → url, everything else → git
	// 规则 1：HTTP(S) URL —— 以 .json 结尾视为 url，其余视为 git
	if (source.startsWith("https://") || source.startsWith("http://")) {
		try {
			const { pathname } = new URL(source);
			return pathname.endsWith(".json") ? "url" : "git";
		} catch {
			// Malformed URL — treat as git
			// URL 解析失败时按 git 处理
			return "git";
		}
	}

	// Rule 2: SCP-style SSH git URLs
	// 规则 2：SCP 风格的 SSH git URL
	if (source.startsWith("git@") || source.startsWith("ssh://")) {
		return "git";
	}

	// Rule 3: GitHub owner/repo shorthand (no protocol, no leading slash)
	// 规则 3：GitHub owner/repo 简写
	if (GITHUB_SHORTHAND_RE.test(source)) {
		return "github";
	}

	// Rule 4: Explicit relative or home-relative paths
	// 规则 4：显式相对路径或 ~/ 开头的家目录路径
	if (source.startsWith("./") || source.startsWith("~/")) {
		return "local";
	}

	// Rule 5: Absolute paths — POSIX via path.isAbsolute, Windows via regex
	// 规则 5：绝对路径（POSIX 用 path.isAbsolute；Windows 用正则）
	if (path.isAbsolute(source) || WIN_ABS_RE.test(source)) {
		return "local";
	}

	throw new Error(`Unrecognized source format. Did you mean './${source}' (local) or 'owner/repo' (GitHub)?`);
}

// ── parseMarketplaceCatalog ───────────────────────────────────────────
// 解析 marketplace.json 目录文件

/** 字段断言辅助：condition 为 false 时抛出带字段名的错误 */
function assertField(condition: boolean, field: string, filePath: string): void {
	if (!condition) {
		throw new Error(`Missing or invalid field "${field}" in catalog: ${filePath}`);
	}
}

/**
 * Parse and validate a marketplace.json catalog from raw JSON content.
 *
 * Required fields: name (valid name segment), owner.name, plugins array.
 * Each plugin entry requires name (string) and source (string or object
 * with a "source" field). Extra fields are preserved via spread.
 *
 * 解析并校验 marketplace.json 目录文件。
 * 必填字段：name（合法名称段）、owner.name、plugins 数组。
 * 单个插件条目需有 name 与 source。非法插件条目会被警告并跳过，不导致整体失败。
 *
 * @throws on JSON parse failure or missing/invalid required fields.
 */
export function parseMarketplaceCatalog(content: string, filePath: string): MarketplaceCatalog {
	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch (err) {
		throw new Error(`Failed to parse marketplace catalog at ${filePath}: ${(err as Error).message}`);
	}

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Marketplace catalog at ${filePath} must be a JSON object`);
	}

	const obj = raw as Record<string, unknown>;

	// name: required, must be a valid name segment
	// name 字段必填，且需为合法的名称片段
	assertField(typeof obj.name === "string" && isValidNameSegment(obj.name), "name", filePath);

	// owner: required object with name string
	// owner 字段必填，且需为含 name 字段的对象
	assertField(typeof obj.owner === "object" && obj.owner !== null && !Array.isArray(obj.owner), "owner", filePath);
	const owner = obj.owner as Record<string, unknown>;
	assertField(typeof owner.name === "string", "owner.name", filePath);

	// plugins: required array
	// plugins 字段必填，必须是数组
	assertField(Array.isArray(obj.plugins), "plugins", filePath);

	const plugins = obj.plugins as unknown[];
	const validPlugins: unknown[] = [];
	for (let i = 0; i < plugins.length; i++) {
		try {
			const entry = plugins[i];
			assertField(typeof entry === "object" && entry !== null && !Array.isArray(entry), `plugins[${i}]`, filePath);
			const p = entry as Record<string, unknown>;
			assertField(typeof p.name === "string" && isValidNameSegment(p.name), `plugins[${i}].name`, filePath);
			// source can be a string path or a typed object (github/url/git-subdir/npm)
			// all typed objects carry a "source" discriminant string field
			// source 可以是相对路径字符串，或带 "source" 判别字段的对象（github/url/git-subdir/npm）
			assertField(
				typeof p.source === "string" ||
					(typeof p.source === "object" &&
						p.source !== null &&
						!Array.isArray(p.source) &&
						typeof (p.source as Record<string, unknown>).source === "string"),
				`plugins[${i}].source`,
				filePath,
			);
			// String sources must be relative paths starting with "./"
			// 字符串形式的 source 必须是以 "./" 开头的相对路径
			if (typeof p.source === "string") {
				assertField((p.source as string).startsWith("./"), `plugins[${i}].source (must start with "./")`, filePath);
			}
			// Validate required fields for typed source variants
			// 对各类带类型的 source 变体校验其必填字段
			if (typeof p.source === "object" && p.source !== null) {
				const src = p.source as Record<string, unknown>;
				const variant = src.source as string;
				if (variant === "github") {
					assertField(typeof src.repo === "string" && src.repo.length > 0, `plugins[${i}].source.repo`, filePath);
				} else if (variant === "url" || variant === "git-subdir") {
					assertField(typeof src.url === "string" && src.url.length > 0, `plugins[${i}].source.url`, filePath);
					if (variant === "git-subdir") {
						assertField(
							typeof src.path === "string" && src.path.length > 0,
							`plugins[${i}].source.path`,
							filePath,
						);
					}
				} else if (variant === "npm") {
					assertField(
						typeof src.package === "string" && src.package.length > 0,
						`plugins[${i}].source.package`,
						filePath,
					);
				} else {
					assertField(false, `plugins[${i}].source.source (unknown variant: "${variant}")`, filePath);
				}
			}
			validPlugins.push(entry);
		} catch (err) {
			// Warn and skip invalid plugin entries instead of failing the entire catalog.
			// This lets the rest of the marketplace load even if one entry has a bad name/source.
			// 单条非法时仅警告并跳过，避免一个坏条目阻塞整个市场加载
			const name =
				typeof plugins[i] === "object" && plugins[i] !== null
					? ((plugins[i] as Record<string, unknown>).name ?? `[${i}]`)
					: `[${i}]`;
			logger.warn(`Skipping invalid plugin ${name}: ${(err as Error).message}`);
		}
	}
	// Replace the plugins array with only valid entries
	// 用过滤后的合法条目替换 plugins 数组
	obj.plugins = validPlugins;

	// Extra fields are preserved — cast through unknown for type safety
	// 其他字段保持不动；通过 unknown 中转以满足类型安全
	return obj as unknown as MarketplaceCatalog;
}

// ── fetchMarketplace ──────────────────────────────────────────────────
// 市场抓取主入口

/** Relative path from a marketplace root to its catalog file. */
/** 市场仓库根目录到目录文件的相对路径 */
const CATALOG_RELATIVE_PATH = path.join(".claude-plugin", "marketplace.json");

/**
 * Expand a `~/...` path to an absolute path using os.homedir().
 * Other paths are returned unchanged.
 *
 * 将 ~/... 形式的路径展开为绝对路径，其余路径原样返回。
 */
function expandHome(p: string): string {
	if (p.startsWith("~/")) {
		return path.join(os.homedir(), p.slice(2));
	}
	return p;
}

/**
 * Fetch a marketplace catalog from a source.
 *
 * Dispatches on the source type: local filesystem paths are read directly;
 * GitHub/git sources are cloned with `git`; URL sources are fetched over HTTP.
 *
 * 根据 source 类型分派抓取：本地路径直接读、GitHub/git 走 git clone、URL 走 HTTP fetch。
 *
 * @param source   Source identifier: path, GitHub shorthand, git URL, or HTTP URL.
 * @param cacheDir Cache directory root for non-local sources.
 */
export async function fetchMarketplace(source: string, cacheDir: string): Promise<FetchResult> {
	const type = classifySource(source);

	if (type === "local") {
		const resolved = path.resolve(expandHome(source));
		const catalogPath = path.join(resolved, CATALOG_RELATIVE_PATH);

		let content: string;
		try {
			content = await Bun.file(catalogPath).text();
		} catch (err) {
			if (isEnoent(err)) {
				throw new Error(
					`Marketplace catalog not found at "${catalogPath}". ` +
						`Ensure the directory exists and contains a .claude-plugin/marketplace.json file.`,
				);
			}
			throw err;
		}

		const catalog = parseMarketplaceCatalog(content, catalogPath);
		return { catalog };
	}

	if (type === "github") {
		const url = `https://github.com/${source}.git`;
		return cloneAndReadCatalog(url, cacheDir);
	}

	if (type === "git") {
		return cloneAndReadCatalog(source, cacheDir);
	}

	// type === "url"
	// URL 类型：直接 HTTP 抓取目录文件，并将原文缓存到本地
	const response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
	if (!response.ok) {
		throw new Error(
			`Failed to fetch marketplace catalog from ${source}: HTTP ${response.status} ${response.statusText}`,
		);
	}
	const text = await response.text();
	const catalog = parseMarketplaceCatalog(text, source);

	const catalogDir = path.join(cacheDir, catalog.name);
	await Bun.write(path.join(catalogDir, "marketplace.json"), text);

	return { catalog };
}

// ── cloneAndReadCatalog ───────────────────────────────────────────────
// 克隆 git 仓库并读取其目录文件

/**
 * Clone a git repository and read its marketplace catalog.
 *
 * Clones to a temporary directory and reads the catalog. The caller is
 * responsible for promoting the clone to its final cache location via
 * `promoteCloneToCache` after any duplicate/drift checks pass.
 *
 * 克隆 git 仓库到临时目录并读取其 marketplace 目录；
 * 仅当后续重名/漂移检查通过后，调用方再用 promoteCloneToCache 提升到最终缓存位置。
 */
async function cloneAndReadCatalog(url: string, cacheDir: string): Promise<FetchResult> {
	const tmpDir = path.join(cacheDir, `.tmp-clone-${Date.now()}`);
	await fs.mkdir(cacheDir, { recursive: true });

	logger.debug(`[marketplace] cloning ${url} → ${tmpDir}`);
	await git.clone(url, tmpDir);

	const catalogPath = path.join(tmpDir, CATALOG_RELATIVE_PATH);
	let content: string;
	try {
		content = await Bun.file(catalogPath).text();
	} catch (err) {
		await fs.rm(tmpDir, { recursive: true, force: true });
		if (isEnoent(err)) {
			throw new Error(`Cloned repository has no marketplace catalog at ${CATALOG_RELATIVE_PATH}`);
		}
		throw err;
	}

	let catalog: MarketplaceCatalog;
	try {
		catalog = parseMarketplaceCatalog(content, catalogPath);
	} catch (err) {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		throw err;
	}

	return { catalog, clonePath: tmpDir };
}

/**
 * Promote a temporary clone directory to its final cache location.
 *
 * Callers should invoke this only after duplicate/drift checks pass.
 * Removes any existing directory at the target path before renaming.
 *
 * 将临时克隆目录提升到最终缓存位置；重命名前会先移除目标位置已有的旧目录。
 */
export async function promoteCloneToCache(tmpDir: string, cacheDir: string, name: string): Promise<string> {
	const finalDir = path.join(cacheDir, name);
	await fs.rm(finalDir, { recursive: true, force: true });
	await fs.rename(tmpDir, finalDir);
	return finalDir;
}


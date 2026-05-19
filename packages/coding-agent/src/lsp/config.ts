
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, isRecord, logger } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { getConfigDirPaths } from "../config";
import { getPreloadedPluginRoots } from "../discovery/helpers";
import { BiomeClient } from "./clients/biome-client";
import { SwiftLintClient } from "./clients/swiftlint-client";
import DEFAULTS from "./defaults.json" with { type: "json" };
import type { ServerConfig } from "./types";

/** LSP 配置（包含服务器列表和空闲超时） */
export interface LspConfig {
	servers: Record<string, ServerConfig>;
	/** Idle timeout in milliseconds. If set, LSP clients will be shutdown after this period of inactivity. Disabled by default. */
	/** 空闲超时（毫秒）。设置后，LSP 客户端在此时间段无活动后将被关闭。默认禁用。 */
	idleTimeoutMs?: number;
}

// =============================================================================
// 默认服务器配置加载
// =============================================================================

/** 进程 ID 占位符，在运行时替换为实际 PID */
const PID_TOKEN = "$PID";

/** 标准化后的配置结构 */
interface NormalizedConfig {
	servers: Record<string, Partial<ServerConfig>>;
	idleTimeoutMs?: number;
}

/** 根据文件扩展名解析配置内容（支持 JSON 和 YAML） */
function parseConfigContent(content: string, filePath: string): unknown {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === ".yaml" || extension === ".yml") {
		return YAML.parse(content) as unknown;
	}
	return JSON.parse(content) as unknown;
}

/** 标准化配置对象，提取 servers 和 idleTimeoutMs */
function normalizeConfig(value: unknown): NormalizedConfig | null {
	if (!isRecord(value)) return null;

	const idleTimeoutMs = typeof value.idleTimeoutMs === "number" ? value.idleTimeoutMs : undefined;
	const rawServers = value.servers;

	if (isRecord(rawServers)) {
		return { servers: rawServers as Record<string, Partial<ServerConfig>>, idleTimeoutMs };
	}

	const servers = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "idleTimeoutMs")) as Record<
		string,
		Partial<ServerConfig>
	>;

	return { servers, idleTimeoutMs };
}

/** 标准化字符串数组，过滤空值 */
function normalizeStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const items = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return items.length > 0 ? items : null;
}

/** 标准化单个服务器配置，验证必需字段 */
function normalizeServerConfig(name: string, config: Partial<ServerConfig>): ServerConfig | null {
	const command = typeof config.command === "string" && config.command.length > 0 ? config.command : null;
	const fileTypes = normalizeStringArray(config.fileTypes);
	const rootMarkers = normalizeStringArray(config.rootMarkers);

	if (!command || !fileTypes || !rootMarkers) {
		logger.warn("Ignoring invalid LSP server config (missing required fields).", { name });
		return null;
	}

	const args = Array.isArray(config.args)
		? config.args.filter((entry): entry is string => typeof entry === "string")
		: undefined;

	return {
		...config,
		command,
		args,
		fileTypes,
		rootMarkers,
	};
}

/** 读取并解析配置文件 */
function readConfigFile(filePath: string): NormalizedConfig | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const parsed = parseConfigContent(content, filePath);
		return normalizeConfig(parsed);
	} catch {
		return null;
	}
}

/** 将部分服务器配置强制转换为完整配置 */
function coerceServerConfigs(servers: Record<string, Partial<ServerConfig>>): Record<string, ServerConfig> {
	const result: Record<string, ServerConfig> = {};
	for (const [name, config] of Object.entries(servers)) {
		const normalized = normalizeServerConfig(name, config);
		if (normalized) {
			result[name] = normalized;
		}
	}
	return result;
}

/** 合并基础配置和覆盖配置 */
function mergeServers(
	base: Record<string, ServerConfig>,
	overrides: Record<string, Partial<ServerConfig>>,
): Record<string, ServerConfig> {
	const merged: Record<string, ServerConfig> = { ...base };
	for (const [name, config] of Object.entries(overrides)) {
		if (merged[name]) {
			const candidate = { ...merged[name], ...config };
			const normalized = normalizeServerConfig(name, candidate);
			if (normalized) {
				merged[name] = normalized;
			} else {
				logger.warn("Ignoring invalid LSP overrides (keeping previous config).", { name });
			}
		} else {
			const normalized = normalizeServerConfig(name, config);
			if (normalized) {
				merged[name] = normalized;
			}
		}
	}
	return merged;
}

/** 应用运行时默认值（如 Biome/SwiftLint 客户端工厂、OmniSharp PID 替换） */
function applyRuntimeDefaults(servers: Record<string, ServerConfig>): Record<string, ServerConfig> {
	const updated: Record<string, ServerConfig> = { ...servers };

	if (updated.biome) {
		updated.biome = { ...updated.biome, createClient: BiomeClient.create };
	}

	if (updated.swiftlint) {
		updated.swiftlint = { ...updated.swiftlint, createClient: SwiftLintClient.create };
	}

	if (updated.omnisharp?.args) {
		const args = updated.omnisharp.args.map(arg => (arg === PID_TOKEN ? String(process.pid) : arg));
		updated.omnisharp = { ...updated.omnisharp, args };
	}

	return updated;
}

// =============================================================================
// 配置加载
// =============================================================================

/**
 * Check if any root marker file exists in the directory
 * 检查目录中是否存在任意根标记文件
 */
export function hasRootMarkers(cwd: string, markers: string[]): boolean {
	let entries: string[] | null = null;
	for (const marker of markers) {
		// 处理类 glob 模式（如 "*.cabal"）。根标记位于项目根目录，
		// 因此单层 readdir 即可，避免 Bun.Glob 递归进入 node_modules
		if (marker.includes("*")) {
			if (entries === null) {
				try {
					entries = fs.readdirSync(cwd);
				} catch {
					entries = [];
					logger.warn("Failed to list directory for glob root marker.", { marker, cwd });
				}
			}
			const glob = new Bun.Glob(marker);
			for (const entry of entries) {
				if (glob.match(entry)) {
					return true;
				}
			}
			continue;
		}
		const filePath = path.join(cwd, marker);
		if (fs.existsSync(filePath)) {
			return true;
		}
	}
	return false;
}

// =============================================================================
// 本地二进制文件解析
// =============================================================================

/**
 * Local bin directories to check before $PATH, ordered by priority.
 * Each entry maps a root marker to the bin directory to check.
 * 优先于 $PATH 检查的本地 bin 目录，按优先级排列。
 */
const LOCAL_BIN_PATHS: Array<{ markers: string[]; binDir: string }> = [
	// Node.js - check node_modules/.bin/
	{ markers: ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"], binDir: "node_modules/.bin" },
	// Python - check virtual environment bin directories
	{ markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"], binDir: ".venv/bin" },
	{ markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"], binDir: "venv/bin" },
	{ markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"], binDir: ".env/bin" },
	// Ruby - check vendor bundle and binstubs
	{ markers: ["Gemfile", "Gemfile.lock"], binDir: "vendor/bundle/bin" },
	{ markers: ["Gemfile", "Gemfile.lock"], binDir: "bin" },
	// Go - check project-local bin
	{ markers: ["go.mod", "go.sum"], binDir: "bin" },
];

/** Windows 平台本地可执行文件扩展名 */
const WINDOWS_LOCAL_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat"] as const;

/** 解析本地命令路径，支持 Windows 扩展名 */
function resolveLocalCommand(basePath: string): string | null {
	if (fs.existsSync(basePath)) return basePath;
	if (process.platform !== "win32") return null;

	// 包管理器在 node_modules/.bin 中写入带可执行后缀的 Windows 启动器
	for (const extension of WINDOWS_LOCAL_EXECUTABLE_EXTENSIONS) {
		const candidate = `${basePath}${extension}`;
		if (fs.existsSync(candidate)) return candidate;
	}

	return null;
}

/**
 * Resolve a command to an executable path.
 * Checks project-local bin directories first, then falls back to $PATH.
 *
 * @param command - The command name (e.g., "typescript-language-server")
 * @param cwd - Working directory to search from
 * @returns Absolute path to the executable, or null if not found
 */
export function resolveCommand(command: string, cwd: string): string | null {
	// 根据项目标记检查本地 bin 目录
	for (const { markers, binDir } of LOCAL_BIN_PATHS) {
		if (hasRootMarkers(cwd, markers)) {
			const localPath = path.join(cwd, binDir, command);
			const resolvedLocalPath = resolveLocalCommand(localPath);
			if (resolvedLocalPath) {
				return resolvedLocalPath;
			}
		}
	}

	// 回退到 $PATH 查找
	return $which(command);
}

/**
 * Configuration file search paths (in priority order).
 * Supports both visible and hidden variants at each config location.
 */
function getConfigPaths(cwd: string): string[] {
	const filenames = ["lsp.json", ".lsp.json", "lsp.yaml", ".lsp.yaml", "lsp.yml", ".lsp.yml"];
	const paths: string[] = [];

	// Project root files (highest priority)
	for (const filename of filenames) {
		paths.push(path.join(cwd, filename));
	}

	// Project config directories (.omp/, .pi/, .claude/)
	const projectDirs = getConfigDirPaths("", { user: false, project: true, cwd });
	for (const dir of projectDirs) {
		for (const filename of filenames) {
			paths.push(path.join(dir, filename));
		}
	}

	// User config directories (~/.omp/agent/, ~/.pi/agent/, ~/.claude/)
	const userDirs = getConfigDirPaths("", { user: true, project: false });
	for (const dir of userDirs) {
		for (const filename of filenames) {
			paths.push(path.join(dir, filename));
		}
	}

	// Plugin LSP configs (from marketplace/--plugin-dir roots)
	const pluginRoots = getPreloadedPluginRoots();
	for (const root of pluginRoots) {
		for (const filename of filenames) {
			paths.push(path.join(root.path, filename));
		}
	}

	// User home root files (lowest priority fallback)
	for (const filename of filenames) {
		paths.push(path.join(os.homedir(), filename));
	}

	return paths;
}

/**
 * Load LSP configuration.
 *
 * Priority (highest to lowest):
 * 1. Project root: lsp.json/.lsp.json/lsp.yml/.lsp.yml/lsp.yaml/.lsp.yaml
 * 2. Project config dirs: .omp/lsp.*, .pi/lsp.*, .claude/lsp.* (+ hidden variants)
 * 3. User config dirs: ~/.omp/agent/lsp.*, ~/.pi/agent/lsp.*, ~/.claude/lsp.* (+ hidden variants)
 * 4. User home root: ~/lsp.*, ~/.lsp.*
 * 5. Auto-detect from project markers + available binaries
 *
 * Config files are merged from lowest to highest priority; later files override earlier settings.
 *
 * Config file format (JSON or YAML):
 * ```json
 * {
 *   "servers": {
 *     "typescript-language-server": {
 *       "command": "typescript-language-server",
 *       "args": ["--stdio", "--log-level", "4"],
 *       "disabled": false
 *     },
 *     "my-custom-server": {
 *       "command": "/path/to/server",
 *       "args": ["--stdio"],
 *       "fileTypes": [".xyz"],
 *       "rootMarkers": [".xyz-project"]
 *     }
 *   }
 * }
 * ```
 */
export function loadConfig(cwd: string): LspConfig {
	let mergedServers = coerceServerConfigs(DEFAULTS);

	const configPaths = getConfigPaths(cwd).reverse();
	let hasOverrides = false;

	let idleTimeoutMs: number | undefined;
	for (const configPath of configPaths) {
		const parsed = readConfigFile(configPath);
		if (!parsed) continue;
		const hasServerOverrides = Object.keys(parsed.servers).length > 0;
		if (hasServerOverrides) {
			hasOverrides = true;
			mergedServers = mergeServers(mergedServers, parsed.servers);
		}
		if (parsed.idleTimeoutMs !== undefined) {
			idleTimeoutMs = parsed.idleTimeoutMs;
		}
	}

	if (!hasOverrides) {
		// Auto-detect: find servers based on project markers AND available binaries
		const detected: Record<string, ServerConfig> = {};
		const defaultsWithRuntime = applyRuntimeDefaults(mergedServers);

		for (const [name, config] of Object.entries(defaultsWithRuntime)) {
			// Check if project has root markers for this language
			if (!hasRootMarkers(cwd, config.rootMarkers)) continue;

			// Check if the language server binary is available (local or $PATH)
			const resolved = resolveCommand(config.command, cwd);
			if (!resolved) continue;

			detected[name] = { ...config, resolvedCommand: resolved };
		}

		return { servers: detected, idleTimeoutMs };
	}

	// Merge overrides with defaults and filter to available servers
	const mergedWithRuntime = applyRuntimeDefaults(mergedServers);
	const available: Record<string, ServerConfig> = {};

	for (const [name, config] of Object.entries(mergedWithRuntime)) {
		if (config.disabled) continue;
		if (!hasRootMarkers(cwd, config.rootMarkers)) continue;
		const resolved = resolveCommand(config.command, cwd);
		if (!resolved) continue;
		available[name] = { ...config, resolvedCommand: resolved };
	}

	return { servers: available, idleTimeoutMs };
}

// =============================================================================
// 服务器选择
// =============================================================================

/**
 * Find all servers that can handle a file based on extension.
 * Returns servers sorted with primary (non-linter) servers first.
 * 根据文件扩展名查找所有可处理该文件的服务器，主服务器（非检查器）优先排列。
 */
export function getServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	const ext = path.extname(filePath).toLowerCase();
	const fileName = path.basename(filePath).toLowerCase();
	const matches: Array<[string, ServerConfig]> = [];

	for (const [name, serverConfig] of Object.entries(config.servers)) {
		const supportsFile = serverConfig.fileTypes.some(fileType => {
			const normalized = fileType.toLowerCase();
			return normalized === ext || normalized === fileName;
		});

		if (supportsFile) {
			matches.push([name, serverConfig]);
		}
	}

	// 排序：主服务器（非检查器）优先，检查器在后
	return matches.sort((a, b) => {
		const aIsLinter = a[1].isLinter ? 1 : 0;
		const bIsLinter = b[1].isLinter ? 1 : 0;
		return aIsLinter - bIsLinter;
	});
}

/**
 * Find the primary server for a file (prefers type-checkers over linters).
 * Used for operations like definition, hover, references that need type intelligence.
 * 查找文件的主服务器（优先选择类型检查器），用于需要类型推导的操作。
 */
export function getServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	const servers = getServersForFile(config, filePath);
	return servers.length > 0 ? servers[0] : null;
}

/**
 * Check if a server has a specific capability
 * 检查服务器是否具有特定能力
 */
export function hasCapability(
	config: ServerConfig,
	capability: keyof NonNullable<ServerConfig["capabilities"]>,
): boolean {
	return config.capabilities?.[capability] === true;
}


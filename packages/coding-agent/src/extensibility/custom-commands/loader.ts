
/**
 * Custom command loader - loads TypeScript command modules using native Bun import.
 *
 * Dependencies (the zod-backed typebox shim and pi-coding-agent) are injected via the
 * CustomCommandAPI to avoid import resolution issues with custom commands loaded from user directories.
 *
 * 自定义命令加载器 —— 使用 Bun 原生 import 加载 TypeScript 命令模块。
 * 依赖项（基于 zod 的 typebox 兼容层与 pi-coding-agent）通过 CustomCommandAPI 注入，
 * 以避免从用户目录加载自定义命令时出现的 import 解析问题。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, getProjectDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import * as zod from "zod/v4";
import { getConfigDirs } from "../../config";
import { execCommand } from "../../exec/exec";
import * as typebox from "../typebox";
import { GreenCommand } from "./bundled/ci-green";
import { ReviewCommand } from "./bundled/review";
import type {
	CustomCommand,
	CustomCommandAPI,
	CustomCommandFactory,
	CustomCommandSource,
	CustomCommandsLoadResult,
	LoadedCustomCommand,
} from "./types";

/**
 * Load a single command module using native Bun import.
 * 使用 Bun 原生 import 加载单个命令模块。
 */
async function loadCommandModule(
	commandPath: string,
	_cwd: string,
	sharedApi: CustomCommandAPI,
): Promise<{ commands: CustomCommand[] | null; error: string | null }> {
	try {
		const module = await import(commandPath);
		// 优先取默认导出，否则将整个模块视为工厂函数
		const factory = (module.default ?? module) as CustomCommandFactory;

		if (typeof factory !== "function") {
			return { commands: null, error: "Command must export a default function" };
		}

		const result = await factory(sharedApi);
		// 支持工厂返回单个命令或命令数组
		const commands = Array.isArray(result) ? result : [result];

		// Validate commands
		// 校验命令必填字段：name / description / execute
		for (const cmd of commands) {
			if (!cmd.name || typeof cmd.name !== "string") {
				return { commands: null, error: "Command must have a name" };
			}
			if (!cmd.description || typeof cmd.description !== "string") {
				return { commands: null, error: `Command "${cmd.name}" must have a description` };
			}
			if (typeof cmd.execute !== "function") {
				return { commands: null, error: `Command "${cmd.name}" must have an execute function` };
			}
		}

		return { commands, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { commands: null, error: `Failed to load command: ${message}` };
	}
}

/** 自定义命令发现选项 */
export interface DiscoverCustomCommandsOptions {
	/** Current working directory. Default: getProjectDir()
	 *  当前工作目录，默认取 getProjectDir() */
	cwd?: string;
	/** Agent config directory. Default: from getAgentDir()
	 *  Agent 配置目录，默认取 getAgentDir() */
	agentDir?: string;
}

/** 命令模块发现结果 */
export interface DiscoverCustomCommandsResult {
	/** Paths to command modules
	 *  命令模块路径列表及其来源 */
	paths: Array<{ path: string; source: CustomCommandSource }>;
}

/**
 * Discover custom command modules (TypeScript slash commands).
 * Markdown slash commands are handled by core/slash-commands.ts.
 *
 * 发现自定义命令模块（TypeScript 斜杠命令）。
 * Markdown 斜杠命令由 core/slash-commands.ts 处理。
 */
export async function discoverCustomCommands(
	options: DiscoverCustomCommandsOptions = {},
): Promise<DiscoverCustomCommandsResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();
	const paths: Array<{ path: string; source: CustomCommandSource }> = [];
	const seen = new Set<string>();

	// 添加路径并按解析后的绝对路径去重
	const addPath = (commandPath: string, source: CustomCommandSource): void => {
		const resolved = path.resolve(commandPath);
		if (seen.has(resolved)) return;
		seen.add(resolved);
		paths.push({ path: resolved, source });
	};

	const commandDirs: Array<{ path: string; source: CustomCommandSource }> = [];
	// 用户级 commands 目录（来自 agent 配置目录）
	if (agentDir) {
		const userCommandsDir = path.join(agentDir, "commands");
		if (fs.existsSync(userCommandsDir)) {
			commandDirs.push({ path: userCommandsDir, source: "user" });
		}
	}

	// 从分层配置目录中追加 commands 目录（user / project 级别）
	for (const entry of getConfigDirs("commands", { cwd, existingOnly: true })) {
		const source = entry.level === "user" ? "user" : "project";
		if (!commandDirs.some(d => d.path === entry.path)) {
			commandDirs.push({ path: entry.path, source });
		}
	}

	// 在每个命令子目录中查找入口文件（支持 .ts/.js/.mjs/.cjs）
	const indexCandidates = ["index.ts", "index.js", "index.mjs", "index.cjs"];
	for (const { path: commandsDir, source } of commandDirs) {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(commandsDir, { withFileTypes: true });
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("Failed to read custom commands directory", { path: commandsDir, error: String(error) });
			}
			continue;
		}
		for (const entry of entries) {
			// 跳过非目录条目和隐藏目录
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const commandDir = path.join(commandsDir, entry.name);

			for (const filename of indexCandidates) {
				const candidate = path.join(commandDir, filename);
				if (fs.existsSync(candidate)) {
					addPath(candidate, source);
					break;
				}
			}
		}
	}

	return { paths };
}

/** 自定义命令加载选项 */
export interface LoadCustomCommandsOptions {
	/** Current working directory. Default: getProjectDir()
	 *  当前工作目录，默认取 getProjectDir() */
	cwd?: string;
	/** Agent config directory. Default: from getAgentDir()
	 *  Agent 配置目录，默认取 getAgentDir() */
	agentDir?: string;
}

/**
 * Load bundled commands (shipped with pi-coding-agent).
 * 加载内置（随 pi-coding-agent 一起发布）命令。
 */
function loadBundledCommands(sharedApi: CustomCommandAPI): LoadedCustomCommand[] {
	const bundled: LoadedCustomCommand[] = [];

	// Add bundled commands here
	// 在此注册内置命令
	bundled.push({
		path: "bundled:green",
		resolvedPath: "bundled:green",
		command: new GreenCommand(sharedApi),
		source: "bundled",
	});
	bundled.push({
		path: "bundled:review",
		resolvedPath: "bundled:review",
		command: new ReviewCommand(sharedApi),
		source: "bundled",
	});

	return bundled;
}

/**
 * Discover and load custom commands from standard locations.
 * 从标准位置发现并加载所有自定义命令。
 */
export async function loadCustomCommands(options: LoadCustomCommandsOptions = {}): Promise<CustomCommandsLoadResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();

	const { paths } = await discoverCustomCommands({ cwd, agentDir });

	const commands: LoadedCustomCommand[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const seenNames = new Set<string>();

	// Shared API object - all commands get the same instance
	// 共享 API 对象 —— 所有命令共用同一实例
	const sharedApi: CustomCommandAPI = {
		cwd,
		exec: (command: string, args: string[], execOptions) =>
			execCommand(command, args, execOptions?.cwd ?? cwd, execOptions),
		typebox,
		zod,
		pi: await import("@oh-my-pi/pi-coding-agent"),
	};

	// 1. Load bundled commands first (lowest priority - can be overridden)
	// 1. 先加载内置命令（优先级最低，可被覆盖）
	for (const loaded of loadBundledCommands(sharedApi)) {
		seenNames.add(loaded.command.name);
		commands.push(loaded);
	}

	// 2. Load user/project commands (can override bundled)
	// 2. 加载用户级 / 项目级命令（可覆盖内置命令）
	for (const { path: commandPath, source } of paths) {
		const { commands: loadedCommands, error } = await loadCommandModule(commandPath, cwd, sharedApi);

		if (error) {
			errors.push({ path: commandPath, error });
			continue;
		}

		if (loadedCommands) {
			for (const command of loadedCommands) {
				// Allow overriding bundled commands, but not user/project conflicts
				// 允许覆盖内置命令，但不允许 user/project 命令之间出现冲突
				const existingIdx = commands.findIndex(c => c.command.name === command.name);
				if (existingIdx !== -1) {
					const existing = commands[existingIdx];
					if (existing.source === "bundled") {
						// Override bundled command
						// 覆盖内置命令
						commands.splice(existingIdx, 1);
						seenNames.delete(command.name);
					} else {
						// Conflict between user/project commands
						// 用户级与项目级命令之间的命名冲突
						errors.push({
							path: commandPath,
							error: `Command name "${command.name}" conflicts with existing command`,
						});
						continue;
					}
				}

				seenNames.add(command.name);
				commands.push({
					path: commandPath,
					resolvedPath: path.resolve(commandPath),
					command,
					source,
				});
			}
		}
	}

	return { commands, errors };
}


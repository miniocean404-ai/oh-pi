
/**
 * Custom tool loader - loads TypeScript tool modules using native Bun import.
 *
 * Dependencies (the zod-backed typebox shim and pi-coding-agent) are injected via the
 * CustomToolAPI to avoid import resolution issues with custom tools loaded from user directories.
 *
 * 自定义工具加载器 —— 使用 Bun 原生 import 加载 TypeScript 工具模块。
 * 依赖项（基于 zod 的 typebox 兼容层与 pi-coding-agent）通过 CustomToolAPI 注入，
 * 以避免从用户目录加载自定义工具时出现的 import 解析问题。
 */
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import { toolCapability } from "../../capability/tool";
import { type CustomTool, loadCapability } from "../../discovery";
import type { ExecOptions } from "../../exec/exec";
import { execCommand } from "../../exec/exec";
import type { HookUIContext } from "../../extensibility/hooks/types";
import { getAllPluginToolPaths } from "../../extensibility/plugins/loader";
import * as typebox from "../typebox";
import { createNoOpUIContext, resolvePath } from "../utils";
import type { CustomToolAPI, CustomToolFactory, LoadedCustomTool, ToolLoadError } from "./types";

/**
 * Load a single tool module using native Bun import.
 * 使用 Bun 原生 import 加载单个工具模块。
 */
async function loadTool(
	toolPath: string,
	cwd: string,
	sharedApi: CustomToolAPI,
	source?: { provider: string; providerName: string; level: "user" | "project" },
): Promise<{ tools: LoadedCustomTool[] | null; error: ToolLoadError | null }> {
	const resolvedPath = resolvePath(toolPath, cwd);

	// Skip declarative tool files (.md, .json) - these are metadata only, not executable modules
	// 跳过声明式工具文件（.md/.json） —— 它们仅是元数据，不能作为可执行模块加载
	if (resolvedPath.endsWith(".md") || resolvedPath.endsWith(".json")) {
		return {
			tools: null,
			error: {
				path: toolPath,
				error: "Declarative tool files (.md, .json) cannot be loaded as executable modules",
				source,
			},
		};
	}

	try {
		const module = await import(resolvedPath);
		// 优先取默认导出，否则将整个模块视为工厂函数
		const factory = (module.default ?? module) as CustomToolFactory;

		if (typeof factory !== "function") {
			return { tools: null, error: { path: toolPath, error: "Tool must export a default function", source } };
		}

		const toolResult = await factory(sharedApi);
		// 兼容工厂返回单个工具或工具数组的情况
		const toolsArray = Array.isArray(toolResult) ? toolResult : [toolResult];

		const loadedTools: LoadedCustomTool[] = toolsArray.map(tool => ({
			path: toolPath,
			resolvedPath,
			tool,
			source,
		}));

		return { tools: loadedTools, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { tools: null, error: { path: toolPath, error: `Failed to load tool: ${message}`, source } };
	}
}

/** Tool path with optional source metadata
 *  附带可选来源元数据的工具路径 */
interface ToolPathWithSource {
	path: string;
	source?: { provider: string; providerName: string; level: "user" | "project" };
}

/**
 * Loads custom tools from paths with conflict detection and error handling.
 *
 * Manages a shared API instance passed to all tool factories, providing access to
 * execution context, UI, logger, and injected dependencies. The UI context can be
 * updated after loading via setUIContext().
 *
 * 从给定路径加载自定义工具，并处理命名冲突与错误收集。
 *
 * 管理传给所有工具工厂的共享 API 实例，提供执行上下文、UI、logger 与注入依赖。
 * 加载完成后可通过 setUIContext() 更新 UI 上下文。
 */
export class CustomToolLoader {
	tools: LoadedCustomTool[] = [];
	errors: ToolLoadError[] = [];
	#sharedApi: CustomToolAPI;
	#seenNames: Set<string>;

	constructor(
		pi: typeof import("@oh-my-pi/pi-coding-agent"),
		cwd: string,
		builtInToolNames: string[],
		pushPendingAction?: (action: {
			label: string;
			sourceToolName: string;
			apply(reason: string): Promise<AgentToolResult<unknown>>;
			reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;
		}) => void,
	) {
		this.#sharedApi = {
			cwd,
			exec: (command: string, args: string[], options?: ExecOptions) =>
				execCommand(command, args, options?.cwd ?? cwd, options),
			// 默认使用空操作 UI 上下文，模式初始化后通过 setUIContext 替换
			ui: createNoOpUIContext(),
			hasUI: false,
			logger,
			typebox,
			zod: z,
			pi,
			pushPendingAction: action => {
				if (!pushPendingAction) {
					throw new Error("Pending action store unavailable for custom tools in this runtime.");
				}
				pushPendingAction({
					label: action.label,
					sourceToolName: action.sourceToolName ?? "custom_tool",
					apply: action.apply,
					reject: action.reject,
				});
			},
		};
		// 初始化已见名集合，预先包含所有内置工具名以便冲突检测
		this.#seenNames = new Set<string>(builtInToolNames);
	}

	async load(pathsWithSources: ToolPathWithSource[]): Promise<void> {
		for (const { path: toolPath, source } of pathsWithSources) {
			const { tools: loadedTools, error } = await loadTool(toolPath, this.#sharedApi.cwd, this.#sharedApi, source);

			if (error) {
				this.errors.push(error);
				continue;
			}

			if (loadedTools) {
				for (const loadedTool of loadedTools) {
					// Check for name conflicts
					// 检测工具命名冲突
					if (this.#seenNames.has(loadedTool.tool.name)) {
						this.errors.push({
							path: toolPath,
							error: `Tool name "${loadedTool.tool.name}" conflicts with existing tool`,
							source,
						});
						continue;
					}

					this.#seenNames.add(loadedTool.tool.name);
					this.tools.push(loadedTool);
				}
			}
		}
	}

	/** 模式初始化完成后注入真正的 UI 上下文 */
	setUIContext(uiContext: HookUIContext, hasUI: boolean): void {
		this.#sharedApi.ui = uiContext;
		this.#sharedApi.hasUI = hasUI;
	}
}

/**
 * Load all tools from configuration.
 * @param pathsWithSources - Array of tool paths with optional source metadata
 * @param cwd - Current working directory for resolving relative paths
 * @param builtInToolNames - Names of built-in tools to check for conflicts
 *
 * 根据给定配置加载所有自定义工具。
 * @param pathsWithSources - 带可选来源元数据的工具路径数组
 * @param cwd - 用于解析相对路径的当前工作目录
 * @param builtInToolNames - 用于检测命名冲突的内置工具名集合
 */
export async function loadCustomTools(
	pathsWithSources: ToolPathWithSource[],
	cwd: string,
	builtInToolNames: string[],
	pushPendingAction?: (action: {
		label: string;
		sourceToolName: string;
		apply(reason: string): Promise<AgentToolResult<unknown>>;
		reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;
	}) => void,
) {
	const loader = new CustomToolLoader(
		await import("@oh-my-pi/pi-coding-agent"),
		cwd,
		builtInToolNames,
		pushPendingAction,
	);
	await loader.load(pathsWithSources);
	return {
		tools: loader.tools,
		errors: loader.errors,
		setUIContext: (uiContext: HookUIContext, hasUI: boolean) => {
			loader.setUIContext(uiContext, hasUI);
		},
	};
}

/**
 * Discover and load tools from standard locations via capability system:
 * 1. User and project tools discovered by capability providers
 * 2. Installed plugins (~/.omp/plugins/node_modules/*)
 * 3. Explicitly configured paths from settings or CLI
 *
 * @param configuredPaths - Explicit paths from settings.json and CLI --tool flags
 * @param cwd - Current working directory
 * @param builtInToolNames - Names of built-in tools to check for conflicts
 *
 * 通过 capability 系统从以下标准位置发现并加载自定义工具：
 * 1. capability provider 发现的用户级与项目级工具
 * 2. 已安装插件（~/.omp/plugins/node_modules/*）
 * 3. 通过 settings 或 CLI --tool 显式配置的路径
 *
 * @param configuredPaths - 来自 settings.json 与 CLI --tool 参数的显式路径
 * @param cwd - 当前工作目录
 * @param builtInToolNames - 用于检测命名冲突的内置工具名集合
 */
export async function discoverAndLoadCustomTools(
	configuredPaths: string[],
	cwd: string,
	builtInToolNames: string[],
	pushPendingAction?: (action: {
		label: string;
		sourceToolName: string;
		apply(reason: string): Promise<AgentToolResult<unknown>>;
		reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;
	}) => void,
) {
	const allPathsWithSources: ToolPathWithSource[] = [];
	const seen = new Set<string>();

	// Helper to add paths without duplicates
	// 按解析后的绝对路径去重后再加入列表
	const addPath = (p: string, source?: { provider: string; providerName: string; level: "user" | "project" }) => {
		const resolved = path.resolve(p);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			allPathsWithSources.push({ path: p, source });
		}
	};

	// 1. Discover tools via capability system (user + project from all providers)
	// 1. 通过 capability 系统发现工具（聚合所有 provider 的 user/project 来源）
	const discoveredTools = await loadCapability<CustomTool>(toolCapability.id, { cwd });
	for (const tool of discoveredTools.items) {
		addPath(tool.path, {
			provider: tool._source.provider,
			providerName: tool._source.providerName,
			level: tool.level,
		});
	}

	// 2. Plugin tools: ~/.omp/plugins/node_modules/*/
	// 2. 插件工具：~/.omp/plugins/node_modules/*/
	for (const pluginPath of await getAllPluginToolPaths(cwd)) {
		addPath(pluginPath, { provider: "plugin", providerName: "Plugin", level: "user" });
	}

	// 3. Explicitly configured paths (can override/add)
	// 3. 显式配置路径（可覆盖或补充）
	for (const configPath of configuredPaths) {
		addPath(resolvePath(configPath, cwd), { provider: "config", providerName: "Config", level: "project" });
	}

	return loadCustomTools(allPathsWithSources, cwd, builtInToolNames, pushPendingAction);
}


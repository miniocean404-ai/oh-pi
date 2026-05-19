
/**
 * Custom command types.
 *
 * Custom commands are TypeScript modules that define executable slash commands.
 * Unlike markdown commands which expand to prompts, custom commands can execute
 * arbitrary logic with full access to the hook context.
 *
 * 自定义命令相关类型。
 *
 * 自定义命令是定义可执行斜杠命令的 TypeScript 模块。
 * 与会展开为 prompt 的 markdown 命令不同，自定义命令可以执行
 * 任意逻辑，并完整访问 hook 上下文。
 */
import type { ExecOptions, ExecResult, HookCommandContext } from "../../extensibility/hooks/types";

// Re-export for custom commands to use
// 重新导出，便于自定义命令使用
export type { ExecOptions, ExecResult, HookCommandContext };

/**
 * API passed to custom command factory.
 * Similar to HookAPI but focused on command needs.
 *
 * 传入自定义命令工厂的 API。
 * 类似 HookAPI，但聚焦于命令相关需求。
 */
export interface CustomCommandAPI {
	/** Current working directory
	 *  当前工作目录 */
	cwd: string;
	/** Execute a shell command
	 *  执行 shell 命令 */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
	/** Injected zod-backed typebox shim (legacy/compat).
	 *  注入的基于 zod 的 typebox 兼容层（遗留 / 兼容用途）。 */
	typebox: typeof import("../typebox");
	/** Injected zod module for Zod-authored custom commands.
	 *  注入的 zod 模块，供基于 Zod 编写的自定义命令使用。 */
	zod: typeof import("zod/v4");
	/** Injected pi-coding-agent exports
	 *  注入的 pi-coding-agent 包导出 */
	pi: typeof import("../..");
}

/**
 * Custom command definition.
 *
 * Commands can either:
 * - Return a string to be sent to the LLM as a prompt
 * - Return void/undefined to do nothing (fire-and-forget)
 *
 * 自定义命令定义。
 *
 * 命令可以：
 * - 返回字符串，作为 prompt 发送给 LLM
 * - 返回 void/undefined，不发送任何内容（fire-and-forget）
 *
 * @example
 * ```typescript
 * const factory: CustomCommandFactory = (pi) => ({
 *	  name: "deploy",
 *	  description: "Deploy current branch to staging",
 *	  async execute(args, ctx) {
 *		 const env = args[0] || "staging";
 *		 const confirmed = await ctx.ui.confirm("Deploy", `Deploy to ${env}?`);
 *		 if (!confirmed) return;
 *
 *		 const result = await pi.exec("./deploy.sh", [env]);
 *		 if (result.exitCode !== 0) {
 *			ctx.ui.notify(`Deploy failed: ${result.stderr}`, "error");
 *			return;
 *		 }
 *
 *		 ctx.ui.notify("Deploy successful!", "info");
 *		 // No return = no prompt sent to LLM
 *	  }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Return a prompt to send to the LLM
 * const factory: CustomCommandFactory = (pi) => ({
 *	  name: "git:status",
 *	  description: "Show git status and suggest actions",
 *	  async execute(args, ctx) {
 *		 const result = await pi.exec("git", ["status", "--porcelain"]);
 *		 return `Here's the git status:\n\`\`\`\n${result.stdout}\`\`\`\nSuggest what to do next.`;
 *	  }
 * });
 * ```
 */
export interface CustomCommand {
	/** Command name (can include namespace like "git:commit")
	 *  命令名（可包含命名空间，如 "git:commit"） */
	name: string;
	/** Description shown in command autocomplete
	 *  在命令自动补全中显示的描述 */
	description: string;
	/**
	 * Execute the command.
	 * @param args - Parsed command arguments
	 * @param ctx - Command context with UI and session control
	 * @returns String to send as prompt, or void for fire-and-forget
	 *
	 * 执行命令。
	 * @param args - 已解析的命令参数
	 * @param ctx - 命令上下文，提供 UI 与会话控制能力
	 * @returns 返回字符串作为 prompt 发送，或返回 void/undefined 表示无返回
	 */
	execute(args: string[], ctx: HookCommandContext): Promise<string | undefined> | string | undefined;
}

/**
 * Factory function that creates custom command(s).
 * Can return a single command or an array of commands.
 *
 * 用于创建自定义命令的工厂函数。
 * 可以返回单个命令或命令数组。
 */
export type CustomCommandFactory = (
	api: CustomCommandAPI,
) => CustomCommand | CustomCommand[] | Promise<CustomCommand | CustomCommand[]>;

/** Source of a loaded custom command
 *  已加载自定义命令的来源 */
export type CustomCommandSource = "bundled" | "user" | "project";

/** Loaded custom command with metadata
 *  已加载的自定义命令及其元数据 */
export interface LoadedCustomCommand {
	/** Original path to the command module
	 *  命令模块的原始路径 */
	path: string;
	/** Resolved absolute path
	 *  解析后的绝对路径 */
	resolvedPath: string;
	/** The command definition
	 *  命令定义本体 */
	command: CustomCommand;
	/** Where the command was loaded from
	 *  命令的加载来源 */
	source: CustomCommandSource;
}

/** Result from loading custom commands
 *  加载自定义命令的结果 */
export interface CustomCommandsLoadResult {
	commands: LoadedCustomCommand[];
	errors: Array<{ path: string; error: string }>;
}


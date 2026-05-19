
/**
 * Helper for wiring the `getCommands` action of {@link ExtensionAPI}.
 *
 * Centralizes the union over the three slash-command sources the runtime
 * exposes so the five wiring sites (interactive UI, ACP, RPC, print, child
 * task executor) cannot drift:
 *   - extension-registered hook commands (`source: "extension"`)
 *   - prompt commands loaded as `LoadedCustomCommand` — user/project/bundled
 *     custom commands and MCP prompts (`source: "prompt"`)
 *   - skill commands derived from `session.skills`, gated on
 *     `skillsSettings.enableSkillCommands` (`source: "skill"`)
 *
 * Built-in slash commands are intentionally excluded; `getCommands()` is the
 * surface extensions use to discover dynamic commands they did not register
 * themselves. Each frontend (interactive-mode, ACP) prepends its own builtins.
 *
 * 用于将 {@link ExtensionAPI} 的 `getCommands` 动作连接到底层会话的辅助函数。
 *
 * 统一处理运行时暴露的三类 slash 命令来源，避免五个接入点（interactive UI、
 * ACP、RPC、print、子任务执行器）出现差异：
 *   - 扩展注册的命令（`source: "extension"`）
 *   - 以 `LoadedCustomCommand` 形式加载的 prompt 命令（用户/项目/内置
 *     自定义命令以及 MCP prompts，`source: "prompt"`）
 *   - 由 `session.skills` 派生且受 `skillsSettings.enableSkillCommands`
 *     开关控制的 skill 命令（`source: "skill"`）
 *
 * 内置 slash 命令故意被排除：`getCommands()` 仅暴露扩展未自行注册的
 * 动态命令，各前端（interactive-mode、ACP）会在自己侧追加内置命令。
 */
import type { SkillsSettings } from "../../config/settings";
import type { CustomCommandSource, LoadedCustomCommand } from "../custom-commands";
import { getSkillSlashCommandName, type Skill } from "../skills";
import type { SlashCommandInfo, SlashCommandLocation } from "../slash-commands";
import type { ExtensionRunner } from "./runner";

interface CommandsCapableSession {
	readonly extensionRunner?: ExtensionRunner;
	readonly customCommands: ReadonlyArray<LoadedCustomCommand>;
	readonly skills: ReadonlyArray<Skill>;
	readonly skillsSettings?: SkillsSettings;
}

/**
 * 汇总当前会话所有可用的 slash 命令（来自扩展、自定义命令和 skill），
 * 不包含内置命令，由各前端自行追加内置项。
 */
export function getSessionSlashCommands(session: CommandsCapableSession): SlashCommandInfo[] {
	const out: SlashCommandInfo[] = [];

	// 1. 收集扩展注册的命令
	const runner = session.extensionRunner;
	if (runner) {
		for (const cmd of runner.getRegisteredCommands()) {
			out.push({
				name: cmd.name,
				description: cmd.description,
				source: "extension",
			});
		}
	}

	// 2. 收集自定义 prompt 命令（用户/项目/内置 + MCP prompts）
	for (const cmd of session.customCommands) {
		out.push({
			name: cmd.command.name,
			description: cmd.command.description,
			source: "prompt",
			location: customCommandLocation(cmd.source),
			path: cmd.resolvedPath,
		});
	}

	// 3. 仅当开启 skill 命令开关时收集 skill 命令
	if (session.skillsSettings?.enableSkillCommands) {
		for (const skill of session.skills) {
			out.push({
				name: getSkillSlashCommandName(skill),
				description: skill.description || undefined,
				source: "skill",
				path: skill.filePath,
			});
		}
	}

	return out;
}

/** 将自定义命令来源映射到 slash 命令 UI 的位置标签（user/project，bundled 不显示位置）。 */
function customCommandLocation(source: CustomCommandSource): SlashCommandLocation | undefined {
	switch (source) {
		case "user":
			return "user";
		case "project":
			return "project";
		case "bundled":
			return undefined;
	}
}


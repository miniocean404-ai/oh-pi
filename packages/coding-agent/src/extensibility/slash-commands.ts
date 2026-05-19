
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { parseFrontmatter, prompt } from "@oh-my-pi/pi-utils";
import { slashCommandCapability } from "../capability/slash-command";
import { appendInlineArgsFallback, templateUsesInlineArgPlaceholders } from "../config/prompt-templates";
import type { SlashCommand } from "../discovery";
import { loadCapability } from "../discovery";
import {
	BUILTIN_SLASH_COMMAND_DEFS,
	type BuiltinSlashCommand,
	type SubcommandDef,
} from "../slash-commands/builtin-registry";
import { EMBEDDED_COMMAND_TEMPLATES } from "../task/commands";
import { parseCommandArgs, substituteArgs } from "../utils/command-args";

/** Slash 命令的来源类型：扩展、prompt 文件或 skill */
export type SlashCommandSource = "extension" | "prompt" | "skill";

/** Slash 命令所属位置：用户级、项目级或 PATH 中 */
export type SlashCommandLocation = "user" | "project" | "path";

/** 用于展示的 slash 命令元信息 */
export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	location?: SlashCommandLocation;
	path?: string;
}

export type { BuiltinSlashCommand, SubcommandDef } from "../slash-commands/builtin-registry";

/**
 * Build getArgumentCompletions from declarative subcommand definitions.
 * Returns subcommand names filtered by prefix in the dropdown.
 *
 * 基于声明式子命令定义构造 getArgumentCompletions：
 * 在下拉框中返回按前缀过滤后的子命令名列表。
 */
function buildArgumentCompletions(subcommands: SubcommandDef[]): (prefix: string) => AutocompleteItem[] | null {
	return (argumentPrefix: string) => {
		if (argumentPrefix.includes(" ")) return null; // past the subcommand 已超过子命令位置
		const lower = argumentPrefix.toLowerCase();
		const matches = subcommands
			.filter(s => s.name.startsWith(lower))
			.map(s => ({
				value: `${s.name} `,
				label: s.name,
				description: s.description,
				hint: s.usage,
			}));
		return matches.length > 0 ? matches : null;
	};
}

/**
 * Build getInlineHint from declarative subcommand definitions.
 * Shows remaining completion + usage as dim ghost text after cursor.
 *
 * 基于声明式子命令定义构造 getInlineHint：
 * 在光标后以暗色 ghost 文本显示剩余补全字符与 usage 提示。
 */
function buildSubcommandInlineHint(subcommands: SubcommandDef[]): (argumentText: string) => string | null {
	return (argumentText: string) => {
		const trimmed = argumentText.trimStart();
		const spaceIndex = trimmed.indexOf(" ");

		if (spaceIndex === -1) {
			// Still typing subcommand name — show remaining chars + usage
			// 仍在输入子命令名称，显示剩余字符 + usage
			const prefix = trimmed.toLowerCase();
			if (prefix.length === 0) return null;
			const match = subcommands.find(s => s.name.startsWith(prefix));
			if (!match) return null;
			const remaining = match.name.slice(prefix.length);
			return remaining + (match.usage ? ` ${match.usage}` : "");
		}

		// Subcommand typed — show remaining usage params
		// 子命令已输入完成，显示剩余的 usage 参数
		const subName = trimmed.slice(0, spaceIndex).toLowerCase();
		const afterSub = trimmed.slice(spaceIndex + 1);
		const sub = subcommands.find(s => s.name === subName);
		if (!sub?.usage) return null;

		if (afterSub.length > 0) {
			const usageParts = sub.usage.split(" ");
			const inputParts = afterSub.trim().split(/\s+/);
			const remaining = usageParts.slice(inputParts.length);
			return remaining.length > 0 ? remaining.join(" ") : null;
		}

		return sub.usage;
	};
}

/**
 * Build getInlineHint for commands with a simple static hint string.
 * Shows the hint only when no arguments have been typed yet.
 *
 * 为只有一段静态提示文本的命令构造 getInlineHint：
 * 仅在尚未输入任何参数时显示提示。
 */
function buildStaticInlineHint(hint: string): (argumentText: string) => string | null {
	return (argumentText: string) => (argumentText.trim().length === 0 ? hint : null);
}

/**
 * Materialized builtin slash commands with completion functions derived from
 * declarative subcommand/hint definitions.
 *
 * 物化后的内置 slash 命令列表：基于声明式子命令/提示定义自动派生
 * 出 completion 与 inline hint 函数。
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<
	BuiltinSlashCommand & {
		getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
		getInlineHint?: (argumentText: string) => string | null;
	}
> = BUILTIN_SLASH_COMMAND_DEFS.map(cmd => {
	if (cmd.subcommands) {
		return {
			...cmd,
			getArgumentCompletions: buildArgumentCompletions(cmd.subcommands),
			getInlineHint: buildSubcommandInlineHint(cmd.subcommands),
		};
	}
	if (cmd.inlineHint) {
		return {
			...cmd,
			getInlineHint: buildStaticInlineHint(cmd.inlineHint),
		};
	}
	return cmd;
});

/**
 * Represents a custom slash command loaded from a file
 *
 * 表示从文件加载的自定义 slash 命令
 */
export interface FileSlashCommand {
	name: string;
	description: string;
	content: string;
	source: string; // e.g., "via Claude Code (User)" 例如 "via Claude Code (User)"
	/**
	 * Source metadata for display
	 * 用于展示的来源元数据
	 */
	_source?: { providerName: string; level: "user" | "project" | "native" };
}

const EMBEDDED_SLASH_COMMANDS = EMBEDDED_COMMAND_TEMPLATES;

/**
 * 解析命令模板文件：取出 frontmatter 与 body，
 * 并优先使用 frontmatter.description，否则截取首行非空内容作为描述。
 */
function parseCommandTemplate(
	content: string,
	options: { source: string; level?: "off" | "warn" | "fatal" },
): { description: string; body: string } {
	const { frontmatter, body } = parseFrontmatter(content, options);
	const frontmatterDesc = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";

	// Get description from frontmatter or first non-empty line
	// description 优先取自 frontmatter，否则使用首行非空内容
	let description = frontmatterDesc;
	if (!description) {
		const firstLine = body.split("\n").find(line => line.trim());
		if (firstLine) {
			description = firstLine.slice(0, 60);
			if (firstLine.length > 60) description += "...";
		}
	}

	return { description, body };
}

/** loadSlashCommands 的参数 */
export interface LoadSlashCommandsOptions {
	/**
	 * Working directory for project-local commands. Default: getProjectDir()
	 * 项目级命令的工作目录，默认 getProjectDir()
	 */
	cwd?: string;
}

/**
 * Load all custom slash commands using the capability API.
 * Loads from all registered providers (builtin, user, project).
 *
 * 使用 capability API 加载全部自定义 slash 命令，
 * 来源覆盖所有已注册的 provider（builtin / user / project）。
 */
export async function loadSlashCommands(options: LoadSlashCommandsOptions = {}): Promise<FileSlashCommand[]> {
	const result = await loadCapability<SlashCommand>(slashCommandCapability.id, { cwd: options.cwd });

	const fileCommands: FileSlashCommand[] = result.items.map(cmd => {
		const { description, body } = parseCommandTemplate(cmd.content, {
			source: cmd.path ?? `slash-command:${cmd.name}`,
			level: cmd.level === "native" ? "fatal" : "warn",
		});

		// Format source label: "via ProviderName Level"
		// 拼出展示用的来源标签："via ProviderName Level"
		const capitalizedLevel = cmd.level.charAt(0).toUpperCase() + cmd.level.slice(1);
		const sourceStr = `via ${cmd._source.providerName} ${capitalizedLevel}`;

		return {
			name: cmd.name,
			description,
			content: body,
			source: sourceStr,
			_source: { providerName: cmd._source.providerName, level: cmd.level },
		};
	});

	const seenNames = new Set(fileCommands.map(cmd => cmd.name));
	for (const cmd of EMBEDDED_SLASH_COMMANDS) {
		const name = cmd.name.replace(/\.md$/, "");
		if (seenNames.has(name)) continue;

		const { description, body } = parseCommandTemplate(cmd.content, {
			source: `embedded:${cmd.name}`,
			level: "fatal",
		});
		fileCommands.push({
			name,
			description,
			content: body,
			source: "bundled",
		});
		seenNames.add(name);
	}

	return fileCommands;
}

/**
 * Expand a slash command if it matches a file-based command.
 * Returns the expanded content or the original text if not a slash command.
 *
 * 若输入文本匹配某个文件 slash 命令，则展开其内容并替换参数占位符；
 * 否则原样返回输入文本。
 */
export function expandSlashCommand(text: string, fileCommands: FileSlashCommand[]): string {
	if (!text.startsWith("/")) return text;

	const spaceIndex = text.indexOf(" ");
	const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

	const fileCommand = fileCommands.find(cmd => cmd.name === commandName);
	if (fileCommand) {
		const args = parseCommandArgs(argsString);
		const argsText = args.join(" ");
		const usesInlineArgPlaceholders = templateUsesInlineArgPlaceholders(fileCommand.content);
		const substituted = substituteArgs(fileCommand.content, args);
		const rendered = prompt.render(substituted, { args, ARGUMENTS: argsText, arguments: argsText });
		return appendInlineArgsFallback(rendered, argsText, usesInlineArgPlaceholders);
	}

	return text;
}


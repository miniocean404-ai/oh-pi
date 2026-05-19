
/**
 * Rules Capability
 * 规则能力
 *
 * Project-specific rules from Cursor (.mdc), Windsurf (.md), and Cline formats.
 * Translated to a canonical shape regardless of source format.
 * 来自 Cursor（.mdc）、Windsurf（.md）和 Cline 格式的项目特定规则。
 * 无论来源格式如何，均转换为标准结构。
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/** 条件 glob 作用域适用的工具列表 */
const CONDITION_GLOB_SCOPE_TOOLS = ["edit", "write"] as const;

/**
 * Parsed frontmatter from rule files.
 * 从规则文件解析的前置元数据。
 */
export interface RuleFrontmatter {
	/** 规则描述 */
	description?: string;
	/** 适用的文件 glob 模式 */
	globs?: string[];
	/** 是否始终应用 */
	alwaysApply?: boolean;
	/** New key for TTSR match conditions. */
	/** TTSR 匹配条件的新键 */
	condition?: string | string[];
	/** New key for TTSR stream scope. */
	/** TTSR 流作用域的新键 */
	scope?: string | string[];
	/** Per-rule TTSR interrupt mode override. */
	/** 每条规则的 TTSR 中断模式覆盖 */
	interruptMode?: "never" | "prose-only" | "tool-only" | "always";
	[key: string]: unknown;
}

/**
 * A rule providing project-specific guidance and constraints.
 * 提供项目特定指导和约束的规则。
 */
export interface Rule {
	/** Rule name (derived from filename) */
	/** 规则名称（从文件名派生） */
	name: string;
	/** Absolute path to rule file */
	/** 规则文件的绝对路径 */
	path: string;
	/** Rule content (after frontmatter stripped) */
	/** 规则内容（去除前置元数据后） */
	content: string;
	/** Globs this rule applies to (if any) */
	/** 此规则适用的 glob 模式（如有） */
	globs?: string[];
	/** Whether to always include this rule */
	/** 是否始终包含此规则 */
	alwaysApply?: boolean;
	/** Description (for agent-requested rules) */
	/** 描述（用于代理请求的规则） */
	description?: string;
	/** Regex condition(s) that can trigger TTSR interruption. */
	/** 可触发 TTSR 中断的正则条件 */
	condition?: string[];
	/** Optional stream scope tokens (for example: text, thinking, tool:edit(*.ts)). */
	/** 可选的流作用域标记（如：text、thinking、tool:edit(*.ts)） */
	scope?: string[];
	/** Per-rule TTSR interrupt mode override (falls back to global ttsr.interruptMode). */
	/** 每条规则的 TTSR 中断模式覆盖（回退到全局 ttsr.interruptMode） */
	interruptMode?: "never" | "prose-only" | "tool-only" | "always";
	/** Source metadata */
	/** 来源元数据 */
	_source: SourceMeta;
}

/** 将规则字段值标准化为字符串数组，去重并过滤空值 */
function normalizeRuleField(value: unknown): string[] | undefined {
	if (typeof value === "string") {
		const token = value.trim();
		return token.length > 0 ? [token] : undefined;
	}
	if (!Array.isArray(value)) {
		return undefined;
	}

	const tokens = value
		.filter((item): item is string => typeof item === "string")
		.map(item => item.trim())
		.filter(item => item.length > 0);
	if (tokens.length === 0) {
		return undefined;
	}

	return Array.from(new Set(tokens));
}

/**
 * 按逗号分割作用域标记，同时尊重括号和引号的嵌套层级。
 * 例如 "tool:edit(*.ts), text" 会被拆分为 ["tool:edit(*.ts)", "text"]。
 */
function splitScopeTokens(value: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let parenDepth = 0; // 圆括号深度
	let bracketDepth = 0; // 方括号深度
	let braceDepth = 0; // 花括号深度
	let quote: '"' | "'" | undefined; // 当前引号状态
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (quote) {
			current += char;
			if (char === quote && value[i - 1] !== "\\") {
				quote = undefined;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === "(") {
			parenDepth++;
			current += char;
			continue;
		}
		if (char === ")") {
			parenDepth = Math.max(0, parenDepth - 1);
			current += char;
			continue;
		}
		if (char === "[") {
			bracketDepth++;
			current += char;
			continue;
		}
		if (char === "]") {
			bracketDepth = Math.max(0, bracketDepth - 1);
			current += char;
			continue;
		}
		if (char === "{") {
			braceDepth++;
			current += char;
			continue;
		}
		if (char === "}") {
			braceDepth = Math.max(0, braceDepth - 1);
			current += char;
			continue;
		}
		if (char === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
			const token = current.trim();
			if (token.length > 0) {
				tokens.push(token);
			}
			current = "";
			continue;
		}
		current += char;
	}

	const tail = current.trim();
	if (tail.length > 0) {
		tokens.push(tail);
	}

	return tokens;
}
/** 标准化作用域字段，展开逗号分隔的标记并去重 */
function normalizeScopeField(value: unknown): string[] | undefined {
	const normalized = normalizeRuleField(value);
	if (!normalized) {
		return undefined;
	}

	const tokens = normalized.flatMap(splitScopeTokens).filter(item => item.length > 0);
	if (tokens.length === 0) {
		return undefined;
	}
	return Array.from(new Set(tokens));
}
/**
 * Heuristic for condition shorthand that looks like a file glob (for example `*.rs`).
 * 启发式判断条件简写是否看起来像文件 glob 模式（例如 `*.rs`）。
 */
function isLikelyFileGlob(value: string): boolean {
	const token = value.trim();
	if (token.length === 0) {
		return false;
	}
	if (/[\\^$+|()]/.test(token)) {
		return false;
	}
	if (!/[?*[\]{}]/.test(token)) {
		return false;
	}
	if (token.includes("/")) {
		return true;
	}
	return /^\*\.[^\s/]+$/.test(token);
}

/**
 * Parse `condition` + `scope` from rule frontmatter.
 * 从规则前置元数据中解析 `condition` 和 `scope`。
 *
 * - `condition` accepts string or string[]
 * - `condition` 接受字符串或字符串数组
 * - `scope` accepts string or string[]
 * - `scope` 接受字符串或字符串数组
 * - legacy `ttsr_trigger` / `ttsrTrigger` are accepted as a `condition` fallback
 * - 遗留的 `ttsr_trigger` / `ttsrTrigger` 作为 `condition` 的回退
 * - condition tokens that look like file globs become scope shorthands:
 *   `*.rs` => `tool:edit(*.rs)`, `tool:write(*.rs)` and a catch-all condition `.*`
 * - 看起来像文件 glob 的条件标记会转换为作用域简写：
 *   `*.rs` => `tool:edit(*.rs)`, `tool:write(*.rs)` 并添加通配条件 `.*`
 */
export function parseRuleConditionAndScope(frontmatter: RuleFrontmatter): Pick<Rule, "condition" | "scope"> {
	const rawCondition = frontmatter.condition ?? frontmatter.ttsr_trigger ?? frontmatter.ttsrTrigger;
	const parsedCondition = normalizeRuleField(rawCondition);
	const parsedScope = normalizeScopeField(frontmatter.scope);

	const inferredScope: string[] = [];
	const condition: string[] = [];
	for (const token of parsedCondition ?? []) {
		if (isLikelyFileGlob(token)) {
			for (const toolName of CONDITION_GLOB_SCOPE_TOOLS) {
				inferredScope.push(`tool:${toolName}(${token})`);
			}
			continue;
		}
		condition.push(token);
	}

	if (condition.length === 0 && inferredScope.length > 0) {
		condition.push(".*");
	}

	const scope = [...(parsedScope ?? []), ...inferredScope];
	return {
		condition: condition.length > 0 ? Array.from(new Set(condition)) : undefined,
		scope: scope.length > 0 ? Array.from(new Set(scope)) : undefined,
	};
}

/** 当前活动规则的快照 */
let activeRules: readonly Rule[] = [];

/**
 * Process-global snapshot of rules the active session loaded.
 * Read by internal URL protocol handlers (rule://).
 * 进程全局的规则快照，由活动会话加载。
 * 由内部 URL 协议处理器（rule://）读取。
 */
export function getActiveRules(): readonly Rule[] {
	return activeRules;
}

/** Replace the active rule snapshot. Called once per top-level session. */
/** 替换活动规则快照。每个顶层会话调用一次。 */
export function setActiveRules(value: readonly Rule[]): void {
	activeRules = value;
}

/** Reset the active rule snapshot. Test-only. */
/** 重置活动规则快照。仅用于测试。 */
export function resetActiveRulesForTests(): void {
	activeRules = [];
}

/** 规则能力定义 */
export const ruleCapability = defineCapability<Rule>({
	id: "rules",
	displayName: "Rules",
	description: "Project-specific rules and constraints (Cursor MDC, Windsurf, Cline formats)",
	key: rule => rule.name,
	toExtensionId: rule => `rule:${rule.name}`,
	validate: rule => {
		if (!rule.name) return "Missing rule name";
		if (!rule.path) return "Missing rule path";
		if (!rule.content || typeof rule.content !== "string") return "Rule must have content";
		return undefined;
	},
});


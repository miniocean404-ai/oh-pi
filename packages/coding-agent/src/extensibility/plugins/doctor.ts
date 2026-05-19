
import { $which } from "@oh-my-pi/pi-utils";
import { theme } from "../../modes/theme/theme";
import type { DoctorCheck } from "./types";

/**
 * 运行系统级健康检查：检测外部命令行工具与常用 API Key 是否就绪。
 */
export async function runDoctorChecks(): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];

	// Check external tools
	// 检查依赖的外部命令行工具是否已安装
	const tools = [
		{ name: "sd", description: "Find-replace" },
		{ name: "sg", description: "AST-grep" },
		{ name: "git", description: "Version control" },
	];

	for (const tool of tools) {
		const path = $which(tool.name);
		checks.push({
			name: tool.name,
			status: path ? "ok" : "warning",
			message: path ? `Found at ${path}` : `${tool.description} not found - some features may be limited`,
		});
	}

	// Check API keys
	// 检查常用 LLM / 搜索服务的 API Key 是否已配置
	const apiKeys = [
		{ name: "ANTHROPIC_API_KEY", description: "Anthropic API" },
		{ name: "OPENAI_API_KEY", description: "OpenAI API" },
		{ name: "PERPLEXITY_API_KEY", description: "Perplexity search" },
		{ name: "EXA_API_KEY", description: "Exa search" },
	];

	for (const key of apiKeys) {
		const hasKey = !!Bun.env[key.name];
		checks.push({
			name: key.name,
			status: hasKey ? "ok" : "warning",
			message: hasKey ? "Configured" : `Not set - ${key.description} unavailable`,
		});
	}

	return checks;
}

/**
 * 将 doctor 检查结果格式化为可阅读的纯文本汇总。
 */
export function formatDoctorResults(checks: DoctorCheck[]): string {
	// Note: This function returns plain text without theming as it may be called outside TUI context.
	// For TUI usage, the plugin CLI handler applies theme colors.
	// 注意：此处返回纯文本，不带主题色；TUI 场景下由插件 CLI handler 自行染色
	const lines: string[] = ["System Health Check", "=".repeat(40), ""];

	for (const check of checks) {
		const icon =
			check.status === "ok"
				? theme.status.success
				: check.status === "warning"
					? theme.status.warning
					: theme.status.error;
		lines.push(`${icon} ${check.name}: ${check.message}`);
	}

	const errors = checks.filter(c => c.status === "error").length;
	const warnings = checks.filter(c => c.status === "warning").length;

	lines.push("");
	lines.push(`Summary: ${checks.length - errors - warnings} ok, ${warnings} warnings, ${errors} errors`);

	return lines.join("\n");
}


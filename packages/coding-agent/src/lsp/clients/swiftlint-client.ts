
/**
 * SwiftLint CLI-based linter client.
 * Parses SwiftLint's JSON reporter output into LSP Diagnostic format.
 * 基于 SwiftLint CLI 的代码检查客户端，将 JSON reporter 输出解析为 LSP Diagnostic 格式。
 */
import type { Diagnostic, DiagnosticSeverity, LinterClient, ServerConfig } from "../../lsp/types";

/** Shape of a single violation from `swiftlint lint --reporter json`. */
/** `swiftlint lint --reporter json` 输出的单条违规记录结构 */
interface SwiftLintViolation {
	character: number;
	file: string;
	line: number;
	reason: string;
	rule_id: string;
	severity: "Error" | "Warning";
	type: string;
}

/** 将 SwiftLint 严重级别转换为 LSP DiagnosticSeverity */
function parseSeverity(severity: string): DiagnosticSeverity {
	switch (severity) {
		case "Error":
			return 1;
		case "Warning":
			return 2;
		default:
			return 2;
	}
}

/** 运行 SwiftLint CLI 命令 */
async function runSwiftLint(
	args: string[],
	cwd: string,
	resolvedCommand?: string,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
	const command = resolvedCommand ?? "swiftlint";

	try {
		const proc = Bun.spawn([command, ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});

		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		await proc.exited;

		// swiftlint 发现违规时以非零退出码退出——这不算失败
		return { stdout, stderr, success: stdout.length > 0 };
	} catch (err) {
		return { stdout: "", stderr: String(err), success: false };
	}
}

/**
 * SwiftLint CLI-based linter client.
 * Runs `swiftlint lint --reporter json` and converts violations to LSP diagnostics.
 * 基于 SwiftLint CLI 的代码检查客户端，运行 `swiftlint lint --reporter json` 并转换为 LSP 诊断信息。
 */
export class SwiftLintClient implements LinterClient {
	/** Factory method for creating SwiftLintClient instances */
	/** 创建 SwiftLintClient 实例的工厂方法 */
	static create(config: ServerConfig, cwd: string): LinterClient {
		return new SwiftLintClient(config, cwd);
	}

	constructor(
		private readonly config: ServerConfig,
		private readonly cwd: string,
	) {}

	/** 格式化文件内容（SwiftLint 不支持格式化） */
	async format(_filePath: string, content: string): Promise<string> {
		// SwiftLint 不支持格式化
		return content;
	}

	/** 对文件进行代码检查 */
	async lint(filePath: string): Promise<Diagnostic[]> {
		const result = await runSwiftLint(
			["lint", "--quiet", "--reporter", "json", filePath],
			this.cwd,
			this.config.resolvedCommand,
		);

		if (!result.success) {
			return [];
		}

		return this.#parseJsonOutput(result.stdout);
	}

	/** 将 SwiftLint 的 JSON 输出解析为 LSP 诊断信息 */
	#parseJsonOutput(jsonOutput: string): Diagnostic[] {
		const diagnostics: Diagnostic[] = [];

		try {
			const violations: SwiftLintViolation[] = JSON.parse(jsonOutput);

			for (const v of violations) {
				// SwiftLint 行号/列号从 1 开始；LSP 从 0 开始
				const line = Math.max(0, v.line - 1);
				const character = Math.max(0, v.character - 1);

				diagnostics.push({
					range: {
						start: { line, character },
						end: { line, character },
					},
					severity: parseSeverity(v.severity),
					message: v.reason,
					source: "swiftlint",
					code: v.rule_id,
				});
			}
		} catch {
			// JSON parse failed, return empty
		}

		return diagnostics;
	}

	/** 释放资源（CLI 客户端无需释放） */
	dispose(): void {
		// CLI 客户端无需释放资源
	}
}


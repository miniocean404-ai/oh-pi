
/**
 * Biome CLI-based linter client.
 * Uses Biome's CLI with JSON output instead of LSP (which has stale diagnostics issues).
 * 基于 Biome CLI 的代码检查客户端，使用 JSON 输出而非 LSP（LSP 存在诊断信息过期问题）。
 */
import path from "node:path";
import type { Diagnostic, DiagnosticSeverity, LinterClient, ServerConfig } from "../../lsp/types";

// =============================================================================
// Biome JSON 输出类型
// =============================================================================

/** Biome JSON 输出结构 */
interface BiomeJsonOutput {
	diagnostics: BiomeDiagnostic[];
}

/** Biome 诊断信息 */
interface BiomeDiagnostic {
	category: string; // e.g., "lint/correctness/noUnusedVariables"
	severity: "error" | "warning" | "info" | "hint";
	description: string;
	location?: {
		path?: { file: string };
		span?: [number, number]; // [startOffset, endOffset] in bytes
		sourceCode?: string;
	};
}

// =============================================================================
// 辅助函数
// =============================================================================

/**
 * Convert byte offset to line:column using source code.
 * 使用源代码将字节偏移转换为行:列
 */
function offsetToPosition(source: string, offset: number): { line: number; column: number } {
	let line = 1;
	let column = 1;
	let byteIndex = 0;

	for (const ch of source) {
		const byteLen = Buffer.byteLength(ch);
		if (byteIndex + byteLen > offset) {
			break;
		}
		if (ch === "\n") {
			line++;
			column = 1;
		} else {
			column++;
		}
		byteIndex += byteLen;
	}

	return { line, column };
}

/**
 * Parse Biome severity to LSP DiagnosticSeverity.
 * 将 Biome 严重级别转换为 LSP DiagnosticSeverity
 */
function parseSeverity(severity: string): DiagnosticSeverity {
	switch (severity) {
		case "error":
			return 1;
		case "warning":
			return 2;
		case "info":
			return 3;
		case "hint":
			return 4;
		default:
			return 2;
	}
}

/**
 * Run a Biome CLI command.
 * 运行 Biome CLI 命令
 */
async function runBiome(
	args: string[],
	cwd: string,
	resolvedCommand?: string,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
	const command = resolvedCommand ?? "biome";

	try {
		const proc = Bun.spawn([command, ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});

		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;

		return { stdout, stderr, success: exitCode === 0 };
	} catch (err) {
		return { stdout: "", stderr: String(err), success: false };
	}
}

// =============================================================================
// Biome 客户端
// =============================================================================

/**
 * Biome CLI-based linter client.
 * Parses Biome's --reporter=json output into LSP Diagnostic format.
 * 基于 Biome CLI 的代码检查客户端，将 --reporter=json 输出解析为 LSP Diagnostic 格式。
 */
export class BiomeClient implements LinterClient {
	/** Factory method for creating BiomeClient instances */
	/** 创建 BiomeClient 实例的工厂方法 */
	static create(config: ServerConfig, cwd: string): LinterClient {
		return new BiomeClient(config, cwd);
	}

	constructor(
		private readonly config: ServerConfig,
		private readonly cwd: string,
	) {}

	/** 格式化文件内容 */
	async format(filePath: string, content: string): Promise<string> {
		// 先将内容写入文件
		await Bun.write(filePath, content);

		// 运行 biome format --write
		const result = await runBiome(["format", "--write", filePath], this.cwd, this.config.resolvedCommand);

		if (result.success) {
			// 读回格式化后的内容
			return await Bun.file(filePath).text();
		}

		// 格式化失败，返回原内容
		return content;
	}

	/** 对文件进行代码检查 */
	async lint(filePath: string): Promise<Diagnostic[]> {
		// 使用 JSON reporter 运行 biome lint
		const result = await runBiome(["lint", "--reporter=json", filePath], this.cwd, this.config.resolvedCommand);

		return this.#parseJsonOutput(result.stdout, filePath);
	}

	/**
	 * Parse Biome's JSON output into LSP Diagnostics.
	 * 将 Biome 的 JSON 输出解析为 LSP 诊断信息
	 */
	#parseJsonOutput(jsonOutput: string, targetFile: string): Diagnostic[] {
		const diagnostics: Diagnostic[] = [];

		try {
			const parsed: BiomeJsonOutput = JSON.parse(jsonOutput);

			for (const diag of parsed.diagnostics) {
				const location = diag.location;
				if (!location?.path?.file) continue;

				// 解析文件路径
				const diagFile = path.isAbsolute(location.path.file)
					? location.path.file
					: path.join(this.cwd, location.path.file);

				// 仅包含目标文件的诊断信息
				if (path.resolve(diagFile) !== path.resolve(targetFile)) {
					continue;
				}

				// 将字节偏移转换为行:列
				let startLine = 1;
				let startColumn = 1;
				let endLine = 1;
				let endColumn = 1;

				if (location.span && location.sourceCode) {
					const startPos = offsetToPosition(location.sourceCode, location.span[0]);
					const endPos = offsetToPosition(location.sourceCode, location.span[1]);
					startLine = startPos.line;
					startColumn = startPos.column;
					endLine = endPos.line;
					endColumn = endPos.column;
				}

				diagnostics.push({
					range: {
						start: { line: startLine - 1, character: startColumn - 1 },
						end: { line: endLine - 1, character: endColumn - 1 },
					},
					severity: parseSeverity(diag.severity),
					message: diag.description,
					source: "biome",
					code: diag.category,
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


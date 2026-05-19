
/**
 * LSP-based linter client.
 * Uses the Language Server Protocol for formatting and diagnostics.
 * 基于 LSP 的代码检查客户端，使用 LSP 协议进行格式化和诊断。
 */
import { getOrCreateClient, notifySaved, sendRequest, syncContent } from "../../lsp/client";
import { applyTextEditsToString } from "../../lsp/edits";
import type { Diagnostic, LinterClient, LspClient, ServerConfig, TextEdit } from "../../lsp/types";
import { fileToUri } from "../../lsp/utils";

/** Default formatting options for LSP */
/** LSP 默认格式化选项 */
const DEFAULT_FORMAT_OPTIONS = {
	tabSize: 3,
	insertSpaces: true,
	trimTrailingWhitespace: true,
	insertFinalNewline: true,
	trimFinalNewlines: true,
};

/**
 * LSP-based linter client implementation.
 * Wraps the existing LSP client infrastructure.
 * 基于 LSP 的代码检查客户端实现，封装现有 LSP 客户端基础设施。
 */
export class LspLinterClient implements LinterClient {
	#client: LspClient | null = null;

	/** Factory method for creating LspLinterClient instances */
	/** 创建 LspLinterClient 实例的工厂方法 */
	static create(config: ServerConfig, cwd: string): LinterClient {
		return new LspLinterClient(config, cwd);
	}

	constructor(
		private readonly config: ServerConfig,
		private readonly cwd: string,
	) {}

	/** 获取或创建 LSP 客户端 */
	async #getClient(): Promise<LspClient> {
		if (!this.#client) {
			this.#client = await getOrCreateClient(this.config, this.cwd);
		}
		return this.#client;
	}

	/** 通过 LSP 格式化文件内容 */
	async format(filePath: string, content: string): Promise<string> {
		const client = await this.#getClient();
		const uri = fileToUri(filePath);

		// 同步内容到 LSP
		await syncContent(client, filePath, content);

		// 检查服务器是否支持格式化
		const caps = client.serverCapabilities;
		if (!caps?.documentFormattingProvider) {
			return content;
		}

		// 请求格式化
		const edits = (await sendRequest(client, "textDocument/formatting", {
			textDocument: { uri },
			options: DEFAULT_FORMAT_OPTIONS,
		})) as TextEdit[] | null;

		if (!edits || edits.length === 0) {
			return content;
		}

		return applyTextEditsToString(content, edits);
	}

	/** 通过 LSP 获取诊断信息 */
	async lint(filePath: string): Promise<Diagnostic[]> {
		const client = await this.#getClient();
		const uri = fileToUri(filePath);

		// 通知文件已保存以触发诊断
		await notifySaved(client, filePath);

		// 带超时等待诊断结果
		const timeoutMs = 3000;
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const publishedDiagnostics = client.diagnostics.get(uri);
			if (publishedDiagnostics !== undefined) {
				return publishedDiagnostics.diagnostics;
			}
			await Bun.sleep(100);
		}

		return client.diagnostics.get(uri)?.diagnostics ?? [];
	}

	dispose(): void {
		// Client lifecycle is managed globally, nothing to dispose here
	}
}


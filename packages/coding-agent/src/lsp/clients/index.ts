
import type { LinterClient, ServerConfig } from "../../lsp/types";
import { LspLinterClient } from "./lsp-linter-client";

/**
 * Linter client implementations.
 *
 * The LinterClient interface provides a common API for formatters and linters.
 * Different implementations can use LSP protocol, CLI tools, or other mechanisms.
 *
 * 代码检查客户端实现。LinterClient 接口为格式化器和检查器提供统一 API，
 * 不同实现可使用 LSP 协议、CLI 工具或其他机制。
 */

export { BiomeClient } from "./biome-client";
export { LspLinterClient } from "./lsp-linter-client";
export { SwiftLintClient } from "./swiftlint-client";

// 按服务器名称 + 工作目录缓存代码检查客户端
const clientCache = new Map<string, LinterClient>();

/**
 * Get or create a linter client for a server configuration.
 * Uses the server's custom factory if provided, otherwise falls back to LSP.
 * 获取或创建代码检查客户端。优先使用自定义工厂，否则回退到 LSP。
 */
export function getLinterClient(serverName: string, config: ServerConfig, cwd: string): LinterClient {
	const key = `${serverName}:${cwd}`;

	let client = clientCache.get(key);
	if (client) {
		return client;
	}

	// 如果提供了自定义工厂则使用
	if (config.createClient) {
		client = config.createClient(config, cwd);
	} else {
		// 默认使用 LSP
		client = LspLinterClient.create(config, cwd);
	}

	clientCache.set(key, client);
	return client;
}

/**
 * Clear all cached linter clients.
 * 清除所有缓存的代码检查客户端
 */
export function clearLinterClientCache(): void {
	for (const client of clientCache.values()) {
		client.dispose?.();
	}
	clientCache.clear();
}


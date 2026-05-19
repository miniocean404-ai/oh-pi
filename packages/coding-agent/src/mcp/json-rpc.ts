
/**
 * MCP JSON-RPC 2.0 over HTTPS.
 * 基于 HTTPS 的 MCP JSON-RPC 2.0。
 *
 * Lightweight utilities for calling MCP servers directly via HTTP
 * without maintaining persistent connections.
 * 用于通过 HTTP 直接调用 MCP 服务器的轻量级工具，无需维护持久连接。
 */
import { logger } from "@oh-my-pi/pi-utils";

/** Parse SSE response format (lines starting with "data: ") */
/** 解析 SSE 响应格式（以 "data: " 开头的行） */
export function parseSSE(text: string): unknown {
	const lines = text.split("\n");
	for (const line of lines) {
		if (line.startsWith("data: ")) {
			const data = line.slice(6).trim();
			if (data === "[DONE]") continue;
			const result = JSON.parse(data) as unknown;
			if (result) return result;
		}
	}
	// 回退：尝试将整个响应解析为 JSON
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** JSON-RPC 2.0 response structure */
/** JSON-RPC 2.0 响应结构 */
export interface JsonRpcResponse<T = unknown> {
	jsonrpc: "2.0";
	id: string | number;
	result?: T;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

/**
 * Call an MCP server with JSON-RPC 2.0 over HTTPS.
 * 通过 HTTPS 使用 JSON-RPC 2.0 调用 MCP 服务器。
 *
 * @param url - Full MCP server URL (including any query parameters) 完整的 MCP 服务器 URL（包含查询参数）
 * @param method - JSON-RPC method name (e.g., "tools/list", "tools/call") JSON-RPC 方法名称
 * @param params - Method parameters 方法参数
 * @returns Parsed JSON-RPC response 解析后的 JSON-RPC 响应
 */
export async function callMCP<T = unknown>(
	url: string,
	method: string,
	params?: Record<string, unknown>,
): Promise<JsonRpcResponse<T>> {
	const body = {
		jsonrpc: "2.0",
		id: Math.random().toString(36).slice(2),
		method,
		params: params ?? {},
	};

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const errorMsg = `MCP request failed: ${response.status} ${response.statusText}`;
		logger.error(errorMsg, { url, method, params });
		throw new Error(errorMsg);
	}

	const text = await response.text();
	const result = parseSSE(text) as JsonRpcResponse<T> | null;

	if (!result) {
		logger.error("Failed to parse MCP response", { url, method, responseText: text.slice(0, 500) });
		throw new Error("Failed to parse MCP response");
	}

	return result;
}


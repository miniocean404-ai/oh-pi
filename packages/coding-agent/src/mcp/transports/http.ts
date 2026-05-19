
/**
 * MCP HTTP transport (Streamable HTTP).
 * MCP HTTP 传输（流式 HTTP）。
 *
 * Implements JSON-RPC 2.0 over HTTP POST with optional SSE streaming.
 * Based on MCP spec 2025-03-26.
 * 基于 HTTP POST 实现 JSON-RPC 2.0，支持可选的 SSE 流式响应。
 * 基于 MCP 规范 2025-03-26。
 */
import { logger, readSseJson, Snowflake } from "@oh-my-pi/pi-utils";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPHttpServerConfig,
	MCPRequestOptions,
	MCPSseServerConfig,
	MCPTransport,
} from "../../mcp/types";
import { toJsonRpcError } from "../../mcp/types";

/**
 * HTTP transport for MCP servers.
 * Uses POST for requests, supports SSE responses.
 * MCP 服务器的 HTTP 传输实现。
 * 使用 POST 发送请求，支持 SSE 响应。
 */
export class HttpTransport implements MCPTransport {
	/** 是否已连接 */
	#connected = false;
	/** 会话 ID */
	#sessionId: string | null = null;
	/** SSE 连接的中止控制器 */
	#sseConnection: AbortController | null = null;

	/** 连接关闭回调 */
	onClose?: () => void;
	/** 错误回调 */
	onError?: (error: Error) => void;
	/** 通知回调 */
	onNotification?: (method: string, params: unknown) => void;
	/** 服务器请求回调 */
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
	/** Called on 401/403 to attempt token refresh. Returns updated headers or null. */
	/** 在 401/403 时调用以尝试刷新令牌。返回更新后的请求头或 null。 */
	onAuthError?: () => Promise<Record<string, string> | null>;

	constructor(private config: MCPHttpServerConfig | MCPSseServerConfig) {}

	get connected(): boolean {
		return this.#connected;
	}

	get url(): string {
		return this.config.url;
	}

	/**
	 * Mark transport as connected.
	 * HTTP doesn't need persistent connection, but we track state.
	 * 标记传输为已连接。HTTP 不需要持久连接，但我们追踪状态。
	 */
	async connect(): Promise<void> {
		if (this.#connected) return;
		this.#connected = true;
	}

	/**
	 * Start SSE listener for server-initiated messages.
	 * Resolves once the SSE connection is established (or fails/unsupported).
	 * Message reading continues in the background.
	 * 启动 SSE 监听器接收服务器主动推送的消息。
	 * SSE 连接建立（或失败/不支持）后 resolve。消息读取在后台持续进行。
	 */
	async startSSEListener(): Promise<void> {
		if (!this.#connected) return;
		if (this.#sseConnection) return;

		this.#sseConnection = new AbortController();
		const headers: Record<string, string> = {
			Accept: "text/event-stream",
			...this.config.headers,
		};

		if (this.#sessionId) {
			headers["Mcp-Session-Id"] = this.#sessionId;
		}

		let response: Response;
		try {
			response = await fetch(this.config.url, {
				method: "GET",
				headers,
				signal: this.#sseConnection.signal,
			});
		} catch (error) {
			this.#sseConnection = null;
			if (error instanceof Error && error.name !== "AbortError") {
				this.onError?.(error);
			}
			return;
		}

		if (response.status === 405 || !response.ok || !response.body) {
			this.#sseConnection = null;
			return;
		}

		// 连接已建立 — 在后台读取消息。
		// 如果流意外结束（服务器重启、网络中断），
		// 触发 onClose 以便管理器发起重连。
		const signal = this.#sseConnection.signal;
		void this.#readSSEStream(response.body!, signal).finally(() => {
			const wasConnected = this.#connected;
			this.#sseConnection = null;
			if (wasConnected) this.onClose?.();
		});
	}
	/** 读取 SSE 流并分发消息 */
	async #readSSEStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
		try {
			for await (const message of readSseJson<JsonRpcMessage>(body, signal)) {
				if (!this.#connected) break;
				this.#dispatchSSEMessage(message);
			}
		} catch (error) {
			if (error instanceof Error && error.name !== "AbortError") {
				logger.debug("HTTP SSE stream error", { url: this.config.url, error: error.message });
				this.onError?.(error);
			}
		}
	}

	/** Route an SSE message (or batch) to the appropriate handler. */
	/** 将 SSE 消息（或批量消息）路由到对应的处理器。 */
	#dispatchSSEMessage(message: JsonRpcMessage | JsonRpcMessage[]): void {
		if (Array.isArray(message)) {
			for (const m of message) this.#dispatchSSEMessage(m);
			return;
		}
		// 服务器到客户端的请求：同时包含 method 和 id
		if ("method" in message && "id" in message && message.id != null) {
			void this.#handleServerRequest(message as JsonRpcRequest);
			return;
		}
		// 通知：有 method 但无 id
		if ("method" in message && !("id" in message)) {
			this.onNotification?.(message.method, message.params);
		}
	}

	/** 发送 JSON-RPC 请求，认证失败时自动重试一次 */
	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		try {
			return await this.#executeRequest<T>(method, params, options);
		} catch (error) {
			// 认证失败时重试一次（若已注册 onAuthError）
			if (this.onAuthError && error instanceof Error && /^HTTP (401|403):/.test(error.message)) {
				const newHeaders = await this.onAuthError();
				if (newHeaders) {
					// 持久化刷新后的请求头，使后续请求直接使用
					this.config = { ...this.config, headers: newHeaders };
					return this.#executeRequest<T>(method, params, options);
				}
			}
			throw error;
		}
	}

	/** 执行实际的 HTTP JSON-RPC 请求 */
	async #executeRequest<T>(
		method: string,
		params: Record<string, unknown> | undefined,
		options: MCPRequestOptions | undefined,
	): Promise<T> {
		if (!this.#connected) {
			throw new Error("Transport not connected");
		}

		const id = Snowflake.next();
		const body = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.config.headers,
		};

		if (this.#sessionId) {
			headers["Mcp-Session-Id"] = this.#sessionId;
		}

		// 创建超时中止控制器
		const timeout = this.config.timeout ?? 30000;
		const abortController = new AbortController();
		const timeoutId = setTimeout(() => abortController.abort(), timeout);
		const operationSignal = options?.signal
			? AbortSignal.any([options.signal, abortController.signal])
			: abortController.signal;

		try {
			const response = await fetch(this.config.url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: operationSignal,
			});

			clearTimeout(timeoutId);

			// 检查响应中的会话 ID
			const newSessionId = response.headers.get("Mcp-Session-Id");
			if (newSessionId) {
				this.#sessionId = newSessionId;
			}

			if (!response.ok) {
				const text = await response.text();
				const wwwAuthenticate = response.headers.get("WWW-Authenticate");
				const mcpAuthServer = response.headers.get("Mcp-Auth-Server");
				const authHints = [
					wwwAuthenticate ? `WWW-Authenticate: ${wwwAuthenticate}` : null,
					mcpAuthServer ? `Mcp-Auth-Server: ${mcpAuthServer}` : null,
				]
					.filter(Boolean)
					.join("; ");
				const suffix = authHints ? ` [${authHints}]` : "";
				throw new Error(`HTTP ${response.status}: ${text}${suffix}`);
			}

			const contentType = response.headers.get("Content-Type") ?? "";

			// 处理 SSE 响应
			if (contentType.includes("text/event-stream")) {
				return this.#parseSSEResponse<T>(response, id, options);
			}

			// 处理 JSON 响应
			const result = (await response.json()) as JsonRpcResponse;

			if (result.error) {
				throw new Error(`MCP error ${result.error.code}: ${result.error.message}`);
			}

			return result.result as T;
		} catch (error) {
			clearTimeout(timeoutId);
			if (error instanceof Error && error.name === "AbortError") {
				if (options?.signal?.aborted) {
					throw error;
				}
				throw new Error(`Request timeout after ${timeout}ms`);
			}
			throw error;
		}
	}

	/** 解析 SSE 响应流，提取匹配的 JSON-RPC 响应并处理附带的通知/请求 */
	#parseSSEResponse<T>(response: Response, expectedId: string | number, options?: MCPRequestOptions): Promise<T> {
		if (!response.body) {
			throw new Error("No response body");
		}

		const timeout = this.config.timeout ?? 30000;
		const abortController = new AbortController();
		const timeoutId = setTimeout(() => abortController.abort(), timeout);
		const operationSignal = options?.signal
			? AbortSignal.any([options.signal, abortController.signal])
			: abortController.signal;

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let captured = false;

		// 从单个迭代器中消费 SSE 流。匹配的响应到达后立即 resolve deferred promise，
		// 然后在后台继续迭代以处理附带的通知/请求。
		// 在 `for await` 中断后重新读取 `response.body` 会第二次锁定流，
		// 导致 "ReadableStream already has a controller" 错误，因此不能提前退出循环。
		const drain = async (): Promise<void> => {
			try {
				for await (const raw of readSseJson<JsonRpcMessage | JsonRpcMessage[]>(response.body!, operationSignal)) {
					const messages = Array.isArray(raw) ? raw : [raw];
					for (const message of messages) {
						if (
							!captured &&
							"id" in message &&
							message.id === expectedId &&
							("result" in message || "error" in message)
						) {
							captured = true;
							clearTimeout(timeoutId);
							if (message.error) {
								reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
							} else {
								resolve(message.result as T);
							}
							continue;
						}
						if (!this.#connected) continue;
						this.#dispatchSSEMessage(message);
					}
				}
				if (!captured) {
					reject(new Error(`No response received for request ID ${expectedId}`));
				}
			} catch (error) {
				if (captured) return;
				if (error instanceof Error && error.name === "AbortError") {
					if (options?.signal?.aborted) {
						reject(error);
					} else {
						reject(new Error(`SSE response timeout after ${timeout}ms`));
					}
				} else {
					reject(error as Error);
				}
			} finally {
				clearTimeout(timeoutId);
			}
		};

		void drain();
		return promise;
	}

	/** 处理服务器到客户端的 JSON-RPC 请求 */
	async #handleServerRequest(request: JsonRpcRequest): Promise<void> {
		if (!this.onRequest) {
			await this.#sendServerResponse(request.id, undefined, { code: -32601, message: "Method not found" });
			return;
		}
		try {
			const result = await this.onRequest(request.method, request.params);
			await this.#sendServerResponse(request.id, result);
		} catch (error) {
			await this.#sendServerResponse(request.id, undefined, toJsonRpcError(error));
		}
	}

	/** POST a JSON-RPC response back to the server (for server-to-client requests received via SSE). */
	/** 将 JSON-RPC 响应 POST 回服务器（用于通过 SSE 接收的服务器到客户端请求）。 */
	async #sendServerResponse(id: string | number, result?: unknown, error?: JsonRpcError): Promise<void> {
		if (!this.#connected) return;
		const body = error
			? { jsonrpc: "2.0" as const, id, error }
			: { jsonrpc: "2.0" as const, id, result: result ?? {} };
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.config.headers,
		};
		if (this.#sessionId) {
			headers["Mcp-Session-Id"] = this.#sessionId;
		}
		try {
			const resp = await fetch(this.config.url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.config.timeout ?? 30000),
			});
			// 认证失败时重试一次（若已注册 onAuthError）
			if (this.onAuthError && (resp.status === 401 || resp.status === 403)) {
				await resp.body?.cancel();
				const newHeaders = await this.onAuthError();
				if (newHeaders) {
					this.config.headers ??= {};
					Object.assign(this.config.headers, newHeaders);
					Object.assign(headers, newHeaders);
					const retry = await fetch(this.config.url, {
						method: "POST",
						headers,
						body: JSON.stringify(body),
						signal: AbortSignal.timeout(this.config.timeout ?? 30000),
					});
					await retry.body?.cancel();
					return;
				}
			}
			await resp.body?.cancel();
		} catch {
			// 尽力交付响应 — 服务器可能已断开连接
		}
	}

	/** 发送 JSON-RPC 通知（无需响应） */
	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected) {
			throw new Error("Transport not connected");
		}

		const body = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.config.headers,
		};

		if (this.#sessionId) {
			headers["Mcp-Session-Id"] = this.#sessionId;
		}

		// 创建超时中止控制器
		const timeout = this.config.timeout ?? 30000;
		const abortController = new AbortController();
		const timeoutId = setTimeout(() => abortController.abort(), timeout);

		try {
			const response = await fetch(this.config.url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: abortController.signal,
			});

			clearTimeout(timeoutId);

			// 202 Accepted 对通知来说是成功响应
			if (!response.ok && response.status !== 202) {
				const text = await response.text();
				throw new Error(`HTTP ${response.status}: ${text}`);
			}

			// 服务器可能在通知响应上附带服务器到客户端的请求或通知
			// （MCP 流式 HTTP 规范）。读取它们。
			const contentType = response.headers.get("Content-Type") ?? "";
			if (contentType.includes("text/event-stream") && response.body) {
				// 优先使用 SSE 连接的信号，否则读取直到流结束
				const signal = this.#sseConnection?.signal ?? AbortSignal.timeout(this.config.timeout ?? 30000);
				void this.#readSSEStream(response.body, signal);
			} else {
				await response.body?.cancel();
			}
		} catch (error) {
			clearTimeout(timeoutId);
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(`Notify timeout after ${timeout}ms`);
			}
			throw error;
		}
	}

	/** 关闭传输连接，中止 SSE 监听器并发送会话终止请求 */
	async close(): Promise<void> {
		if (!this.#connected) return;
		this.#connected = false;

		// 中止 SSE 监听器
		if (this.#sseConnection) {
			this.#sseConnection.abort();
			this.#sseConnection = null;
		}

		// 如果有会话则发送会话终止请求
		if (this.#sessionId) {
			try {
				const timeout = this.config.timeout ?? 30000;
				const headers: Record<string, string> = {
					...this.config.headers,
					"Mcp-Session-Id": this.#sessionId,
				};

				await fetch(this.config.url, {
					method: "DELETE",
					headers,
					signal: AbortSignal.timeout(timeout),
				});
			} catch {
				// 忽略终止错误
			}
			this.#sessionId = null;
		}

		this.onClose?.();
		this.onClose = undefined;
	}
}

/**
 * Create and connect an HTTP transport.
 * 创建并连接 HTTP 传输。
 */
export async function createHttpTransport(config: MCPHttpServerConfig | MCPSseServerConfig): Promise<HttpTransport> {
	const transport = new HttpTransport(config);
	await transport.connect();
	return transport;
}


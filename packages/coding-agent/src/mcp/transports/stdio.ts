
/**
 * MCP stdio transport.
 * MCP 标准 IO 传输。
 *
 * Implements JSON-RPC 2.0 over subprocess stdin/stdout.
 * Messages are newline-delimited JSON.
 * 基于子进程 stdin/stdout 实现 JSON-RPC 2.0。消息以换行符分隔的 JSON 格式传输。
 */

import { getProjectDir, readJsonl, Snowflake } from "@oh-my-pi/pi-utils";
import { type Subprocess, spawn } from "bun";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPRequestOptions,
	MCPStdioServerConfig,
	MCPTransport,
} from "../../mcp/types";
import { toJsonRpcError } from "../../mcp/types";

/**
 * Stdio transport for MCP servers.
 * Spawns a subprocess and communicates via stdin/stdout.
 * MCP 服务器的标准 IO 传输实现。
 * 启动子进程并通过 stdin/stdout 通信。
 */
export class StdioTransport implements MCPTransport {
	/** 子进程实例 */
	#process: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	/** 待处理的请求（按 ID 索引） */
	#pendingRequests = new Map<
		string | number,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
		}
	>();
	/** 是否已连接 */
	#connected = false;
	/** 读取循环 Promise */
	#readLoop: Promise<void> | null = null;

	/** 连接关闭回调 */
	onClose?: () => void;
	/** 错误回调 */
	onError?: (error: Error) => void;
	/** 通知回调 */
	onNotification?: (method: string, params: unknown) => void;
	/** 服务器请求回调 */
	onRequest?: (method: string, params: unknown) => Promise<unknown>;

	constructor(private config: MCPStdioServerConfig) {}

	get connected(): boolean {
		return this.#connected;
	}

	/**
	 * Start the subprocess and begin reading.
	 * 启动子进程并开始读取。
	 */
	async connect(): Promise<void> {
		if (this.#connected) return;

		const args = this.config.args ?? [];
		const env = {
			...Bun.env,
			...this.config.env,
		};

		this.#process = spawn({
			cmd: [this.config.command, ...args],
			cwd: this.config.cwd ?? getProjectDir(),
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		this.#connected = true;

		// 开始读取 stdout
		this.#readLoop = this.#startReadLoop();

		// 记录 stderr 用于调试
		this.#startStderrLoop();
	}

	/** 从 stdout 读取 JSONL 消息的循环 */
	async #startReadLoop(): Promise<void> {
		if (!this.#process?.stdout) return;
		try {
			for await (const line of readJsonl(this.#process.stdout)) {
				if (!this.#connected) break;
				try {
					this.#handleMessage(line as JsonRpcMessage);
				} catch {
					// 跳过格式错误的行
				}
			}
		} catch (error) {
			if (this.#connected) {
				this.onError?.(error instanceof Error ? error : new Error(String(error)));
			}
		} finally {
			this.#handleClose();
		}
	}

	/** 读取 stderr 输出的循环（用于日志） */
	async #startStderrLoop(): Promise<void> {
		if (!this.#process?.stderr) return;

		const reader = this.#process.stderr.getReader();
		const decoder = new TextDecoder();

		try {
			while (this.#connected) {
				const { done, value } = await reader.read();
				if (done) break;
				// 记录 stderr 但不视为错误 — 服务器将其用于日志输出
				const text = decoder.decode(value, { stream: true });
				if (text.trim()) {
					// 可通过 onStderr 回调暴露（如有需要）
					// 目前静默处理 — MCP 规范规定客户端可以捕获或忽略
				}
			}
		} catch {
			// 忽略 stderr 读取错误
		} finally {
			reader.releaseLock();
		}
	}

	/** 处理接收到的 JSON-RPC 消息（请求、响应或通知） */
	#handleMessage(message: JsonRpcMessage | JsonRpcMessage[]): void {
		if (Array.isArray(message)) {
			for (const m of message) this.#handleMessage(m);
			return;
		}
		// 服务器到客户端的请求：同时包含 method 和 id
		if ("method" in message && "id" in message && message.id != null) {
			void this.#handleServerRequest(message as JsonRpcRequest);
			return;
		}

		// 对我们请求的响应：包含 id
		if ("id" in message && message.id != null) {
			const response = message as JsonRpcResponse;
			const pending = this.#pendingRequests.get(response.id);
			if (pending) {
				this.#pendingRequests.delete(response.id);
				if (response.error) {
					pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
				} else {
					pending.resolve(response.result);
				}
			}
			return;
		}

		// 通知：有 method 但无 id
		if ("method" in message) {
			const notification = message as { method: string; params?: unknown };
			this.onNotification?.(notification.method, notification.params);
		}
	}

	/** 处理服务器到客户端的 JSON-RPC 请求 */
	async #handleServerRequest(request: JsonRpcRequest): Promise<void> {
		try {
			if (!this.onRequest) {
				this.#sendResponse(request.id, undefined, { code: -32601, message: "Method not found" });
				return;
			}
			const result = await this.onRequest(request.method, request.params);
			this.#sendResponse(request.id, result);
		} catch (error) {
			try {
				this.#sendResponse(request.id, undefined, toJsonRpcError(error));
			} catch {
				// 尽力交付 — 进程可能已退出
			}
		}
	}

	/** 通过 stdin 发送 JSON-RPC 响应 */
	#sendResponse(id: string | number, result?: unknown, error?: JsonRpcError): void {
		if (!this.#connected || !this.#process?.stdin) return;
		const response = error
			? { jsonrpc: "2.0" as const, id, error }
			: { jsonrpc: "2.0" as const, id, result: result ?? {} };
		this.#process.stdin.write(`${JSON.stringify(response)}\n`);
		this.#process.stdin.flush();
	}

	/** 处理连接关闭，拒绝所有待处理的请求 */
	#handleClose(): void {
		if (!this.#connected) return;
		this.#connected = false;

		// 拒绝所有待处理的请求
		for (const [, pending] of this.#pendingRequests) {
			pending.reject(new Error("Transport closed"));
		}
		this.#pendingRequests.clear();

		this.onClose?.();
	}

	/** 发送 JSON-RPC 请求并等待响应，支持超时和中止信号 */
	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		if (!this.#connected || !this.#process?.stdin) {
			throw new Error("Transport not connected");
		}

		const id = Snowflake.next();
		const request = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};

		const timeout = this.config.timeout ?? 30000;
		const signal = options?.signal;

		if (signal?.aborted) {
			const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
			return Promise.reject(reason);
		}

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let timer: NodeJS.Timeout | undefined;
		let settled = false;

		const cleanup = () => {
			if (settled) return;
			settled = true;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
			this.#pendingRequests.delete(id);
		};

		const onAbort = () => {
			cleanup();
			const reason = signal?.reason instanceof Error ? signal.reason : new Error("Aborted");
			reject(reason);
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		this.#pendingRequests.set(id, {
			resolve: (value: unknown) => {
				cleanup();
				resolve(value as T);
			},
			reject: (error: Error) => {
				cleanup();
				reject(error);
			},
		});

		timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Request timeout after ${timeout}ms`));
		}, timeout);

		const message = `${JSON.stringify(request)}\n`;
		try {
			// Bun 的 FileSink 直接提供 write() 方法
			this.#process.stdin.write(message);
			this.#process.stdin.flush();
		} catch (error: unknown) {
			cleanup();
			reject(error instanceof Error ? error : new Error(String(error)));
		}

		return promise;
	}

	/** 发送 JSON-RPC 通知（无需响应） */
	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected || !this.#process?.stdin) {
			throw new Error("Transport not connected");
		}

		const notification = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		const message = `${JSON.stringify(notification)}\n`;
		// Bun 的 FileSink 直接提供 write() 方法
		this.#process.stdin.write(message);
		this.#process.stdin.flush();
	}

	/** 关闭传输连接，终止子进程并拒绝所有待处理的请求 */
	async close(): Promise<void> {
		if (!this.#connected) return;
		this.#connected = false;

		// 拒绝待处理的请求
		for (const [, pending] of this.#pendingRequests) {
			pending.reject(new Error("Transport closed"));
		}
		this.#pendingRequests.clear();

		// 终止子进程
		if (this.#process) {
			this.#process.kill();
			this.#process = null;
		}

		// 等待读取循环结束
		if (this.#readLoop) {
			await this.#readLoop.catch(() => {});
			this.#readLoop = null;
		}

		this.onClose?.();
	}
}

/**
 * Create and connect a stdio transport.
 * 创建并连接标准 IO 传输。
 */
export async function createStdioTransport(config: MCPStdioServerConfig): Promise<StdioTransport> {
	const transport = new StdioTransport(config);
	await transport.connect();
	return transport;
}


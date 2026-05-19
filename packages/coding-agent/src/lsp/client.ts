
import { isEnoent, logger, ptree, untilAborted } from "@oh-my-pi/pi-utils";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import { applyWorkspaceEdit } from "./edits";
import { getLspmuxCommand, isLspmuxSupported } from "./lspmux";
import type {
	LspClient,
	LspJsonRpcNotification,
	LspJsonRpcRequest,
	LspJsonRpcResponse,
	PublishDiagnosticsParams,
	ServerConfig,
	WorkspaceEdit,
} from "./types";
import { detectLanguageId, fileToUri } from "./utils";

// =============================================================================
// 客户端状态
// =============================================================================

/** 已创建的 LSP 客户端实例映射 */
const clients = new Map<string, LspClient>();
/** 正在创建中的客户端锁（防止重复创建） */
const clientLocks = new Map<string, Promise<LspClient>>();
/** 文件操作锁（防止并发文件操作冲突） */
const fileOperationLocks = new Map<string, Promise<void>>();

// 空闲超时配置（默认禁用）
let idleTimeoutMs: number | null = null;
let idleCheckInterval: NodeJS.Timeout | null = null;
/** 空闲检查间隔（毫秒） */
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

/**
 * Configure the idle timeout for LSP clients.
 * @param ms - Timeout in milliseconds, or null/undefined to disable
 * 配置 LSP 客户端的空闲超时
 */
export function setIdleTimeout(ms: number | null | undefined): void {
	idleTimeoutMs = ms ?? null;

	if (idleTimeoutMs && idleTimeoutMs > 0) {
		startIdleChecker();
	} else {
		stopIdleChecker();
	}
}

/** 启动空闲检查定时器 */
function startIdleChecker(): void {
	if (idleCheckInterval) return;
	idleCheckInterval = setInterval(() => {
		if (!idleTimeoutMs) return;
		const now = Date.now();
		for (const [key, client] of Array.from(clients.entries())) {
			if (now - client.lastActivity > idleTimeoutMs) {
				void shutdownClient(key);
			}
		}
	}, IDLE_CHECK_INTERVAL_MS);
}

/** 停止空闲检查定时器 */
function stopIdleChecker(): void {
	if (idleCheckInterval) {
		clearInterval(idleCheckInterval);
		idleCheckInterval = null;
	}
}

// =============================================================================
// 客户端能力声明
// =============================================================================

/** LSP 客户端向服务器声明的能力 */
const CLIENT_CAPABILITIES = {
	textDocument: {
		synchronization: {
			didSave: true,
			dynamicRegistration: false,
			willSave: false,
			willSaveWaitUntil: false,
		},
		hover: {
			contentFormat: ["markdown", "plaintext"],
			dynamicRegistration: false,
		},
		definition: {
			dynamicRegistration: false,
			linkSupport: true,
		},
		typeDefinition: {
			dynamicRegistration: false,
			linkSupport: true,
		},
		implementation: {
			dynamicRegistration: false,
			linkSupport: true,
		},
		references: {
			dynamicRegistration: false,
		},
		documentSymbol: {
			dynamicRegistration: false,
			hierarchicalDocumentSymbolSupport: true,
			symbolKind: {
				valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
			},
		},
		rename: {
			dynamicRegistration: false,
			prepareSupport: true,
		},
		codeAction: {
			dynamicRegistration: false,
			codeActionLiteralSupport: {
				codeActionKind: {
					valueSet: [
						"quickfix",
						"refactor",
						"refactor.extract",
						"refactor.inline",
						"refactor.rewrite",
						"source",
						"source.organizeImports",
						"source.fixAll",
					],
				},
			},
			resolveSupport: {
				properties: ["edit"],
			},
		},
		formatting: {
			dynamicRegistration: false,
		},
		rangeFormatting: {
			dynamicRegistration: false,
		},
		publishDiagnostics: {
			relatedInformation: true,
			versionSupport: true,
			tagSupport: { valueSet: [1, 2] },
			codeDescriptionSupport: true,
			dataSupport: true,
		},
	},
	window: {
		workDoneProgress: true,
	},
	workspace: {
		applyEdit: true,
		workspaceEdit: {
			documentChanges: true,
			resourceOperations: ["create", "rename", "delete"],
			failureHandling: "textOnlyTransactional",
		},
		configuration: true,
		symbol: {
			dynamicRegistration: false,
			symbolKind: {
				valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
			},
		},
		fileOperations: {
			dynamicRegistration: false,
			willCreate: false,
			didCreate: false,
			willRename: true,
			didRename: true,
			willDelete: false,
			didDelete: false,
		},
	},
	experimental: {
		snippetTextEdit: true,
	},
};

// =============================================================================
// LSP 消息协议
// =============================================================================

/**
 * Parse a single LSP message from a buffer.
 * Returns the parsed message and remaining buffer, or null if incomplete.
 * 从缓冲区解析单条 LSP 消息，返回解析结果和剩余缓冲区，不完整时返回 null。
 */
function parseMessage(
	buffer: Buffer,
): { message: LspJsonRpcResponse | LspJsonRpcNotification; remaining: Buffer } | null {
	// 只解码足够多的内容来找到头部
	const headerEndIndex = findHeaderEnd(buffer);
	if (headerEndIndex === -1) return null;

	const headerText = new TextDecoder().decode(buffer.slice(0, headerEndIndex));
	const contentLengthMatch = headerText.match(/Content-Length: (\d+)/i);
	if (!contentLengthMatch) return null;

	const contentLength = Number.parseInt(contentLengthMatch[1], 10);
	const messageStart = headerEndIndex + 4; // Skip \r\n\r\n
	const messageEnd = messageStart + contentLength;

	if (buffer.length < messageEnd) return null;

	const messageBytes = buffer.subarray(messageStart, messageEnd);
	const messageText = new TextDecoder().decode(messageBytes);
	const remaining = buffer.subarray(messageEnd);

	return {
		message: JSON.parse(messageText),
		remaining,
	};
}

/**
 * Find the end of the header section (before \r\n\r\n)
 * 查找头部结束位置（\r\n\r\n 之前）
 */
function findHeaderEnd(buffer: Uint8Array): number {
	for (let i = 0; i < buffer.length - 3; i++) {
		if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
			return i;
		}
	}
	return -1;
}

/** 向 LSP 服务器写入消息 */
async function writeMessage(
	sink: Bun.FileSink,
	message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
): Promise<void> {
	const content = JSON.stringify(message);
	sink.write(`Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n${content}`);
	await sink.flush();
}

/** 将消息加入写入队列（串行化） */
function queueWriteMessage(
	client: LspClient,
	message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
): Promise<void> {
	const write = client.writeQueue.catch(() => {}).then(() => writeMessage(client.proc.stdin, message));
	client.writeQueue = write.catch(() => {});
	return write;
}

// =============================================================================
// 消息读取器
// =============================================================================

/**
 * Start background message reader for a client.
 * Routes responses to pending requests and handles notifications.
 * 启动后台消息读取器，将响应路由到待处理请求并处理通知。
 */
async function startMessageReader(client: LspClient): Promise<void> {
	if (client.isReading) return;
	client.isReading = true;

	const reader = (client.proc.stdout as ReadableStream<Uint8Array>).getReader();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			// 在处理前原子更新缓冲区
			const currentBuffer: Buffer = Buffer.concat([client.messageBuffer, value]);
			client.messageBuffer = currentBuffer;

			// 处理缓冲区中所有完整消息
			// 使用局部变量避免与并发缓冲区更新的竞争
			let workingBuffer = currentBuffer;
			let parsed = parseMessage(workingBuffer);
			while (parsed) {
				const { message, remaining } = parsed;
				workingBuffer = remaining;

				// 路由消息
				if ("id" in message && message.id !== undefined) {
					// 对请求的响应
					const pending = client.pendingRequests.get(message.id);
					if (pending) {
						client.pendingRequests.delete(message.id);
						if ("error" in message && message.error) {
							pending.reject(new Error(`LSP error: ${message.error.message}`));
						} else {
							pending.resolve(message.result);
						}
					} else if ("method" in message) {
						await handleServerRequest(client, message as LspJsonRpcRequest);
					}
				} else if ("method" in message) {
					// 服务器通知
					if (message.method === "textDocument/publishDiagnostics" && message.params) {
						const params = message.params as PublishDiagnosticsParams;
						client.diagnostics.set(params.uri, {
							diagnostics: params.diagnostics,
							version: params.version ?? null,
						});
						client.diagnosticsVersion += 1;
					} else if (message.method === "$/progress" && message.params) {
						const params = message.params as { token: string | number; value?: { kind?: string } };
						if (params.value?.kind === "begin") {
							client.activeProgressTokens.add(params.token);
						} else if (params.value?.kind === "end") {
							client.activeProgressTokens.delete(params.token);
							if (client.activeProgressTokens.size === 0) {
								client.resolveProjectLoaded();
							}
						}
					}
				}

				parsed = parseMessage(workingBuffer);
			}

			// 原子提交已处理的缓冲区
			client.messageBuffer = workingBuffer;
		}
	} catch (err) {
		// 连接关闭或错误 - 拒绝所有待处理请求
		for (const pending of Array.from(client.pendingRequests.values())) {
			pending.reject(new Error(`LSP connection closed: ${err}`));
		}
		client.pendingRequests.clear();
	} finally {
		reader.releaseLock();
		client.isReading = false;
	}
}

/**
 * Handle workspace/configuration requests from the server.
 * 处理服务器发来的 workspace/configuration 请求
 */
async function handleConfigurationRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (typeof message.id !== "number") return;
	const params = message.params as { items?: Array<{ section?: string }> };
	const items = params?.items ?? [];
	const result = items.map(item => {
		const section = item.section ?? "";
		return client.config.settings?.[section] ?? {};
	});
	await sendResponse(client, message.id, result, "workspace/configuration");
}

/**
 * Handle workspace/applyEdit requests from the server.
 * 处理服务器发来的 workspace/applyEdit 请求
 */
async function handleApplyEditRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (typeof message.id !== "number") return;
	const params = message.params as { edit?: WorkspaceEdit };
	if (!params?.edit) {
		await sendResponse(
			client,
			message.id,
			{ applied: false, failureReason: "No edit provided" },
			"workspace/applyEdit",
		);
		return;
	}

	try {
		await applyWorkspaceEdit(params.edit, client.cwd);
		await sendResponse(client, message.id, { applied: true }, "workspace/applyEdit");
	} catch (err) {
		await sendResponse(client, message.id, { applied: false, failureReason: String(err) }, "workspace/applyEdit");
	}
}

/**
 * Respond to a server-initiated request.
 * 响应服务器发起的请求
 */
async function handleServerRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (message.method === "workspace/configuration") {
		await handleConfigurationRequest(client, message);
		return;
	}
	if (message.method === "workspace/applyEdit") {
		await handleApplyEditRequest(client, message);
		return;
	}
	if (message.method === "window/workDoneProgress/create") {
		// 接受服务器的进度令牌注册
		if (typeof message.id === "number") {
			await sendResponse(client, message.id, null, message.method);
		}
		return;
	}
	if (typeof message.id !== "number") return;
	await sendResponse(client, message.id, null, message.method, {
		code: -32601,
		message: `Method not found: ${message.method}`,
	});
}

/**
 * Send an LSP response to the server.
 * 向服务器发送 LSP 响应
 */
async function sendResponse(
	client: LspClient,
	id: number,
	result: unknown,
	method: string,
	error?: { code: number; message: string; data?: unknown },
): Promise<void> {
	const response: LspJsonRpcResponse = {
		jsonrpc: "2.0",
		id,
		...(error ? { error } : { result }),
	};

	try {
		await queueWriteMessage(client, response);
	} catch (err) {
		logger.error("LSP failed to respond.", { method, error: String(err) });
	}
}

// =============================================================================
// 客户端管理
// =============================================================================

/** Timeout for warmup initialize requests (5 seconds) */
/** 预热初始化请求超时（5 秒） */
export const WARMUP_TIMEOUT_MS = 5000;

/** Max time to wait for the server to report project loading completion via $/progress */
/** 等待服务器通过 $/progress 报告项目加载完成的最大时间 */
const PROJECT_LOAD_TIMEOUT_MS = 15_000;

/**
 * Get or create an LSP client for the given server configuration and working directory.
 * @param config - Server configuration
 * @param cwd - Working directory
 * @param initTimeoutMs - Optional timeout for the initialize request (defaults to 30s)
 */
export async function getOrCreateClient(config: ServerConfig, cwd: string, initTimeoutMs?: number): Promise<LspClient> {
	const key = `${config.command}:${cwd}`;

	// 检查客户端是否已存在
	const existingClient = clients.get(key);
	if (existingClient) {
		existingClient.lastActivity = Date.now();
		return existingClient;
	}

	// 检查是否有其他协程正在创建此客户端
	const existingLock = clientLocks.get(key);
	if (existingLock) {
		return existingLock;
	}

	// 加锁创建新客户端
	const clientPromise = (async () => {
		const baseCommand = config.resolvedCommand ?? config.command;
		const baseArgs = config.args ?? [];

		// 如果可用且支持，则使用 lspmux 包装
		const { command, args, env } = isLspmuxSupported(baseCommand)
			? await getLspmuxCommand(baseCommand, baseArgs)
			: { command: baseCommand, args: baseArgs };

		const proc = ptree.spawn([command, ...args], {
			cwd,
			stdin: "pipe",
			env: env ? { ...Bun.env, ...env } : undefined,
		});

		let resolveProjectLoaded!: () => void;
		const projectLoaded = new Promise<void>(resolve => {
			resolveProjectLoaded = resolve;
		});
		// 超时后自动解决，以防服务器不使用进度令牌
		const projectLoadTimeout = setTimeout(resolveProjectLoaded, PROJECT_LOAD_TIMEOUT_MS);
		const originalResolve = resolveProjectLoaded;
		resolveProjectLoaded = () => {
			clearTimeout(projectLoadTimeout);
			originalResolve();
		};

		const client: LspClient = {
			name: key,
			cwd,
			proc,
			config,
			requestId: 0,
			diagnostics: new Map(),
			diagnosticsVersion: 0,
			openFiles: new Map(),
			pendingRequests: new Map(),
			messageBuffer: new Uint8Array(0),
			isReading: false,
			lastActivity: Date.now(),
			writeQueue: Promise.resolve(),
			activeProgressTokens: new Set(),
			projectLoaded,
			resolveProjectLoaded,
		};
		clients.set(key, client);

		// 注册崩溃恢复 - 进程退出时移除客户端
		proc.exited.then(() => {
			clients.delete(key);
			clientLocks.delete(key);
			client.resolveProjectLoaded();

			// Reject any pending requests — the server is gone, they will never complete.
			if (client.pendingRequests.size > 0) {
				// Strip informational log lines (e.g. marksman's [INF]/[DBG] prefix)
				// — they are startup noise, not actionable errors.
				const rawStderr = proc.peekStderr().trim();
				const stderr = rawStderr
					.split("\n")
					.filter(line => !/^\[\d{2}:\d{2}:\d{2} (?:INF|DBG|VRB)\]/.test(line))
					.join("\n")
					.trim();
				const code = proc.exitCode;
				const err = new Error(
					stderr ? `LSP server exited (code ${code}): ${stderr}` : `LSP server exited unexpectedly (code ${code})`,
				);
				for (const pending of client.pendingRequests.values()) {
					pending.reject(err);
				}
				client.pendingRequests.clear();
			}
		});

		// 启动后台消息读取器
		startMessageReader(client);

		try {
			// 发送初始化请求
			const initResult = (await sendRequest(
				client,
				"initialize",
				{
					processId: process.pid,
					rootUri: fileToUri(cwd),
					rootPath: cwd,
					capabilities: CLIENT_CAPABILITIES,
					initializationOptions: config.initOptions ?? {},
					workspaceFolders: [{ uri: fileToUri(cwd), name: cwd.split("/").pop() ?? "workspace" }],
				},
				undefined, // signal
				initTimeoutMs,
			)) as { capabilities?: unknown };

			if (!initResult) {
				throw new Error("Failed to initialize LSP: no response");
			}

			client.serverCapabilities = initResult.capabilities as LspClient["serverCapabilities"];

			// 发送初始化完成通知
			await sendNotification(client, "initialized", {});

			return client;
		} catch (err) {
			// 初始化失败时清理
			clients.delete(key);
			clientLocks.delete(key);
			proc.kill();
			throw err;
		} finally {
			clientLocks.delete(key);
		}
	})();

	clientLocks.set(key, clientPromise);
	return clientPromise;
}

/**
 * Ensure a file is opened in the LSP client.
 * Sends didOpen notification if the file is not already tracked.
 * 确保文件已在 LSP 客户端中打开，若未跟踪则发送 didOpen 通知。
 */
export async function ensureFileOpen(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	const lockKey = `${client.name}:${uri}`;

	// Check if file is already open
	if (client.openFiles.has(uri)) {
		return;
	}

	// Check if another operation is already opening this file
	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) {
		await untilAborted(signal, () => existingLock);
		return;
	}

	// Lock and open file
	const openPromise = (async () => {
		throwIfAborted(signal);
		// Double-check after acquiring lock
		if (client.openFiles.has(uri)) {
			return;
		}

		let content: string;
		try {
			content = await Bun.file(filePath).text();
			throwIfAborted(signal);
		} catch (err) {
			if (isEnoent(err)) return;
			throw err;
		}
		const languageId = detectLanguageId(filePath);
		throwIfAborted(signal);

		await sendNotification(client, "textDocument/didOpen", {
			textDocument: {
				uri,
				languageId,
				version: 1,
				text: content,
			},
		});

		client.openFiles.set(uri, { version: 1, languageId });
		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, openPromise);
	try {
		await openPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

/**
 * Wait for the server's initial project loading to complete.
 * Races the server's $/progress tracking against the abort signal.
 * Returns immediately if loading already completed or timed out.
 * 等待服务器初始项目加载完成，与中止信号竞争。若已完成或超时则立即返回。
 */
export async function waitForProjectLoaded(client: LspClient, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	await Promise.race([
		client.projectLoaded,
		...(signal
			? [new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]
			: []),
	]);
}

/**
 * Sync in-memory content to the LSP client without reading from disk.
 * Use this to provide instant feedback during edits before the file is saved.
 * 将内存中的内容同步到 LSP 客户端（不从磁盘读取），用于文件保存前提供即时反馈。
 */
export async function syncContent(
	client: LspClient,
	filePath: string,
	content: string,
	signal?: AbortSignal,
): Promise<void> {
	const uri = fileToUri(filePath);
	const lockKey = `${client.name}:${uri}`;
	throwIfAborted(signal);

	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) {
		await untilAborted(signal, () => existingLock);
	}

	const syncPromise = (async () => {
		// Clear stale diagnostics before syncing new content
		client.diagnostics.delete(uri);

		const info = client.openFiles.get(uri);

		if (!info) {
			// Open file with provided content instead of reading from disk
			const languageId = detectLanguageId(filePath);
			throwIfAborted(signal);
			await sendNotification(client, "textDocument/didOpen", {
				textDocument: {
					uri,
					languageId,
					version: 1,
					text: content,
				},
			});
			client.openFiles.set(uri, { version: 1, languageId });
			client.lastActivity = Date.now();
			return;
		}

		const version = ++info.version;
		throwIfAborted(signal);
		await sendNotification(client, "textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text: content }],
		});
		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, syncPromise);
	try {
		await syncPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

/**
 * Notify LSP that a file was saved.
 * Assumes content was already synced via syncContent - just sends didSave.
 * 通知 LSP 文件已保存。假定内容已通过 syncContent 同步。
 */
export async function notifySaved(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	const uri = fileToUri(filePath);
	const info = client.openFiles.get(uri);
	if (!info) return; // File not open, nothing to notify

	throwIfAborted(signal);
	await sendNotification(client, "textDocument/didSave", {
		textDocument: { uri },
	});
	client.lastActivity = Date.now();
}

/**
 * Refresh a file in the LSP client.
 * Increments version, sends didChange and didSave notifications.
 * 刷新 LSP 客户端中的文件，递增版本号并发送 didChange 和 didSave 通知。
 */
export async function refreshFile(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	const lockKey = `${client.name}:${uri}`;

	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) {
		await untilAborted(signal, () => existingLock);
	}

	const refreshPromise = (async () => {
		throwIfAborted(signal);
		// Drop cached diagnostics for this URI before asking the server to recompute.
		// Otherwise an unrelated publishDiagnostics notification can advance the global
		// diagnostics version and cause waiters to accept stale unversioned diagnostics.
		client.diagnostics.delete(uri);
		const info = client.openFiles.get(uri);

		if (!info) {
			await ensureFileOpen(client, filePath, signal);
			return;
		}

		let content: string;
		try {
			content = await Bun.file(filePath).text();
			throwIfAborted(signal);
		} catch (err) {
			if (isEnoent(err)) return;
			throw err;
		}
		const version = ++info.version;
		throwIfAborted(signal);

		await sendNotification(client, "textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text: content }],
		});
		throwIfAborted(signal);

		await sendNotification(client, "textDocument/didSave", {
			textDocument: { uri },
			text: content,
		});

		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, refreshPromise);
	try {
		await refreshPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

/**
 * Shutdown a specific client by key.
 * 关闭特定客户端实例
 */
async function shutdownClientInstance(client: LspClient): Promise<void> {
	const err = new Error("LSP client shutdown");
	for (const pending of Array.from(client.pendingRequests.values())) {
		pending.reject(err);
	}
	client.pendingRequests.clear();

	const timeout = Bun.sleep(5_000);
	const shutdown = sendRequest(client, "shutdown", null).catch(() => {});
	await Promise.race([shutdown, timeout]);
	client.proc.kill();
	await Promise.race([client.proc.exited.catch(() => {}), Bun.sleep(1_000)]);
}

/** 按键关闭 LSP 客户端 */
export async function shutdownClient(key: string): Promise<void> {
	const client = clients.get(key);
	if (!client) return;
	clients.delete(key);
	await shutdownClientInstance(client);
}

// =============================================================================
// LSP 协议方法
// =============================================================================

/** Default timeout for LSP requests (30 seconds) */
/** LSP 请求默认超时（30 秒） */
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

/**
 * Send an LSP request and wait for response.
 * 发送 LSP 请求并等待响应
 */
export async function sendRequest(
	client: LspClient,
	method: string,
	params: unknown,
	signal?: AbortSignal,
	timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
	// 原子递增并捕获请求 ID
	const id = ++client.requestId;
	if (signal?.aborted) {
		const reason = signal.reason instanceof Error ? signal.reason : new ToolAbortError();
		return Promise.reject(reason);
	}

	const request: LspJsonRpcRequest = {
		jsonrpc: "2.0",
		id,
		method,
		params,
	};

	client.lastActivity = Date.now();

	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	let timeout: NodeJS.Timeout | undefined;
	const cleanup = () => {
		if (signal) {
			signal.removeEventListener("abort", abortHandler);
		}
	};
	const abortHandler = () => {
		if (client.pendingRequests.has(id)) {
			client.pendingRequests.delete(id);
		}
		void sendNotification(client, "$/cancelRequest", { id }).catch(() => {});
		if (timeout) clearTimeout(timeout);
		cleanup();
		const reason = signal?.reason instanceof Error ? signal.reason : new ToolAbortError();
		reject(reason);
	};

	// 设置超时
	timeout = setTimeout(() => {
		if (client.pendingRequests.has(id)) {
			client.pendingRequests.delete(id);
			const err = new Error(`LSP request ${method} timed out after ${timeoutMs}ms`);
			cleanup();
			reject(err);
		}
	}, timeoutMs);
	if (signal) {
		signal.addEventListener("abort", abortHandler, { once: true });
		if (signal.aborted) {
			abortHandler();
			return promise;
		}
	}

	// 注册带超时包装的待处理请求
	client.pendingRequests.set(id, {
		resolve: result => {
			if (timeout) clearTimeout(timeout);
			cleanup();
			resolve(result);
		},
		reject: err => {
			if (timeout) clearTimeout(timeout);
			cleanup();
			reject(err);
		},
		method,
	});

	// 写入请求
	queueWriteMessage(client, request).catch(err => {
		if (timeout) clearTimeout(timeout);
		client.pendingRequests.delete(id);
		cleanup();
		reject(err);
	});
	return promise;
}

/**
 * Send an LSP notification (no response expected).
 * 发送 LSP 通知（不期望响应）
 */
export async function sendNotification(client: LspClient, method: string, params: unknown): Promise<void> {
	const notification: LspJsonRpcNotification = {
		jsonrpc: "2.0",
		method,
		params,
	};

	client.lastActivity = Date.now();
	await queueWriteMessage(client, notification);
}

/**
 * Shutdown all LSP clients.
 * 关闭所有 LSP 客户端
 */
export async function shutdownAll(): Promise<void> {
	const clientsToShutdown = Array.from(clients.values());
	clients.clear();
	await Promise.allSettled(clientsToShutdown.map(client => shutdownClientInstance(client)));
}

/** Status of an LSP server */
/** LSP 服务器状态 */
export interface LspServerStatus {
	name: string;
	status: "connecting" | "ready" | "error";
	fileTypes: string[];
	error?: string;
}

/**
 * Get status of all active LSP clients.
 * 获取所有活跃 LSP 客户端的状态
 */
export function getActiveClients(): LspServerStatus[] {
	return Array.from(clients.values()).map(client => ({
		name: client.config.command,
		status: "ready" as const,
		fileTypes: client.config.fileTypes,
	}));
}

// =============================================================================
// 进程清理
// =============================================================================

// 模块卸载时注册清理回调
if (typeof process !== "undefined") {
	process.on("beforeExit", () => {
		void shutdownAll();
	});
	process.on("SIGINT", () => {
		void (async () => {
			await shutdownAll();
			process.exit(0);
		})();
	});
	process.on("SIGTERM", () => {
		void (async () => {
			await shutdownAll();
			process.exit(0);
		})();
	});
}


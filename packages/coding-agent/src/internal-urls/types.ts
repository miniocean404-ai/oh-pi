
/**
 * Types for the internal URL routing system.
 *
 * Internal URLs (agent://, artifact://, memory://, skill://, rule://, mcp://, omp://, local://) are resolved by tools like read,
 * providing access to agent outputs and server resources without exposing filesystem paths.
 *
 * 内部 URL 路由系统的类型定义。
 * 内部 URL（agent://、artifact://、memory://、skill://、rule://、mcp://、omp://、local://）由 read 等工具解析，
 * 在不暴露文件系统路径的前提下，提供对 Agent 输出和服务端资源的访问。
 */

/**
 * Raw resource payload returned by protocol handlers. The `immutable` flag is
 * applied by the router from {@link ProtocolHandler.immutable}, so handlers do
 * not need to set it themselves.
 *
 * 协议处理器返回的原始资源负载。`immutable` 字段由 router 根据
 * {@link ProtocolHandler.immutable} 自动注入，处理器无需自行设置。
 */
export interface InternalResource {
	/** Canonical URL that was resolved */
	url: string;
	/** Resolved text content */
	content: string;
	/** MIME type: text/markdown, application/json, or text/plain */
	contentType: "text/markdown" | "application/json" | "text/plain";
	/** Content size in bytes */
	size?: number;
	/** Underlying filesystem path (for debugging, not exposed to agent) */
	sourcePath?: string;
	/** Additional notes about resolution */
	notes?: string[];
	/**
	 * True when the resolved content cannot be edited by the agent (e.g. sealed
	 * artifacts, harness docs, machine-generated memory summaries). Hashline
	 * anchors and similar edit affordances are suppressed for immutable
	 * resources. Mutable resources (e.g. local://) behave like editable files.
	 */
	immutable?: boolean;
}

/**
 * Parsed internal URL with preserved host casing.
 *
 * 解析后的内部 URL，保留 host 段的大小写。
 */
export interface InternalUrl extends URL {
	/**
	 * Raw host segment extracted from input, preserving case.
	 */
	rawHost: string;
	/**
	 * Raw pathname extracted from input, preserving traversal markers before URL normalization.
	 */
	rawPathname?: string;
}

/**
 * Caller-supplied context that the router threads into protocol handlers.
 *
 * Read tool calls `InternalUrlRouter.resolve(url, { cwd, settings, signal })`
 * so handlers can resolve relative defaults (e.g. `issue://N` → which repo?)
 * against the actual session that initiated the read, not whichever session
 * happens to be registered first in the global `AgentRegistry`.
 *
 * 调用方传入的上下文，router 会将其透传给协议处理器。
 * read 工具调用 `InternalUrlRouter.resolve(url, { cwd, settings, signal })`，
 * 让处理器能基于发起读取的实际会话解析相对默认值（例如 `issue://N` → 哪个仓库？），
 * 而不是依赖全局 `AgentRegistry` 中先注册的会话。
 */
export interface ResolveContext {
	/** Working directory of the calling session. */
	cwd?: string;
	/** Settings of the calling session (used by `issue://`/`pr://` for cache TTLs). */
	settings?: unknown;
	/** Caller's abort signal. */
	signal?: AbortSignal;
}

/**
 * Caller context for write operations dispatched to host-owned URI handlers.
 * Mirrors {@link ResolveContext} so handlers that share read/write state can
 * accept the same shape.
 *
 * 用于派发给 host 所有的 URI 处理器的写操作调用方上下文。
 * 形状与 {@link ResolveContext} 一致，便于共享读写状态的处理器复用同一接口。
 */
export interface WriteContext {
	/** Working directory of the calling session. */
	cwd?: string;
	/** Caller's abort signal. */
	signal?: AbortSignal;
}

/**
 * Handler for a specific internal URL scheme (e.g., agent://, memory://, skill://, mcp://).
 *
 * 针对某个内部 URL scheme（例如 agent://、memory://、skill://、mcp://）的处理器。
 */
export interface ProtocolHandler {
	/** The scheme this handler processes (without trailing ://) */
	readonly scheme: string;
	/**
	 * Whether resources produced by this handler are immutable (cannot be
	 * edited by the agent). When true, callers suppress hashline anchors and
	 * other edit affordances. When false, resources behave like editable files.
	 */
	readonly immutable: boolean;
	/**
	 * Resolve an internal URL to its content. The router stamps the
	 * {@link InternalResource.immutable} flag from {@link ProtocolHandler.immutable}.
	 *
	 * @param url Parsed URL object
	 * @param context Optional caller context. Handlers that depend on caller
	 *   identity (working directory, settings) **MUST** consume this in
	 *   preference to global state.
	 * @throws Error with user-friendly message if resolution fails
	 */
	resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource>;
	/**
	 * Optional write hook. When present, the write tool dispatches
	 * `write(url, content)` to this handler instead of writing to a filesystem
	 * path. The handler is responsible for any persistence and validation.
	 *
	 * Handlers that omit this method are treated as read-only; the write tool
	 * surfaces a clear "not writable" error when invoked against them.
	 */
	write?(url: InternalUrl, content: string, context?: WriteContext): Promise<void>;
}



/**
 * local:// 协议处理器：会话级临时空间，用于存放大体量中间数据、
 * 子 Agent 交接产物以及可复用的规划性 artifact。
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";
import { parseInternalUrl } from "./parse";
import { validateRelativePath } from "./skill-protocol";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

/**
 * local:// 协议的可注入选项：用于决定 artifacts 目录与会话 ID 来源。
 */
export interface LocalProtocolOptions {
	getArtifactsDir?: () => string | null;
	getSessionId?: () => string | null;
}

function parseLocalUrl(input: string): InternalUrl {
	return parseInternalUrl(input);
}

function ensureWithinRoot(targetPath: string, rootPath: string): void {
	if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error("local:// URL escapes local root");
	}
}

function toLocalValidationError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(message.replace("skill://", "local://"));
}

function getContentType(filePath: string): InternalResource["contentType"] {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".md") return "text/markdown";
	if (ext === ".json") return "application/json";
	return "text/plain";
}

async function listFilesRecursively(rootPath: string): Promise<string[]> {
	const pending = [""];
	const files: string[] = [];

	while (pending.length > 0) {
		const relativeDir = pending.pop();
		if (relativeDir === undefined) continue;
		const absoluteDir = path.join(rootPath, relativeDir);
		const entries = await fs.readdir(absoluteDir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(relativeDir, entry.name);
			if (entry.isDirectory()) {
				pending.push(entryPath);
				continue;
			}
			if (entry.isFile()) {
				files.push(entryPath.replaceAll(path.sep, "/"));
			}
		}
	}

	return files.sort((a, b) => a.localeCompare(b));
}

async function buildListing(url: InternalUrl, localRoot: string): Promise<InternalResource> {
	const files = await listFilesRecursively(localRoot);
	const listing = files.length === 0 ? "(empty)" : files.map(file => `- [${file}](local://${file})`).join("\n");
	const content =
		`# Local\n\n` +
		`Session-scoped scratch space for large intermediate data, subagent handoffs, and reusable planning artifacts.\n\n` +
		`Root: ${localRoot}\n\n` +
		`${files.length} file${files.length === 1 ? "" : "s"} available:\n\n` +
		`${listing}\n`;

	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: localRoot,
	};
}

function extractRelativePath(url: InternalUrl): string {
	const host = url.rawHost || url.hostname;
	const pathname = url.rawPathname ?? url.pathname;

	const combined = host
		? pathname && pathname !== "/"
			? `${host}${pathname}`
			: host
		: pathname && pathname !== "/"
			? pathname.slice(1)
			: "";

	if (!combined) {
		return "";
	}

	let decoded: string;
	try {
		decoded = decodeURIComponent(combined.replaceAll("\\", "/"));
	} catch {
		throw new Error(`Invalid URL encoding in local:// path: ${url.href}`);
	}
	try {
		validateRelativePath(decoded);
	} catch (error) {
		throw toLocalValidationError(error);
	}
	return decoded;
}

/**
 * 解析 local:// 协议的根目录：优先使用 artifacts 目录下的 `local` 子目录，
 * 否则回退到 `os.tmpdir()/omp-local/<safeSessionId>`。
 */
export function resolveLocalRoot(options: LocalProtocolOptions): string {
	const artifactsDir = options.getArtifactsDir?.();
	if (artifactsDir) {
		return path.resolve(artifactsDir, "local");
	}

	const sessionId = options.getSessionId?.() ?? "session";
	const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
	return path.join(os.tmpdir(), "omp-local", safeSessionId);
}

/**
 * 将 local:// URL 解析为绝对文件路径，并校验其位于 local 根目录之内。
 */
export function resolveLocalUrlToPath(input: string | InternalUrl, options: LocalProtocolOptions): string {
	const url = typeof input === "string" ? parseLocalUrl(input) : input;
	const localRoot = path.resolve(resolveLocalRoot(options));
	const relativePath = extractRelativePath(url);

	if (!relativePath) {
		return localRoot;
	}

	const resolved = path.resolve(localRoot, relativePath);
	ensureWithinRoot(resolved, localRoot);
	return resolved;
}

/**
 * Protocol handler for local:// URLs.
 *
 * URL forms:
 * - local:// - Lists files at the session local root
 * - local://<path> - Reads a file under the session local root
 *
 * local:// URL 协议处理器。
 * URL 形式：
 * - local://         列出会话 local 根目录下的所有文件
 * - local://<path>   读取会话 local 根目录下的指定文件
 */
export class LocalProtocolHandler implements ProtocolHandler {
	readonly scheme = "local";
	readonly immutable = false;

	static #override: LocalProtocolOptions | undefined;

	/**
	 * Install a process-global override that wins over the AgentRegistry-based
	 * derivation. Used by SDK consumers that wire `localProtocolOptions` on
	 * `createAgentSession` and by subagents that share their parent's root.
	 *
	 * 安装一个进程级全局覆盖项，其优先级高于基于 AgentRegistry 的推导。
	 * 由在 `createAgentSession` 上配置 `localProtocolOptions` 的 SDK 调用方
	 * 以及共享父级根目录的子 Agent 使用。
	 */
	static setOverride(value: LocalProtocolOptions | undefined): void {
		LocalProtocolHandler.#override = value;
	}

	/** Reset the process-global override. Test-only.
	 *  重置进程级全局覆盖项（仅测试使用）。 */
	static resetOverrideForTests(): void {
		LocalProtocolHandler.#override = undefined;
	}

	/**
	 * Returns the active local-protocol options.
	 *
	 * Resolution order:
	 * 1. Explicit override installed via {@link setOverride} (used by subagents
	 *    that share their parent's root and by SDK consumers with a custom
	 *    artifacts/session id mapping).
	 * 2. The main session in `AgentRegistry.global()`. Its `SessionManager`
	 *    supplies both `getArtifactsDir` and `getSessionId`.
	 *
	 * 返回当前活跃的 local 协议选项。
	 * 解析顺序：
	 *   1. 通过 {@link setOverride} 安装的显式覆盖项（用于共享父级根目录的子 Agent
	 *      以及拥有自定义 artifacts/session id 映射的 SDK 调用方）
	 *   2. `AgentRegistry.global()` 中的主会话，其 `SessionManager` 同时提供
	 *      `getArtifactsDir` 与 `getSessionId`。
	 */
	static resolveOptions(): LocalProtocolOptions | undefined {
		const override = LocalProtocolHandler.#override;
		if (override) return override;
		const main = AgentRegistry.global()
			.list()
			.find(ref => ref.kind === "main");
		const sessionManager = main?.session?.sessionManager;
		if (!sessionManager) return undefined;
		return {
			getArtifactsDir: () => sessionManager.getArtifactsDir(),
			getSessionId: () => sessionManager.getSessionId(),
		};
	}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const opts = LocalProtocolHandler.resolveOptions();
		if (!opts) {
			throw new Error("No session - local:// unavailable");
		}

		const localRoot = path.resolve(resolveLocalRoot(opts));
		await fs.mkdir(localRoot, { recursive: true });

		let resolvedRoot: string;
		try {
			resolvedRoot = await fs.realpath(localRoot);
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error("Unable to initialize local:// root");
			}
			throw error;
		}

		const relativePath = extractRelativePath(url);
		const targetPath = relativePath ? path.resolve(resolvedRoot, relativePath) : resolvedRoot;
		ensureWithinRoot(targetPath, resolvedRoot);

		if (targetPath === resolvedRoot) {
			return buildListing(url, resolvedRoot);
		}

		const parentDir = path.dirname(targetPath);
		try {
			const realParent = await fs.realpath(parentDir);
			ensureWithinRoot(realParent, resolvedRoot);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}

		let realTargetPath: string;
		try {
			realTargetPath = await fs.realpath(targetPath);
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`Local file not found: ${url.href}`);
			}
			throw error;
		}

		ensureWithinRoot(realTargetPath, resolvedRoot);

		const stat = await fs.stat(realTargetPath);
		if (!stat.isFile()) {
			throw new Error(`local:// URL must resolve to a file: ${url.href}`);
		}

		const content = await Bun.file(realTargetPath).text();
		return {
			url: url.href,
			content,
			contentType: getContentType(realTargetPath),
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: realTargetPath,
			notes: ["Use write path local://<file> to persist large intermediate artifacts across turns."],
		};
	}
}


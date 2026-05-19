
/**
 * Protocol handler for artifact:// URLs.
 *
 * Resolves artifact IDs against the artifacts directories of every active
 * session. Unlike agent://, artifacts are raw text with no JSON extraction.
 *
 * URL form:
 * - artifact://<id> - Full artifact content
 *
 * Pagination is handled by the read tool via offset/limit parameters.
 *
 * artifact:// URL 协议处理器。
 * 在所有活跃会话的 artifacts 目录中查找解析 artifact ID。
 * 与 agent:// 不同，artifact 是纯文本，不做 JSON 提取。
 * URL 形式：artifact://<id> 返回完整 artifact 内容。
 * 分页由 read 工具通过 offset/limit 参数自行处理。
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { artifactsDirsFromRegistry } from "./registry-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

/**
 * artifact:// URL 处理器：按数字 ID 在 artifacts 目录中定位并读取文件。
 */
export class ArtifactProtocolHandler implements ProtocolHandler {
	readonly scheme = "artifact";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const id = url.rawHost || url.hostname;
		if (!id) {
			throw new Error("artifact:// URL requires a numeric ID: artifact://0");
		}
		if (!/^\d+$/.test(id)) {
			throw new Error(`artifact:// ID must be numeric, got: ${id}`);
		}

		const dirs = artifactsDirsFromRegistry();

		if (dirs.length === 0) {
			throw new Error("No session - artifacts unavailable");
		}

		let foundPath: string | undefined;
		let anyDirExists = false;
		const availableIds = new Set<string>();

		for (const dir of dirs) {
			let files: string[];
			try {
				files = await fs.readdir(dir);
				anyDirExists = true;
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			const match = files.find(f => f.startsWith(`${id}.`));
			if (match) {
				foundPath = path.join(dir, match);
				break;
			}
			for (const f of files) {
				const m = f.match(/^(\d+)\./);
				if (m) availableIds.add(m[1]);
			}
		}

		if (!anyDirExists) {
			throw new Error("No artifacts directory found");
		}

		if (!foundPath) {
			const sorted = [...availableIds].sort((a, b) => Number(a) - Number(b));
			const availableStr = sorted.length > 0 ? sorted.join(", ") : "none";
			throw new Error(`Artifact ${id} not found. Available: ${availableStr}`);
		}

		const content = await Bun.file(foundPath).text();
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: foundPath,
		};
	}
}


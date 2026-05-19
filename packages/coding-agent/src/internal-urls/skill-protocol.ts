
/**
 * Protocol handler for skill:// URLs.
 *
 * Resolves skill names to their SKILL.md files or relative paths within skill directories.
 *
 * URL forms:
 * - skill://<name> - Reads SKILL.md
 * - skill://<name>/<path> - Reads relative path within skill's baseDir
 *
 * skill:// URL 协议处理器。
 * 将 skill 名称解析为其 SKILL.md 文件，或解析为 skill 目录内的相对路径。
 * URL 形式：
 * - skill://<name>          读取 SKILL.md
 * - skill://<name>/<path>   读取 skill baseDir 下的相对路径
 */
import * as path from "node:path";
import { getActiveSkills } from "../extensibility/skills";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

function getContentType(filePath: string): InternalResource["contentType"] {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".md") return "text/markdown";
	return "text/plain";
}

/**
 * Validate that a path is safe (no traversal, no absolute paths).
 *
 * 校验给定路径是否安全：禁止路径穿越（..）与绝对路径。
 */
export function validateRelativePath(relativePath: string): void {
	if (path.isAbsolute(relativePath)) {
		throw new Error("Absolute paths are not allowed in skill:// URLs");
	}

	const normalized = path.normalize(relativePath);
	if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("/..")) {
		throw new Error("Path traversal (..) is not allowed in skill:// URLs");
	}
}

/**
 * Handler for skill:// URLs.
 *
 * skill:// URL 处理器：在当前活跃的 skills 中按名称查找并读取相应文件。
 */
export class SkillProtocolHandler implements ProtocolHandler {
	readonly scheme = "skill";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const skills = getActiveSkills();

		const skillName = url.rawHost || url.hostname;
		if (!skillName) {
			throw new Error("skill:// URL requires a skill name: skill://<name>");
		}

		const skill = skills.find(s => s.name === skillName);
		if (!skill) {
			const available = skills.map(s => s.name);
			const availableStr = available.length > 0 ? available.join(", ") : "none";
			throw new Error(`Unknown skill: ${skillName}\nAvailable: ${availableStr}`);
		}

		let targetPath: string;
		const urlPath = url.pathname;
		const hasRelativePath = urlPath && urlPath !== "/" && urlPath !== "";

		if (hasRelativePath) {
			const relativePath = decodeURIComponent(urlPath.slice(1));
			validateRelativePath(relativePath);
			targetPath = path.join(skill.baseDir, relativePath);

			const resolvedPath = path.resolve(targetPath);
			const resolvedBaseDir = path.resolve(skill.baseDir);
			if (!resolvedPath.startsWith(resolvedBaseDir + path.sep) && resolvedPath !== resolvedBaseDir) {
				throw new Error("Path traversal is not allowed");
			}
		} else {
			targetPath = skill.filePath;
		}

		const file = Bun.file(targetPath);
		if (!(await file.exists())) {
			throw new Error(`File not found: ${targetPath}`);
		}

		const content = await file.text();
		return {
			url: url.href,
			content,
			contentType: getContentType(targetPath),
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: targetPath,
			notes: [],
		};
	}
}



/**
 * Capability File System Utilities
 * 能力系统的文件系统工具函数。
 *
 * 提供带缓存的文件读取、目录读取、向上遍历查找等文件系统操作。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** 文件内容缓存，键为绝对路径，值为文件内容或 null（不存在） */
const contentCache = new Map<string, string | null>();
/** 目录条目缓存，键为绝对路径，值为目录条目数组 */
const dirCache = new Map<string, fs.Dirent[]>();

/** 将路径解析为绝对路径 */
function resolvePath(filePath: string): string {
	return path.resolve(filePath);
}

/**
 * 读取文件内容，带缓存。
 * 文件不存在时返回 null 并缓存该结果。
 */
export async function readFile(filePath: string): Promise<string | null> {
	const abs = resolvePath(filePath);
	if (contentCache.has(abs)) {
		return contentCache.get(abs) ?? null;
	}

	try {
		const content = await Bun.file(abs).text();
		contentCache.set(abs, content);
		return content;
	} catch {
		contentCache.set(abs, null);
		return null;
	}
}

/**
 * 读取目录条目（含文件类型信息），带缓存。
 * 目录不存在时返回空数组。
 */
export async function readDirEntries(dirPath: string): Promise<fs.Dirent[]> {
	const abs = resolvePath(dirPath);
	if (dirCache.has(abs)) {
		return dirCache.get(abs) ?? [];
	}

	try {
		const entries = await fs.promises.readdir(abs, { withFileTypes: true });
		dirCache.set(abs, entries);
		return entries;
	} catch {
		dirCache.set(abs, []);
		return [];
	}
}

/**
 * 读取目录下的文件/子目录名称列表。
 */
export async function readDir(dirPath: string): Promise<string[]> {
	const entries = await readDirEntries(dirPath);
	return entries.map(entry => entry.name);
}

/**
 * 从起始目录向上遍历，查找指定名称的文件或目录。
 * 找到时返回完整路径，到达根目录仍未找到时返回 null。
 */
export async function walkUp(
	startDir: string,
	name: string,
	opts: { file?: boolean; dir?: boolean } = {},
): Promise<string | null> {
	const { file = true, dir = true } = opts;
	let current = resolvePath(startDir);

	while (true) {
		const entries = await readDirEntries(current);
		const entry = entries.find(e => e.name === name);
		if (entry) {
			if (file && entry.isFile()) return path.join(current, name);
			if (dir && entry.isDirectory()) return path.join(current, name);
		}
		const parent = path.dirname(current);
		if (parent === current) return null; // 已到达文件系统根目录
		current = parent;
	}
}

/**
 * Walk up from startDir looking for a `.git` entry (file or directory).
 * Returns the directory containing `.git` (the repo root), or null if not in a git repo.
 * Results are based on the cached readDirEntries, so repeated calls are cheap.
 * 从起始目录向上查找 `.git` 条目（文件或目录）。
 * 返回包含 `.git` 的目录（即仓库根目录），不在 git 仓库中时返回 null。
 * 基于缓存的 readDirEntries，重复调用开销很小。
 */
export async function findRepoRoot(startDir: string): Promise<string | null> {
	let current = resolvePath(startDir);
	while (true) {
		const entries = await readDirEntries(current);
		if (entries.some(e => e.name === ".git")) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return null; // 已到达文件系统根目录
		current = parent;
	}
}

/**
 * 获取缓存统计信息。
 * 返回文件内容缓存和目录缓存的条目数。
 */
export function cacheStats(): { content: number; dir: number } {
	return {
		content: contentCache.size,
		dir: dirCache.size,
	};
}

/** 清除所有缓存 */
export function clearCache(): void {
	contentCache.clear();
	dirCache.clear();
}

/**
 * 使指定路径的缓存失效。
 * 同时清除该路径的父目录缓存，以确保目录列表的一致性。
 */
export function invalidate(filePath: string): void {
	const abs = resolvePath(filePath);
	contentCache.delete(abs);
	dirCache.delete(abs);
	const parent = path.dirname(abs);
	if (parent !== abs) {
		dirCache.delete(parent);
	}
}


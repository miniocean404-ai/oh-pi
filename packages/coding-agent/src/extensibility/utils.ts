
import * as path from "node:path";
import { theme } from "../modes/theme/theme";
import { expandPath, normalizeLocalScheme } from "../tools/path-utils";
import type { HookUIContext } from "./hooks/types";

/**
 * Resolve a file path:
 * - Absolute paths used as-is
 * - Paths starting with ~ expanded to home directory
 * - Relative paths resolved from cwd
 *
 * 解析文件路径：
 * - 绝对路径原样使用
 * - 以 ~ 开头的路径展开为 home 目录
 * - 相对路径以 cwd 为基础解析
 */
export function resolvePath(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	const expandedAndNormalized = normalizeLocalScheme(expanded);
	if (expandedAndNormalized.startsWith("local://")) {
		throw new Error(
			`Path "${filePath}" uses internal scheme "local://" and must be resolved through the proper protocol handler, not as a filesystem path.`,
		);
	}
	if (path.isAbsolute(expanded)) {
		return expanded;
	}
	return path.resolve(cwd, expanded);
}

/**
 * Create a no-op UI context for headless modes.
 *
 * 为 headless（无 UI）模式创建一个空操作的 UI 上下文。
 */
export function createNoOpUIContext(): HookUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		setStatus: () => {},
		custom: async () => undefined as never,
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		get theme() {
			return theme;
		},
	};
}



/**
 * 编辑模式工具的共享文件读取辅助函数。
 *
 * 通过 Bun 读取文件，并将 ENOENT 错误重新抛出为
 * 引用显示路径的用户友好 "File not found" 错误。
 *
 * Shared file-read helper for edit-mode utilities.
 *
 * Reads a file via Bun and rethrows ENOENT as a user-facing "File not found"
 * error referencing the display path.
 */
import { isEnoent } from "@oh-my-pi/pi-utils";
import { isNotebookPath, readEditableNotebookText, serializeEditedNotebookText } from "./notebook";

/** 读取编辑文件的文本内容（自动处理 Notebook 格式） */
export async function readEditFileText(absolutePath: string, path: string): Promise<string> {
	try {
		if (isNotebookPath(absolutePath)) return await readEditableNotebookText(absolutePath, path);
		return await Bun.file(absolutePath).text();
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`File not found: ${path}`);
		}
		throw error;
	}
}

/** 序列化编辑后的文件文本（自动处理 Notebook 格式） */
export async function serializeEditFileText(absolutePath: string, path: string, content: string): Promise<string> {
	if (isNotebookPath(absolutePath)) return serializeEditedNotebookText(absolutePath, path, content);
	return content;
}


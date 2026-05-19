
/**
 * Codex `apply_patch` 信封格式的解析器。
 *
 * 输入是完整的信封文本（可选 heredoc 包装）。输出是 `PatchInput` 记录列表，
 * 每条记录可直接传递给 `../modes/patch.ts` 中的单文件 `applyPatch()`。
 *
 * 根据规范 §4.3 宽松模式：解析前会剥离整个信封周围的
 * `<<EOF` / `<<'EOF'` / `<<"EOF"` heredoc 包装。
 *
 * Parser for the Codex `apply_patch` envelope format.
 *
 *     *** Begin Patch
 *     *** Add File: <path>
 *     +<line>
 *     *** Delete File: <path>
 *     *** Update File: <path>
 *     *** Move to: <newpath>
 *     @@ <optional context>
 *     -old
 *     +new
 *      context
 *     *** End of File
 *     *** End Patch
 *
 * Input is the full envelope text (optionally heredoc-wrapped). Output is a
 * list of `PatchInput` records, each ready to hand to the existing
 * single-file `applyPatch()` in `../modes/patch.ts`.
 *
 * Per spec §4.3 Lenient mode: a `<<EOF` / `<<'EOF'` / `<<"EOF"` heredoc
 * wrapper around the whole envelope is stripped before parsing.
 */

import { ParseError } from "../diff";
import type { PatchInput } from "../modes/patch";

// 信封格式标记常量
const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";

/** 解析选项 */
interface ParseApplyPatchOptions {
	streaming?: boolean;
}

/**
 * 将 Codex `*** Begin Patch` 信封解析为单文件补丁输入列表。
 *
 * Parse a Codex `*** Begin Patch` envelope into a list of single-file
 * patch inputs.
 */
export function parseApplyPatch(patchText: string): PatchInput[] {
	return parseApplyPatchWithOptions(patchText, {});
}

/**
 * 用于 TUI 预览的尽力解析器。容忍缺失的信封标记和不完整的尾部块；
 * 不要用它来应用编辑。
 *
 * Best-effort parser for in-progress TUI previews. It tolerates missing
 * envelope markers and incomplete trailing hunks; do not use it to apply edits.
 */
export function parseApplyPatchStreaming(patchText: string): PatchInput[] {
	return parseApplyPatchWithOptions(patchText, { streaming: true });
}

/** 带选项的补丁解析实现 */
function parseApplyPatchWithOptions(patchText: string, options: ParseApplyPatchOptions): PatchInput[] {
	const streaming = options.streaming === true;
	let lines = patchText.trim().split("\n");

	// 宽松 heredoc 剥离：<<EOF / <<'EOF' / <<"EOF" ... EOF
	if (lines.length >= 2) {
		const first = lines[0];
		const last = lines[lines.length - 1].trim();
		const validOpeners = new Set(["<<EOF", "<<'EOF'", '<<"EOF"']);
		if (validOpeners.has(first) && last === "EOF") {
			lines = lines.slice(1, lines.length - 1);
		}
	}

	if (lines.length === 0 || lines[0].trim() !== BEGIN_PATCH_MARKER) {
		if (streaming) return [];
		throw new ParseError("The first line of the patch must be '*** Begin Patch'");
	}
	const hasEndMarker = lines[lines.length - 1].trim() === END_PATCH_MARKER;
	if (!hasEndMarker && !streaming) {
		throw new ParseError("The last line of the patch must be '*** End Patch'");
	}

	const hunks: PatchInput[] = [];
	let remaining = hasEndMarker ? lines.slice(1, lines.length - 1) : lines.slice(1);
	// 行号从 1 开始，包含 `*** Begin Patch` 行（= 1）
	let lineNumber = 2;

	while (remaining.length > 0) {
		// 块之间的空白分隔行被忽略（规范 §3.3）
		if (remaining[0].trim() === "") {
			remaining = remaining.slice(1);
			lineNumber++;
			continue;
		}

		const firstLine = remaining[0].trim();

		if (firstLine.startsWith(ADD_FILE_MARKER)) {
			const path = firstLine.slice(ADD_FILE_MARKER.length);
			let contents = "";
			let consumed = 1;

			for (let i = 1; i < remaining.length; i++) {
				const line = remaining[i];
				if (line.startsWith("+")) {
					contents += `${line.slice(1)}\n`;
					consumed++;
				} else {
					break;
				}
			}

			hunks.push({ path, op: "create", diff: contents });
			remaining = remaining.slice(consumed);
			lineNumber += consumed;
			continue;
		}

		if (firstLine.startsWith(DELETE_FILE_MARKER)) {
			const path = firstLine.slice(DELETE_FILE_MARKER.length);
			hunks.push({ path, op: "delete" });
			remaining = remaining.slice(1);
			lineNumber++;
			continue;
		}

		if (firstLine.startsWith(UPDATE_FILE_MARKER)) {
			const path = firstLine.slice(UPDATE_FILE_MARKER.length);
			remaining = remaining.slice(1);
			lineNumber++;

			let movePath: string | undefined;
			if (remaining.length > 0 && remaining[0].startsWith(MOVE_TO_MARKER)) {
				movePath = remaining[0].slice(MOVE_TO_MARKER.length);
				remaining = remaining.slice(1);
				lineNumber++;
			}

			// 正文持续到下一个文件操作标记或输入结束。
			// `*** End of File` 是块终止符，留在正文内——
			// 下游的统一差异解析器会处理它。
			const diffLines: string[] = [];
			while (remaining.length > 0) {
				const line = remaining[0];
				if (
					line.startsWith("*** Add File:") ||
					line.startsWith("*** Delete File:") ||
					line.startsWith("*** Update File:")
				) {
					break;
				}
				diffLines.push(line);
				remaining = remaining.slice(1);
				lineNumber++;
			}

			if (diffLines.length === 0) {
				if (streaming) {
					hunks.push({ path, op: "update", rename: movePath, diff: "" });
					continue;
				}
				throw new ParseError(`Update file hunk for path '${path}' is empty`, lineNumber);
			}

			hunks.push({ path, op: "update", rename: movePath, diff: diffLines.join("\n") });
			continue;
		}

		if (streaming) {
			break;
		}
		throw new ParseError(
			`'${firstLine}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
			lineNumber,
		);
	}

	return hunks;
}


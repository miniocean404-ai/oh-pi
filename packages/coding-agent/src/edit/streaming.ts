
/**
 * 流式编辑预览策略。
 *
 * 每种编辑模式拥有一个策略，负责：
 * - 将部分 JSON 参数折叠到可安全预览的子集（`extractCompleteEdits`）
 * - 为正在传输的参数计算统一差异预览（`computeDiffPreview`）
 * - 在差异尚未生成时渲染文本占位符（`renderStreamingFallback`）
 *
 * 共享渲染器 / `ToolExecutionComponent` 通过注入的 `editMode` 咨询策略，
 * 而非探测参数形状。
 *
 * Streaming edit preview strategies.
 *
 * Each edit mode owns a strategy that knows how to:
 * - collapse partial-JSON args to the subset safe to preview
 *   (`extractCompleteEdits`),
 * - compute unified diff previews for the in-flight args
 *   (`computeDiffPreview`), and
 * - render a text placeholder while no diff exists yet
 *   (`renderStreamingFallback`).
 *
 * The shared renderer / `ToolExecutionComponent` consult the strategy via
 * the injected `editMode` rather than probing argument shape.
 */

import { sanitizeText } from "@oh-my-pi/pi-utils";
import {
	ABORT_MARKER,
	BEGIN_PATCH_MARKER,
	computeHashlineDiff,
	computeHashlineSectionDiff,
	containsRecognizableHashlineOperations,
	END_PATCH_MARKER,
	type HashlineInputSection,
	splitHashlineInputs,
} from "../hashline";
import type { Theme } from "../modes/theme/theme";
import { replaceTabs, truncateToWidth } from "../tools/render-utils";
import { type EditMode, resolveEditMode } from "../utils/edit-mode";
import { computeEditDiff, type DiffError, type DiffResult } from "./diff";
import { type ApplyPatchEntry, expandApplyPatchToEntries, expandApplyPatchToPreviewEntries } from "./modes/apply-patch";
import { computePatchDiff, type PatchEditEntry } from "./modes/patch";
import type { ReplaceEditEntry } from "./modes/replace";

/** 每个文件的差异预览 */
export interface PerFileDiffPreview {
	path: string;
	diff?: string;
	firstChangedLine?: number;
	error?: string;
}

/** 流式差异计算上下文 */
export interface StreamingDiffContext {
	cwd: string;
	signal: AbortSignal;
	fuzzyThreshold?: number;
	allowFuzzy?: boolean;
	hashlineAutoDropPureInsertDuplicates?: boolean;
}

/** 编辑流式预览策略接口 */
export interface EditStreamingStrategy<Args = unknown> {
	/**
	 * 返回限制为"足够完整"以计算差异的参数。
	 * 当 `partialJson` 表明尾部 `}` 尚未到达时，策略会丢弃末尾的不完整条目。
	 *
	 * Return the args restricted to edits that are "complete enough" to
	 * compute a diff against. Strategies drop the trailing incomplete entry
	 * when `partialJson` indicates its closing `}` hasn't arrived yet.
	 */
	extractCompleteEdits(args: Args, partialJson: string | undefined): Args;
	/**
	 * 为给定的部分参数计算差异。当参数结构不足以计算时返回 `null`。
	 *
	 * Compute diff(s) for the given partial args. Returns `null` when args
	 * do not yet carry enough structure to compute anything.
	 */
	computeDiffPreview(args: Args, ctx: StreamingDiffContext): Promise<PerFileDiffPreview[] | null>;
	/**
	 * 在差异尚未计算时（或计算返回 `null` 因为参数仍然不完整时）
	 * 内联渲染的占位内容。
	 *
	 * Rendered inline while the diff hasn't been computed yet (or when the
	 * compute returned `null` because args are still too partial).
	 */
	renderStreamingFallback(args: Args, uiTheme: Theme): string;
}

const STREAMING_FALLBACK_LINES = 12;
const STREAMING_FALLBACK_WIDTH = 80;

/** 判断是否为 hashline 头部行 */
function isHashlineHeaderLine(line: string): boolean {
	const trimmed = line.trimEnd();
	return trimmed.startsWith("@") && trimmed.length > 1;
}

/** 判断是否为 hashline 信封标记行 */
function isHashlineEnvelopeMarkerLine(line: string): boolean {
	const trimmed = line.trimEnd();
	return trimmed === BEGIN_PATCH_MARKER || trimmed === END_PATCH_MARKER || trimmed === ABORT_MARKER;
}

/** 裁剪 hashline 流式语法标记 */
function trimHashlineStreamingSyntax(lines: string[]): string[] {
	let index = lines.findIndex(line => line.trim().length > 0);
	if (index === -1) return [];

	if (lines[index].trimEnd() === BEGIN_PATCH_MARKER) {
		index++;
		while (index < lines.length && lines[index].trim().length === 0) index++;
	}
	if (index < lines.length && isHashlineHeaderLine(lines[index])) {
		index++;
	}

	return lines.slice(index).filter(line => !isHashlineEnvelopeMarkerLine(line));
}

/** 渲染 hashline 输入的回退预览 */
function renderHashlineInputFallback(input: string, uiTheme: Theme): string {
	const lines = trimHashlineStreamingSyntax(sanitizeText(input).split("\n"));
	if (!lines.some(line => line.trim().length > 0)) return "";

	const displayLines = lines.slice(-STREAMING_FALLBACK_LINES);
	const hidden = lines.length - displayLines.length;
	let text = "\n\n";
	text += displayLines
		.map(line => uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(line), STREAMING_FALLBACK_WIDTH)))
		.join("\n");
	if (hidden > 0) {
		text += uiTheme.fg("dim", `\n… (streaming +${hidden} lines)`);
	} else {
		text += uiTheme.fg("dim", "\n(streaming)");
	}
	return text;
}

// -----------------------------------------------------------------------------
// 部分 JSON 处理
// -----------------------------------------------------------------------------

/**
 * 给定从部分 JSON 解析的编辑数组，当 `partialJson` 中对应的对象
 * 尚未以闭合的 `}` 结束时，丢弃最后一个条目。
 *
 * 防止 `partial-json` 静默将截断的尾部（如 `"write":nu` / `"write":nul`）
 * 强制转换为 `{ write: null }`，导致最后一个条目在值完成流式传输前
 * 渲染出虚假的 null-write 错误。
 *
 * Given an edits array parsed from partial JSON, drop the last entry when the
 * corresponding object in `partialJson` does not yet end with a closed `}`.
 *
 * This guards against `partial-json` silently coercing truncated tails like
 * `"write":nu` / `"write":nul` into `{ write: null }`, which would make the
 * last entry render a spurious null-write error until the value finishes
 * streaming.
 */
export function dropIncompleteLastEdit<T>(edits: readonly T[], partialJson: string | undefined, listKey: string): T[] {
	if (!Array.isArray(edits) || edits.length === 0) return [...(edits ?? [])];
	if (!partialJson) return [...edits];

	const keyMarker = `"${listKey}"`;
	const keyIdx = partialJson.indexOf(keyMarker);
	if (keyIdx === -1) return [...edits];

	// Find the `[` that opens the list value.
	let i = partialJson.indexOf("[", keyIdx + keyMarker.length);
	if (i === -1) return [...edits];
	i++;

	let depth = 0;
	let inString = false;
	let escaped = false;
	let lastClose = -1;
	for (; i < partialJson.length; i++) {
		const ch = partialJson[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			if (inString) escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{" || ch === "[") {
			depth++;
		} else if (ch === "}" || ch === "]") {
			depth--;
			if (ch === "}" && depth === 0) {
				lastClose = i;
			}
			if (ch === "]" && depth === -1) {
				// End of list reached.
				break;
			}
		}
	}

	// If we're still inside the list and saw no closing `}` for the last entry,
	// or there is trailing non-whitespace after the last `}` before the list
	// ended (i.e. a new object has opened), drop the trailing entry.
	const tail = lastClose === -1 ? partialJson.slice(i) : partialJson.slice(lastClose + 1);
	const sawNewObjectAfterLastClose = /\{/.test(tail);
	const listIsStillOpen = depth >= 0;

	if (lastClose === -1 || (listIsStillOpen && sawNewObjectAfterLastClose)) {
		return edits.slice(0, -1);
	}
	return [...edits];
}

// -----------------------------------------------------------------------------
// apply_patch 保持多文件模式，因为 Codex 信封每个块携带路径。
// -----------------------------------------------------------------------------

/** 按文件路径分组 apply_patch 条目 */
function groupApplyPatchEntriesByPath(entries: readonly ApplyPatchEntry[]): Map<string, ApplyPatchEntry[]> {
	const groups = new Map<string, ApplyPatchEntry[]>();

	for (const entry of entries) {
		let bucket = groups.get(entry.path);
		if (!bucket) {
			bucket = [];
			groups.set(entry.path, bucket);
		}
		bucket.push(entry);
	}
	return groups;
}

// -----------------------------------------------------------------------------
// 策略实现
// -----------------------------------------------------------------------------

interface ReplaceArgs {
	path?: string;
	edits?: ReplaceEditEntry[];
	__partialJson?: string;
}

/** 替换模式的流式预览策略 */
const replaceStrategy: EditStreamingStrategy<ReplaceArgs> = {
	extractCompleteEdits(args, partialJson) {
		if (!args?.edits) return args;
		return { ...args, edits: dropIncompleteLastEdit(args.edits, partialJson, "edits") };
	},
	async computeDiffPreview(args, ctx) {
		if (!args.path) return null;
		const first = args.edits?.[0];
		if (!first || first.old_text === undefined || first.new_text === undefined) return null;
		ctx.signal.throwIfAborted();
		const result = await computeEditDiff(
			args.path,
			first.old_text,
			first.new_text,
			ctx.cwd,
			ctx.allowFuzzy ?? true,
			first.all,
			ctx.fuzzyThreshold,
		);
		ctx.signal.throwIfAborted();
		return [toPerFilePreview(args.path, result)];
	},
	renderStreamingFallback() {
		return "";
	},
};

interface PatchArgs {
	path?: string;
	edits?: PatchEditEntry[];
	__partialJson?: string;
}

/** 补丁模式的流式预览策略 */
const patchStrategy: EditStreamingStrategy<PatchArgs> = {
	extractCompleteEdits(args, partialJson) {
		if (!args?.edits) return args;
		return { ...args, edits: dropIncompleteLastEdit(args.edits, partialJson, "edits") };
	},
	async computeDiffPreview(args, ctx) {
		if (!args.path) return null;
		const first = args.edits?.[0];
		if (!first) return null;
		ctx.signal.throwIfAborted();
		const result = await computePatchDiff(
			{ path: args.path, op: first.op ?? "update", rename: first.rename, diff: first.diff },
			ctx.cwd,
			{ fuzzyThreshold: ctx.fuzzyThreshold, allowFuzzy: ctx.allowFuzzy },
		);
		ctx.signal.throwIfAborted();
		return [toPerFilePreview(args.path, result)];
	},
	renderStreamingFallback() {
		return "";
	},
};

interface HashlineArgs {
	input?: string;
	path?: string;
	__partialJson?: string;
}

/** hashline 模式的流式预览策略 */
const hashlineStrategy: EditStreamingStrategy<HashlineArgs> = {
	extractCompleteEdits(args) {
		return args;
	},
	async computeDiffPreview(args, ctx) {
		if (typeof args.input !== "string" || args.input.length === 0) return null;
		ctx.signal.throwIfAborted();

		let sections: HashlineInputSection[];
		try {
			sections = splitHashlineInputs(args.input, { cwd: ctx.cwd, path: args.path });
		} catch {
			// Single-section fallback keeps the original error rendering for the
			// "haven't typed `@@ PATH` yet" case.
			const result = await computeHashlineDiff({ input: args.input, path: args.path }, ctx.cwd, {
				autoDropPureInsertDuplicates: ctx.hashlineAutoDropPureInsertDuplicates,
			});
			ctx.signal.throwIfAborted();
			if ("error" in result && !args.path) return [{ path: "", error: result.error }];
			return [toPerFilePreview(args.path ?? "", result)];
		}
		if (sections.length === 0) return null;

		// While the trailing section is still being typed (no operations yet)
		// skip it so its empty/parse-error result doesn't replace previews of
		// already-completed sections with an opaque header.
		const lastIndex = sections.length - 1;
		const trailingIncomplete =
			sections.length > 1 && !containsRecognizableHashlineOperations(sections[lastIndex].diff);
		const sectionsToProcess = trailingIncomplete ? sections.slice(0, -1) : sections;
		const trailingProcessedIndex = sectionsToProcess.length - 1;

		const previews: PerFileDiffPreview[] = [];
		for (let i = 0; i < sectionsToProcess.length; i++) {
			ctx.signal.throwIfAborted();
			const section = sectionsToProcess[i];
			const result = await computeHashlineSectionDiff(section, ctx.cwd, {
				autoDropPureInsertDuplicates: ctx.hashlineAutoDropPureInsertDuplicates,
			});
			ctx.signal.throwIfAborted();
			// In a multi-section preview, ignore parse/apply errors from the
			// last section: it's still streaming and the partial op may not
			// parse yet. Earlier sections are stable and stay rendered.
			if (sectionsToProcess.length > 1 && i === trailingProcessedIndex && "error" in result) {
				continue;
			}
			previews.push(toPerFilePreview(section.path, result));
		}
		return previews.length > 0 ? previews : null;
	},
	renderStreamingFallback(args, uiTheme) {
		return typeof args.input === "string" ? renderHashlineInputFallback(args.input, uiTheme) : "";
	},
};

interface ApplyPatchArgs {
	input?: string;
}

/** apply_patch 模式的流式预览策略 */
const applyPatchStrategy: EditStreamingStrategy<ApplyPatchArgs> = {
	extractCompleteEdits(args) {
		// apply_patch 负载是纯文本而非编辑数组，无需裁剪
		return args;
	},
	async computeDiffPreview(args, ctx) {
		if (typeof args.input !== "string" || args.input.length === 0) return null;
		let entries: ApplyPatchEntry[];
		try {
			entries = expandApplyPatchToEntries({ input: args.input });
		} catch {
			try {
				entries = expandApplyPatchToPreviewEntries({ input: args.input });
			} catch (err) {
				return [{ path: "", error: err instanceof Error ? err.message : String(err) }];
			}
		}
		const groups = groupApplyPatchEntriesByPath(entries);
		if (groups.size === 0) return null;
		const previews: PerFileDiffPreview[] = [];
		for (const [path, fileEntries] of groups) {
			const first = fileEntries[0];
			if (!first) continue;
			ctx.signal.throwIfAborted();
			const result = await computePatchDiff(
				{ path, op: first.op ?? "update", rename: first.rename, diff: first.diff },
				ctx.cwd,
				{ fuzzyThreshold: ctx.fuzzyThreshold, allowFuzzy: ctx.allowFuzzy },
			);
			ctx.signal.throwIfAborted();
			previews.push(toPerFilePreview(path, result));
		}
		return previews.length > 0 ? previews : null;
	},
	renderStreamingFallback() {
		return "";
	},
};

// Vim 流式预览由 edit/renderer.ts 中的 vimToolRenderer 处理。
// 此处策略为空操作，确保注册表完整。
const vimStrategy: EditStreamingStrategy<unknown> = {
	extractCompleteEdits(args) {
		return args;
	},
	async computeDiffPreview() {
		return null;
	},
	renderStreamingFallback() {
		return "";
	},
};

/** 各编辑模式对应的流式预览策略注册表 */
export const EDIT_MODE_STRATEGIES: Record<EditMode, EditStreamingStrategy<unknown>> = {
	replace: replaceStrategy as EditStreamingStrategy<unknown>,
	patch: patchStrategy as EditStreamingStrategy<unknown>,
	hashline: hashlineStrategy as EditStreamingStrategy<unknown>,
	apply_patch: applyPatchStrategy as EditStreamingStrategy<unknown>,
	vim: vimStrategy,
};

export { resolveEditMode };

// -----------------------------------------------------------------------------
// 辅助函数
// -----------------------------------------------------------------------------

/** 将差异结果转换为每文件预览格式 */
function toPerFilePreview(path: string, result: DiffResult | DiffError): PerFileDiffPreview {
	if ("error" in result) {
		return { path, error: result.error };
	}
	return { path, diff: result.diff, firstChangedLine: result.firstChangedLine };
}



/**
 * Codex `apply_patch` 信封格式的编辑模式包装器。
 *
 * 该模式接受包含完整 `*** Begin Patch ... *** End Patch` 块的
 * 单个 `input` 字符串，解析后分发到 `executePatchSingle`——
 * 因此所有机制（计划模式、LSP 写入透传、文件系统缓存失效、诊断）
 * 与 `patch` 模式共享。
 *
 * Edit mode wrapper for the Codex `apply_patch` envelope format.
 *
 * The mode accepts a single `input` string containing a full
 * `*** Begin Patch ... *** End Patch` block, parses it, and fans out to
 * the existing `executePatchSingle` — so all the machinery (plan mode,
 * LSP writethrough, fs-cache invalidation, diagnostics) is shared with
 * the `patch` mode.
 */

import * as z from "zod/v4";
import { parseApplyPatch, parseApplyPatchStreaming } from "../apply-patch/parser";
import { ApplyPatchError } from "../diff";
import type { PatchEditEntry } from "./patch";

/** apply_patch 输入参数 schema */
export const applyPatchSchema = z.object({
	input: z.string().describe("apply_patch envelope"),
});

/** apply_patch 参数类型 */
export type ApplyPatchParams = z.infer<typeof applyPatchSchema>;

/** apply_patch 条目（补丁编辑条目 + 文件路径） */
export type ApplyPatchEntry = PatchEditEntry & { path: string };

/**
 * 解析信封并将每个块降级为 `PatchEditEntry`，
 * 以便通过 `executePatchSingle` 路由。
 *
 * Parse the envelope and lower each hunk to a `PatchEditEntry` so it can
 * be routed through `executePatchSingle`.
 */
export function expandApplyPatchToEntries(params: ApplyPatchParams): ApplyPatchEntry[] {
	const hunks = parseApplyPatch(params.input);
	if (hunks.length === 0) {
		throw new ApplyPatchError("No files were modified.");
	}
	return hunks.map(
		(h): ApplyPatchEntry => ({
			path: h.path,
			op: h.op,
			rename: h.rename,
			diff: h.diff,
		}),
	);
}

/** 将 apply_patch 参数展开为预览条目（容错模式，用于流式预览） */
export function expandApplyPatchToPreviewEntries(params: ApplyPatchParams): ApplyPatchEntry[] {
	const hunks = parseApplyPatchStreaming(params.input);
	return hunks.map(
		(h): ApplyPatchEntry => ({
			path: h.path,
			op: h.op,
			rename: h.rename,
			diff: h.diff,
		}),
	);
}


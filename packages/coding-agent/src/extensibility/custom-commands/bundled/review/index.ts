
/**
 * /review command - Interactive code review launcher
 *
 * Provides a menu to select review mode:
 * 1. Review against a base branch (PR style)
 * 2. Review uncommitted changes
 * 3. Review a specific commit
 * 4. Custom review instructions
 *
 * Runs git diff upfront, parses results, filters noise, and provides
 * rich context for the orchestrating agent to distribute work across
 * multiple reviewer agents based on diff weight and locality.
 *
 * /review 命令 —— 交互式代码评审入口
 *
 * 提供菜单选择评审模式：
 * 1. 与基线分支对比（PR 风格）
 * 2. 评审未提交的变更
 * 3. 评审指定 commit
 * 4. 自定义评审说明
 *
 * 命令会先运行 git diff、解析结果、过滤噪声文件，
 * 并基于变更体量与文件局部性，为编排 agent 提供丰富上下文，
 * 以便将工作分发给多个 reviewer 子 agent。
 */
import { prompt } from "@oh-my-pi/pi-utils";
import type { CustomCommand, CustomCommandAPI } from "../../../../extensibility/custom-commands/types";
import type { HookCommandContext } from "../../../../extensibility/hooks/types";
import reviewRequestTemplate from "../../../../prompts/review-request.md" with { type: "text" };
import * as git from "../../../../utils/git";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

/** 单文件 diff 摘要：路径、增删行数与原始 hunks 文本 */
interface FileDiff {
	path: string;
	linesAdded: number;
	linesRemoved: number;
	hunks: string;
}

/** Diff 统计信息（包含被过滤掉的文件） */
interface DiffStats {
	files: FileDiff[];
	totalAdded: number;
	totalRemoved: number;
	excluded: { path: string; reason: string; linesAdded: number; linesRemoved: number }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Exclusion patterns for noise files
// 噪声文件的过滤规则
// ─────────────────────────────────────────────────────────────────────────────

/** 用于过滤掉对代码评审无价值的文件（锁文件、生成产物、二进制资源等） */
const EXCLUDED_PATTERNS: { pattern: RegExp; reason: string }[] = [
	// Lock files
	// 各类包管理器锁文件
	{ pattern: /\.lock$/, reason: "lock file" },
	{ pattern: /-lock\.(json|yaml|yml)$/, reason: "lock file" },
	{ pattern: /package-lock\.json$/, reason: "lock file" },
	{ pattern: /yarn\.lock$/, reason: "lock file" },
	{ pattern: /pnpm-lock\.yaml$/, reason: "lock file" },
	{ pattern: /Cargo\.lock$/, reason: "lock file" },
	{ pattern: /Gemfile\.lock$/, reason: "lock file" },
	{ pattern: /poetry\.lock$/, reason: "lock file" },
	{ pattern: /composer\.lock$/, reason: "lock file" },
	{ pattern: /flake\.lock$/, reason: "lock file" },

	// Generated/build artifacts
	// 生成 / 构建产物
	{ pattern: /\.min\.(js|css)$/, reason: "minified" },
	{ pattern: /\.generated\./, reason: "generated" },
	{ pattern: /\.snap$/, reason: "snapshot" },
	{ pattern: /\.map$/, reason: "source map" },
	{ pattern: /^dist\//, reason: "build output" },
	{ pattern: /^build\//, reason: "build output" },
	{ pattern: /^out\//, reason: "build output" },
	{ pattern: /node_modules\//, reason: "vendor" },
	{ pattern: /vendor\//, reason: "vendor" },

	// Binary/assets (usually shown as binary in diff anyway)
	// 二进制 / 资源文件（diff 中通常也只显示为二进制）
	{ pattern: /\.(png|jpg|jpeg|gif|ico|webp|avif)$/i, reason: "image" },
	{ pattern: /\.(woff|woff2|ttf|eot|otf)$/i, reason: "font" },
	{ pattern: /\.(pdf|zip|tar|gz|rar|7z)$/i, reason: "binary" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Diff parsing
// Diff 解析
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a file path should be excluded from review.
 * Returns the exclusion reason if excluded, undefined otherwise.
 *
 * 检查文件路径是否应被排除在评审范围之外，
 * 若被排除则返回排除原因，否则返回 undefined。
 */
function getExclusionReason(path: string): string | undefined {
	for (const { pattern, reason } of EXCLUDED_PATTERNS) {
		if (pattern.test(path)) return reason;
	}
	return undefined;
}

/**
 * Parse unified diff output into per-file stats.
 * Splits on file boundaries, counts +/- lines, and filters excluded files.
 *
 * 将 unified diff 输出解析为按文件聚合的统计信息：
 * 按文件边界切分、统计 +/- 行数，并过滤被排除的文件。
 */
function parseDiff(diffOutput: string): DiffStats {
	const files: FileDiff[] = [];
	const excluded: DiffStats["excluded"] = [];
	let totalAdded = 0;
	let totalRemoved = 0;

	// Split by file boundary: "diff --git a/... b/..."
	// 按 "diff --git" 行切分每个文件 chunk
	const fileChunks = diffOutput.split(/^diff --git /m).filter(Boolean);

	for (const chunk of fileChunks) {
		// Extract file path from "a/path b/path" line
		// 从 "a/path b/path" 行中提取文件路径
		const headerMatch = chunk.match(/^a\/(.+?) b\/(.+)/);
		if (!headerMatch) continue;

		const path = headerMatch[2];

		// Count added/removed lines (lines starting with + or - but not ++ or --)
		// 统计增删行数（排除 +++/--- 文件头）
		let linesAdded = 0;
		let linesRemoved = 0;

		const lines = chunk.split("\n");
		for (const line of lines) {
			if (line.startsWith("+") && !line.startsWith("+++")) {
				linesAdded++;
			} else if (line.startsWith("-") && !line.startsWith("---")) {
				linesRemoved++;
			}
		}

		const exclusionReason = getExclusionReason(path);
		if (exclusionReason) {
			excluded.push({ path, reason: exclusionReason, linesAdded, linesRemoved });
		} else {
			files.push({
				path,
				linesAdded,
				linesRemoved,
				hunks: `diff --git ${chunk}`,
			});
			totalAdded += linesAdded;
			totalRemoved += linesRemoved;
		}
	}

	return { files, totalAdded, totalRemoved, excluded };
}

/**
 * Get file extension for display purposes.
 * 提取文件扩展名用于展示。
 */
function getFileExt(path: string): string {
	const match = path.match(/\.([^.]+)$/);
	return match ? match[1] : "";
}

/**
 * Determine recommended number of reviewer agents based on diff weight.
 * Uses total lines changed as the primary metric.
 *
 * 根据 diff 体量推荐 reviewer agent 的数量，
 * 主要以变更总行数作为度量指标。
 */
function getRecommendedAgentCount(stats: DiffStats): number {
	const totalLines = stats.totalAdded + stats.totalRemoved;
	const fileCount = stats.files.length;

	// Heuristics:
	// - Tiny (<100 lines or 1-2 files): 1 agent
	// - Small (<500 lines): 1-2 agents
	// - Medium (<2000 lines): 2-4 agents
	// - Large (<5000 lines): 4-8 agents
	// - Huge (>5000 lines): 8-16 agents
	//
	// 启发式规则：
	// - 极小（<100 行或仅 1-2 个文件）：1 个 agent
	// - 小型（<500 行）：1-2 个 agent
	// - 中型（<2000 行）：2-4 个 agent
	// - 大型（<5000 行）：4-8 个 agent
	// - 超大（>5000 行）：8-16 个 agent

	if (totalLines < 100 || fileCount <= 2) return 1;
	if (totalLines < 500) return Math.min(2, fileCount);
	if (totalLines < 2000) return Math.min(4, Math.ceil(fileCount / 3));
	if (totalLines < 5000) return Math.min(8, Math.ceil(fileCount / 2));
	return Math.min(16, fileCount);
}

/**
 * Extract first N lines of actual diff content (excluding headers) for preview.
 * 从 diff 中抽取前 N 行真实内容（剔除头部）用于预览展示。
 */
function getDiffPreview(hunks: string, maxLines: number): string {
	const lines = hunks.split("\n");
	const contentLines: string[] = [];

	for (const line of lines) {
		// Skip diff headers, keep actual content
		// 跳过 diff 头部，仅保留真实内容
		if (
			line.startsWith("diff --git") ||
			line.startsWith("index ") ||
			line.startsWith("---") ||
			line.startsWith("+++") ||
			line.startsWith("@@")
		) {
			continue;
		}
		contentLines.push(line);
		if (contentLines.length >= maxLines) break;
	}

	return contentLines.join("\n");
}

// Thresholds for diff inclusion
// 控制是否在 prompt 中内联完整 diff 的阈值
const MAX_DIFF_CHARS = 50_000; // Don't include diff above this  超过此字符数则不内联完整 diff
const MAX_FILES_FOR_INLINE_DIFF = 20; // Don't include diff if more files than this  超过此文件数也不内联

/**
 * Build the full review prompt with diff stats and distribution guidance.
 * 基于 diff 统计与分发建议，构建完整的评审 prompt。
 */
function buildReviewPrompt(mode: string, stats: DiffStats, rawDiff: string, additionalInstructions?: string): string {
	const agentCount = getRecommendedAgentCount(stats);
	// 体量过大时不内联完整 diff，仅给出预览
	const skipDiff = rawDiff.length > MAX_DIFF_CHARS || stats.files.length > MAX_FILES_FOR_INLINE_DIFF;
	const totalLines = stats.totalAdded + stats.totalRemoved;
	// 当跳过完整 diff 时，估算每个文件保留的预览行数
	const linesPerFile = skipDiff ? Math.max(5, Math.floor(100 / stats.files.length)) : 0;

	const filesWithExt = stats.files.map(f => ({
		...f,
		ext: getFileExt(f.path),
		hunksPreview: skipDiff ? getDiffPreview(f.hunks, linesPerFile) : "",
	}));

	return prompt.render(reviewRequestTemplate, {
		mode,
		files: filesWithExt,
		excluded: stats.excluded,
		totalAdded: stats.totalAdded,
		totalRemoved: stats.totalRemoved,
		totalLines,
		agentCount,
		multiAgent: agentCount > 1,
		skipDiff,
		rawDiff: rawDiff.trim(),
		linesPerFile,
		additionalInstructions,
	});
}

/**
 * /review 命令实现：弹出交互菜单选择评审模式，
 * 在 PR 风格、未提交变更、指定 commit、自定义说明四种模式间分发，
 * 并构造发送给 reviewer agent 的最终 prompt。
 */
export class ReviewCommand implements CustomCommand {
	name = "review";
	description = "Launch interactive code review";

	constructor(private api: CustomCommandAPI) {}

	async execute(args: string[], ctx: HookCommandContext): Promise<string | undefined> {
		// 无 UI 环境（如 print/RPC 模式）下退化为基本指令
		if (!ctx.hasUI) {
			const base = "Use the Task tool to run the 'reviewer' agent to review recent code changes.";
			return args.length > 0 ? `${base} Focus: ${args.join(" ")}` : base;
		}

		// Inline args act as additional instructions appended to the generated prompt.
		// When present, skip option 4 (editor) — the args already provide the instructions.
		// 命令行参数作为额外说明附加到生成的 prompt 后；
		// 若已有参数，则跳过选项 4（编辑器），因为说明已经提供。
		const extraInstructions = args.length > 0 ? args.join(" ") : undefined;

		const menuItems = extraInstructions
			? [
					"1. Review against a base branch (PR Style)",
					"2. Review uncommitted changes",
					"3. Review a specific commit",
				]
			: [
					"1. Review against a base branch (PR Style)",
					"2. Review uncommitted changes",
					"3. Review a specific commit",
					"4. Custom review instructions",
				];

		const mode = await ctx.ui.select("Review Mode", menuItems);

		if (!mode) return undefined;

		const modeNum = parseInt(mode[0], 10);

		switch (modeNum) {
			case 1: {
				// PR-style review against base branch
				// PR 风格：与基线分支对比
				const branches = await getGitBranches(this.api);
				if (branches.length === 0) {
					ctx.ui.notify("No git branches found", "error");
					return undefined;
				}

				const baseBranch = await ctx.ui.select("Select base branch to compare against", branches);
				if (!baseBranch) return undefined;

				const currentBranch = await getCurrentBranch(this.api);
				let diffText: string;
				try {
					// 使用三点语法：仅显示 currentBranch 相对 baseBranch 的真实变更
					diffText = await git.diff(this.api.cwd, { base: `${baseBranch}...${currentBranch}` });
				} catch (err) {
					ctx.ui.notify(`Failed to get diff: ${err instanceof Error ? err.message : String(err)}`, "error");
					return undefined;
				}

				if (!diffText.trim()) {
					ctx.ui.notify(`No changes between ${baseBranch} and ${currentBranch}`, "warning");
					return undefined;
				}

				const stats = parseDiff(diffText);
				if (stats.files.length === 0) {
					ctx.ui.notify("No reviewable files (all changes filtered out)", "warning");
					return undefined;
				}

				return buildReviewPrompt(
					`Reviewing changes between \`${baseBranch}\` and \`${currentBranch}\` (PR-style)`,
					stats,
					diffText,
					extraInstructions,
				);
			}

			case 2: {
				// Uncommitted changes - combine staged and unstaged
				// 未提交变更：合并 staged 与 unstaged
				const status = await getGitStatus(this.api);
				if (!status.trim()) {
					ctx.ui.notify("No uncommitted changes found", "warning");
					return undefined;
				}

				let unstagedDiff: string;
				let stagedDiff: string;
				try {
					// 并行获取 unstaged 与 staged diff
					[unstagedDiff, stagedDiff] = await Promise.all([
						git.diff(this.api.cwd),
						git.diff(this.api.cwd, { cached: true }),
					]);
				} catch (err) {
					ctx.ui.notify(`Failed to get diff: ${err instanceof Error ? err.message : String(err)}`, "error");
					return undefined;
				}

				const combinedDiff = [unstagedDiff, stagedDiff].filter(Boolean).join("\n");

				if (!combinedDiff.trim()) {
					ctx.ui.notify("No diff content found", "warning");
					return undefined;
				}

				const stats = parseDiff(combinedDiff);
				if (stats.files.length === 0) {
					ctx.ui.notify("No reviewable files (all changes filtered out)", "warning");
					return undefined;
				}

				return buildReviewPrompt(
					"Reviewing uncommitted changes (staged + unstaged)",
					stats,
					combinedDiff,
					extraInstructions,
				);
			}

			case 3: {
				// Specific commit
				// 指定 commit
				const commits = await getRecentCommits(this.api, 20);
				if (commits.length === 0) {
					ctx.ui.notify("No commits found", "error");
					return undefined;
				}

				const selected = await ctx.ui.select("Select commit to review", commits);
				if (!selected) return undefined;

				// Extract commit hash from selection (format: "abc1234 message")
				// 从选项文本（格式："abc1234 message"）中提取 commit hash
				const hash = selected.split(" ")[0];

				let diffText: string;
				try {
					diffText = await git.show(this.api.cwd, hash, { format: "" });
				} catch (err) {
					ctx.ui.notify(`Failed to get commit: ${err instanceof Error ? err.message : String(err)}`, "error");
					return undefined;
				}

				if (!diffText.trim()) {
					ctx.ui.notify("Commit has no diff content", "warning");
					return undefined;
				}

				const stats = parseDiff(diffText);
				if (stats.files.length === 0) {
					ctx.ui.notify("No reviewable files in commit (all changes filtered out)", "warning");
					return undefined;
				}

				return buildReviewPrompt(`Reviewing commit \`${hash}\``, stats, diffText, extraInstructions);
			}

			case 4: {
				// Custom instructions - still uses the old approach since user provides context
				// 自定义说明 —— 仍使用旧路径，由用户提供完整上下文
				const instructions = await ctx.ui.editor("Enter custom review instructions", "Review the following:\n\n");
				if (!instructions?.trim()) return undefined;

				// For custom, we still try to get current diff for context
				// 自定义模式下仍尝试获取当前 diff，作为额外上下文
				let diffText: string | undefined;
				try {
					diffText = await git.diff(this.api.cwd, { base: "HEAD" });
				} catch {
					diffText = undefined;
				}
				const reviewDiff = diffText?.trim();

				if (reviewDiff) {
					const stats = parseDiff(reviewDiff);
					// Even if all files filtered, include the custom instructions
					// 即使所有文件都被过滤掉，也要把自定义说明带上
					return buildReviewPrompt(
						`Custom review: ${instructions.split("\n")[0].slice(0, 60)}…`,
						stats,
						reviewDiff,
						instructions,
					);
				}

				// No diff available, just pass instructions
				// 没有 diff 可用时，仅传递用户自定义说明
				return `## Code Review Request

### Mode
Custom review instructions

### Instructions

${instructions}

Use the Task tool with \`agent: "reviewer"\` to execute this review.`;
			}

			default:
				return undefined;
		}
	}
}

/** 获取所有 git 分支（包含远端），失败时返回空数组 */
async function getGitBranches(api: CustomCommandAPI): Promise<string[]> {
	try {
		return await git.branch.list(api.cwd, { all: true });
	} catch {
		return [];
	}
}

/** 获取当前分支名，无法识别则回退为 "HEAD" */
async function getCurrentBranch(api: CustomCommandAPI): Promise<string> {
	try {
		return (await git.branch.current(api.cwd)) ?? "HEAD";
	} catch {
		return "HEAD";
	}
}

/** 获取 git 工作区状态文本，失败时返回空串 */
async function getGitStatus(api: CustomCommandAPI): Promise<string> {
	try {
		return await git.status(api.cwd);
	} catch {
		return "";
	}
}

/** 获取最近 N 条 commit 的单行摘要，用于选择菜单 */
async function getRecentCommits(api: CustomCommandAPI, count: number): Promise<string[]> {
	try {
		return await git.log.onelines(api.cwd, count);
	} catch {
		return [];
	}
}

export default ReviewCommand;


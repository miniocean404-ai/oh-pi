
/**
 * Fuzzy matching utilities for the edit tool.
 *
 * Provides both character-level and line-level fuzzy matching with progressive
 * fallback strategies for finding text in files.
 *
 * 编辑工具的模糊匹配工具集。
 *
 * 提供字符级和行级模糊匹配，支持渐进式回退策略在文件中查找文本。
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import * as z from "zod/v4";
import type { WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import type { ToolSession } from "../../tools";
import { invalidateFsScanAfterWrite } from "../../tools/fs-cache-invalidation";
import { outputMeta } from "../../tools/output-meta";
import { enforcePlanModeWrite, resolvePlanPath } from "../../tools/plan-mode-guard";
import { generateDiffString, replaceText } from "../diff";
import {
	countLeadingWhitespace,
	detectLineEnding,
	normalizeForFuzzy,
	normalizeToLF,
	normalizeUnicode,
	restoreLineEndings,
	stripBom,
} from "../normalize";
import { readEditFileText, serializeEditFileText } from "../read-file";
import type { EditToolDetails, LspBatchRequest } from "../renderer";

/** 模糊匹配结果 */
export interface FuzzyMatch {
	/** 实际匹配到的文本 */
	actualText: string;
	/** 匹配起始字符索引 */
	startIndex: number;
	/** 匹配起始行号 */
	startLine: number;
	/** 匹配置信度（0 到 1） */
	confidence: number;
}

/** 匹配结果，包含成功匹配、最近似匹配及歧义信息 */
export interface MatchOutcome {
	/** 成功匹配的结果 */
	match?: FuzzyMatch;
	/** 最接近的匹配（即使未达到阈值） */
	closest?: FuzzyMatch;
	/** 精确匹配的出现次数（用于检测歧义） */
	occurrences?: number;
	/** 各出现位置的行号 */
	occurrenceLines?: number[];
	/** 各出现位置的上下文预览 */
	occurrencePreviews?: string[];
	/** 模糊匹配达到阈值的数量 */
	fuzzyMatches?: number;
	/** 是否存在显著优于其他候选的主导模糊匹配 */
	dominantFuzzy?: boolean;
}

/** 序列匹配策略类型，按严格度从高到低排列 */
export type SequenceMatchStrategy =
	| "exact" // 精确匹配
	| "trim-trailing" // 忽略尾部空白
	| "trim" // 忽略首尾空白
	| "comment-prefix" // 忽略注释前缀
	| "unicode" // Unicode 标点归一化
	| "prefix" // 前缀匹配
	| "substring" // 子串匹配
	| "fuzzy" // 模糊相似度匹配
	| "fuzzy-dominant" // 主导模糊匹配（显著优于次优）
	| "character"; // 字符级模糊匹配（最终回退）

/** 序列搜索结果 */
export interface SequenceSearchResult {
	/** 匹配起始行索引，未找到时为 undefined */
	index: number | undefined;
	/** 匹配置信度 */
	confidence: number;
	/** 匹配数量（大于 1 表示歧义） */
	matchCount?: number;
	/** 各匹配位置的行索引（诊断用） */
	matchIndices?: number[];
	/** 使用的匹配策略 */
	strategy?: SequenceMatchStrategy;
}

/** 上下文行匹配策略类型 */
export type ContextMatchStrategy = "exact" | "trim" | "unicode" | "prefix" | "substring" | "fuzzy";

/** 上下文行搜索结果 */
export interface ContextLineResult {
	/** 匹配行索引，未找到时为 undefined */
	index: number | undefined;
	/** 匹配置信度 */
	confidence: number;
	/** 匹配数量 */
	matchCount?: number;
	/** 各匹配位置的行索引 */
	matchIndices?: number[];
	/** 使用的匹配策略 */
	strategy?: ContextMatchStrategy;
}

/** 编辑匹配错误，当无法在文件中找到匹配文本时抛出 */
export class EditMatchError extends Error {
	constructor(
		readonly path: string,
		readonly searchText: string,
		readonly closest: FuzzyMatch | undefined,
		readonly options: { allowFuzzy: boolean; threshold: number; fuzzyMatches?: number },
	) {
		super(EditMatchError.formatMessage(path, searchText, closest, options));
		this.name = "EditMatchError";
	}

	/** 格式化错误消息，包含最近似匹配的差异信息 */
	static formatMessage(
		path: string,
		searchText: string,
		closest: FuzzyMatch | undefined,
		options: { allowFuzzy: boolean; threshold: number; fuzzyMatches?: number },
	): string {
		if (!closest) {
			return options.allowFuzzy
				? `Could not find a close enough match in ${path}.`
				: `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`;
		}

		const similarity = Math.round(closest.confidence * 100);
		const searchLines = searchText.split("\n");
		const actualLines = closest.actualText.split("\n");
		const { oldLine, newLine } = findFirstDifferentLine(searchLines, actualLines);
		const thresholdPercent = Math.round(options.threshold * 100);

		const hint = options.allowFuzzy
			? options.fuzzyMatches && options.fuzzyMatches > 1
				? `Found ${options.fuzzyMatches} high-confidence matches. Provide more context to make it unique.`
				: `Closest match was below the ${thresholdPercent}% similarity threshold.`
			: "Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept high-confidence matches.";

		return [
			options.allowFuzzy
				? `Could not find a close enough match in ${path}.`
				: `Could not find the exact text in ${path}.`,
			``,
			`Closest match (${similarity}% similar) at line ${closest.startLine}:`,
			`  - ${oldLine}`,
			`  + ${newLine}`,
			hint,
		].join("\n");
	}
}

/** 找到两组行中第一个不同的行，用于错误消息中展示差异 */
function findFirstDifferentLine(oldLines: string[], newLines: string[]): { oldLine: string; newLine: string } {
	const max = Math.max(oldLines.length, newLines.length);
	for (let i = 0; i < max; i++) {
		const oldLine = oldLines[i] ?? "";
		const newLine = newLines[i] ?? "";
		if (oldLine !== newLine) {
			return { oldLine, newLine };
		}
	}
	return { oldLine: oldLines[0] ?? "", newLine: newLines[0] ?? "" };
}

/** 格式化多处匹配的歧义错误消息，提示用户添加更多上下文以消除歧义 */
function formatOccurrenceError(path: string, matchOutcome: MatchOutcome): string {
	const previews = matchOutcome.occurrencePreviews?.join("\n\n") ?? "";
	const moreMsg =
		matchOutcome.occurrences && matchOutcome.occurrences > MAX_RECORDED_MATCHES
			? ` (showing first ${MAX_RECORDED_MATCHES} of ${matchOutcome.occurrences})`
			: "";
	return `Found ${matchOutcome.occurrences} occurrences in ${path}${moreMsg}:\n\n${previews}\n\nAdd more context lines to disambiguate.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════════════════

/** Default similarity threshold for fuzzy matching */
/** 模糊匹配的默认相似度阈值 */
export const DEFAULT_FUZZY_THRESHOLD = 0.95;

/** Threshold for sequence-based fuzzy matching */
/** 序列模糊匹配的相似度阈值 */
const SEQUENCE_FUZZY_THRESHOLD = 0.92;

/** Fallback threshold for line-based matching */
/** 行级匹配的回退阈值 */
const FALLBACK_THRESHOLD = 0.8;

/** Threshold for context line matching */
/** 上下文行匹配的模糊阈值 */
const CONTEXT_FUZZY_THRESHOLD = 0.8;

/** Minimum length for partial/substring matching */
/** 部分/子串匹配的最小长度 */
const PARTIAL_MATCH_MIN_LENGTH = 6;

/** Minimum ratio of pattern to line length for substring match */
/** 子串匹配时模式与行长度的最小比率 */
const PARTIAL_MATCH_MIN_RATIO = 0.3;

/** Context lines to show before/after an ambiguous match preview */
/** 歧义匹配预览中前后显示的上下文行数 */
const OCCURRENCE_PREVIEW_CONTEXT = 5;

/** Maximum line length for ambiguous match previews */
/** 歧义匹配预览的最大行长度 */
const OCCURRENCE_PREVIEW_MAX_LEN = 80;

/** Maximum number of match indices or previews to retain for diagnostics */
/** 诊断信息中保留的最大匹配索引或预览数量 */
const MAX_RECORDED_MATCHES = 5;

/** Minimum confidence for a dominant fuzzy match to be auto-selected */
/** 主导模糊匹配被自动选中的最低置信度 */
const DOMINANT_FUZZY_MIN_CONFIDENCE = 0.97;

/** Minimum score gap between the best and second-best fuzzy matches */
/** 最优与次优模糊匹配之间的最小分差 */
const DOMINANT_FUZZY_DELTA = 0.08;

/** 索引化匹配结果集合 */
interface IndexedMatches {
	/** 第一个匹配的索引 */
	firstMatch: number | undefined;
	/** 匹配总数 */
	matchCount: number;
	/** 匹配索引列表（最多保留 MAX_RECORDED_MATCHES 个） */
	matchIndices: number[];
}

/** 预览窗口配置选项 */
interface PreviewWindowOptions {
	/** 上下文行数 */
	context: number;
	/** 每行最大长度 */
	maxLen: number;
}

/** 在指定范围内收集所有满足谓词的匹配索引 */
function collectIndexedMatches(
	start: number,
	endInclusive: number,
	predicate: (index: number) => boolean,
): IndexedMatches {
	let firstMatch: number | undefined;
	let matchCount = 0;
	const matchIndices: number[] = [];

	for (let index = start; index <= endInclusive; index++) {
		if (!predicate(index)) continue;
		if (firstMatch === undefined) {
			firstMatch = index;
		}
		matchCount++;
		if (matchIndices.length < MAX_RECORDED_MATCHES) {
			matchIndices.push(index);
		}
	}

	return { firstMatch, matchCount, matchIndices };
}

/** 将索引化匹配转换为单一匹配结果（仅当恰好有一个匹配时返回） */
function toSingleMatchResult<TStrategy extends SequenceMatchStrategy | ContextMatchStrategy>(
	matches: IndexedMatches,
	confidence: number,
	strategy: TStrategy,
): { index: number; confidence: number; strategy: TStrategy } | undefined {
	if (matches.firstMatch === undefined) {
		return undefined;
	}
	return {
		index: matches.firstMatch,
		confidence,
		strategy,
	};
}

/** 将索引化匹配转换为可能包含歧义信息的匹配结果 */
function toAmbiguousMatchResult<TStrategy extends SequenceMatchStrategy | ContextMatchStrategy>(
	matches: IndexedMatches,
	confidence: number,
	strategy: TStrategy,
): { index: number; confidence: number; matchCount: number; matchIndices: number[]; strategy: TStrategy } | undefined {
	if (matches.firstMatch === undefined) {
		return undefined;
	}
	return {
		index: matches.firstMatch,
		confidence,
		matchCount: matches.matchCount,
		matchIndices: matches.matchIndices,
		strategy,
	};
}

/** 格式化以指定行为中心的预览窗口，带行号和截断处理 */
function formatPreviewWindow(lines: string[], centerIndex: number, options: PreviewWindowOptions): string {
	const start = Math.max(0, centerIndex - options.context);
	const end = Math.min(lines.length, centerIndex + options.context + 1);
	return lines
		.slice(start, end)
		.map((line, index) => {
			const num = start + index + 1;
			const truncated = line.length > options.maxLen ? `${line.slice(0, options.maxLen - 1)}…` : line;
			return `  ${num} | ${truncated}`;
		})
		.join("\n");
}

/** 查找精确匹配结果；若存在多处匹配则返回歧义信息 */
function findExactMatchOutcome(content: string, target: string): MatchOutcome | undefined {
	const exactIndex = content.indexOf(target);
	if (exactIndex === -1) {
		return undefined;
	}

	const occurrences = content.split(target).length - 1;
	if (occurrences > 1) {
		const contentLines = content.split("\n");
		const occurrenceLines: number[] = [];
		const occurrencePreviews: string[] = [];
		let searchStart = 0;

		for (let i = 0; i < MAX_RECORDED_MATCHES; i++) {
			const idx = content.indexOf(target, searchStart);
			if (idx === -1) break;
			const lineNumber = content.slice(0, idx).split("\n").length;
			occurrenceLines.push(lineNumber);
			occurrencePreviews.push(
				formatPreviewWindow(contentLines, lineNumber - 1, {
					context: OCCURRENCE_PREVIEW_CONTEXT,
					maxLen: OCCURRENCE_PREVIEW_MAX_LEN,
				}),
			);
			searchStart = idx + 1;
		}

		return { occurrences, occurrenceLines, occurrencePreviews };
	}

	const startLine = content.slice(0, exactIndex).split("\n").length;
	return {
		match: {
			actualText: target,
			startIndex: exactIndex,
			startLine,
			confidence: 1,
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// 核心算法
// ═══════════════════════════════════════════════════════════════════════════

/** Compute Levenshtein distance between two strings */
/** 计算两个字符串之间的 Levenshtein 编辑距离 */
export function levenshteinDistance(a: string, b: string): number {
	if (a === b) return 0;
	const aLen = a.length;
	const bLen = b.length;
	if (aLen === 0) return bLen;
	if (bLen === 0) return aLen;

	// 使用两行滚动数组优化空间复杂度为 O(n)
	let prev = new Array<number>(bLen + 1);
	let curr = new Array<number>(bLen + 1);
	for (let j = 0; j <= bLen; j++) {
		prev[j] = j;
	}

	for (let i = 1; i <= aLen; i++) {
		curr[0] = i;
		const aCode = a.charCodeAt(i - 1);
		for (let j = 1; j <= bLen; j++) {
			const cost = aCode === b.charCodeAt(j - 1) ? 0 : 1;
			const deletion = prev[j] + 1; // 删除操作
			const insertion = curr[j - 1] + 1; // 插入操作
			const substitution = prev[j - 1] + cost; // 替换操作
			curr[j] = Math.min(deletion, insertion, substitution);
		}
		// 交换前后行数组引用
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}

	return prev[bLen];
}

/** Compute similarity score between two strings (0 to 1) */
/** 计算两个字符串之间的相似度分数（0 到 1） */
export function similarity(a: string, b: string): number {
	if (a.length === 0 && b.length === 0) return 1;
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) return 1;
	const distance = levenshteinDistance(a, b);
	return 1 - distance / maxLen;
}

// ═══════════════════════════════════════════════════════════════════════════
// 行级工具函数
// ═══════════════════════════════════════════════════════════════════════════

/** Compute relative indent depths for lines */
/** 计算各行的相对缩进深度，用于归一化比较时保留结构信息 */
function computeRelativeIndentDepths(lines: string[]): number[] {
	const indents = lines.map(countLeadingWhitespace);
	const nonEmptyIndents: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim().length > 0) {
			nonEmptyIndents.push(indents[i]);
		}
	}
	const minIndent = nonEmptyIndents.length > 0 ? Math.min(...nonEmptyIndents) : 0;
	const indentSteps = nonEmptyIndents.map(indent => indent - minIndent).filter(step => step > 0);
	const indentUnit = indentSteps.length > 0 ? Math.min(...indentSteps) : 1;

	return lines.map((line, index) => {
		if (line.trim().length === 0) return 0;
		if (indentUnit <= 0) return 0;
		const relativeIndent = indents[index] - minIndent;
		return Math.round(relativeIndent / indentUnit);
	});
}

/** Normalize lines for matching, optionally including indent depth */
/** 归一化行内容用于匹配比较，可选包含缩进深度前缀 */
function normalizeLines(lines: string[], includeDepth = true): string[] {
	const indentDepths = includeDepth ? computeRelativeIndentDepths(lines) : null;
	return lines.map((line, index) => {
		const trimmed = line.trim();
		const prefix = indentDepths ? `${indentDepths[index]}|` : "|";
		if (trimmed.length === 0) return prefix;
		return `${prefix}${normalizeForFuzzy(trimmed)}`;
	});
}

/** Compute character offsets for each line in content */
/** 计算内容中每行的字符偏移量 */
function computeLineOffsets(lines: string[]): number[] {
	const offsets: number[] = [];
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		offsets.push(offset);
		offset += lines[i].length;
		if (i < lines.length - 1) offset += 1; // newline
	}
	return offsets;
}

// ═══════════════════════════════════════════════════════════════════════════
// 字符级模糊匹配（用于替换模式）
// ═══════════════════════════════════════════════════════════════════════════

/** 最佳模糊匹配搜索结果 */
interface BestFuzzyMatchResult {
	/** 最佳匹配 */
	best?: FuzzyMatch;
	/** 超过阈值的匹配数量 */
	aboveThresholdCount: number;
	/** 次优匹配的分数 */
	secondBestScore: number;
}

/** 模糊匹配核心实现：滑动窗口逐行比较，找出最佳匹配位置 */
function findBestFuzzyMatchCore(
	contentLines: string[],
	targetLines: string[],
	offsets: number[],
	threshold: number,
	includeDepth: boolean,
): BestFuzzyMatchResult {
	const targetNormalized = normalizeLines(targetLines, includeDepth);

	let best: FuzzyMatch | undefined;
	let bestScore = -1;
	let secondBestScore = -1;
	let aboveThresholdCount = 0;

	for (let start = 0; start <= contentLines.length - targetLines.length; start++) {
		const windowLines = contentLines.slice(start, start + targetLines.length);
		const windowNormalized = normalizeLines(windowLines, includeDepth);
		let score = 0;
		for (let i = 0; i < targetLines.length; i++) {
			score += similarity(targetNormalized[i], windowNormalized[i]);
		}
		score = score / targetLines.length;

		if (score >= threshold) {
			aboveThresholdCount++;
		}

		if (score > bestScore) {
			secondBestScore = bestScore;
			bestScore = score;
			best = {
				actualText: windowLines.join("\n"),
				startIndex: offsets[start],
				startLine: start + 1,
				confidence: score,
			};
		} else if (score > secondBestScore) {
			secondBestScore = score;
		}
	}

	return { best, aboveThresholdCount, secondBestScore };
}

/** 在内容中查找与目标文本最佳的模糊匹配，支持缩进深度回退 */
function findBestFuzzyMatch(content: string, target: string, threshold: number): BestFuzzyMatchResult {
	const contentLines = content.split("\n");
	const targetLines = target.split("\n");

	if (targetLines.length === 0 || target.length === 0) {
		return { aboveThresholdCount: 0, secondBestScore: 0 };
	}
	if (targetLines.length > contentLines.length) {
		return { aboveThresholdCount: 0, secondBestScore: 0 };
	}

	const offsets = computeLineOffsets(contentLines);
	let result = findBestFuzzyMatchCore(contentLines, targetLines, offsets, threshold, true);

	// 如果匹配接近但低于阈值，尝试不使用缩进深度重新匹配
	if (result.best && result.best.confidence < threshold && result.best.confidence >= FALLBACK_THRESHOLD) {
		const noDepthResult = findBestFuzzyMatchCore(contentLines, targetLines, offsets, threshold, false);
		if (noDepthResult.best && noDepthResult.best.confidence > result.best.confidence) {
			result = noDepthResult;
		}
	}

	return result;
}

/**
 * Find a match for target text within content.
 * Used primarily for replace-mode edits.
 *
 * 在内容中查找目标文本的匹配。
 * 主要用于替换模式编辑。先尝试精确匹配，失败后回退到模糊匹配。
 */
export function findMatch(
	content: string,
	target: string,
	options: { allowFuzzy: boolean; threshold?: number },
): MatchOutcome {
	if (target.length === 0) {
		return {};
	}

	const exactMatch = findExactMatchOutcome(content, target);
	if (exactMatch) {
		return exactMatch;
	}

	// 尝试模糊匹配
	const threshold = options.threshold ?? DEFAULT_FUZZY_THRESHOLD;
	const { best, aboveThresholdCount, secondBestScore } = findBestFuzzyMatch(content, target, threshold);

	if (!best) {
		return {};
	}

	if (options.allowFuzzy && best.confidence >= threshold) {
		if (aboveThresholdCount === 1) {
			return { match: best, closest: best };
		}
		if (
			aboveThresholdCount > 1 &&
			best.confidence >= DOMINANT_FUZZY_MIN_CONFIDENCE &&
			best.confidence - secondBestScore >= DOMINANT_FUZZY_DELTA
		) {
			return { match: best, closest: best, fuzzyMatches: aboveThresholdCount, dominantFuzzy: true };
		}
	}

	return { closest: best, fuzzyMatches: aboveThresholdCount };
}

// ═══════════════════════════════════════════════════════════════════════════
// 行级序列匹配（用于补丁模式）
// ═══════════════════════════════════════════════════════════════════════════

/** Check if pattern matches lines starting at index using comparison function */
/** 检查从指定索引开始的行是否与模式匹配（使用给定的比较函数） */
function matchesAt(lines: string[], pattern: string[], i: number, compare: (a: string, b: string) => boolean): boolean {
	for (let j = 0; j < pattern.length; j++) {
		if (!compare(lines[i + j], pattern[j])) {
			return false;
		}
	}
	return true;
}

/** Compute average similarity score for pattern at position */
/** 计算指定位置处模式的平均相似度分数 */
function fuzzyScoreAt(lines: string[], pattern: string[], i: number): number {
	let totalScore = 0;
	for (let j = 0; j < pattern.length; j++) {
		const lineNorm = normalizeForFuzzy(lines[i + j]);
		const patternNorm = normalizeForFuzzy(pattern[j]);
		totalScore += similarity(lineNorm, patternNorm);
	}
	return totalScore / pattern.length;
}

/** Check if line starts with pattern (normalized) */
/** 检查行是否以模式开头（归一化后比较） */
function lineStartsWithPattern(line: string, pattern: string): boolean {
	const lineNorm = normalizeForFuzzy(line);
	const patternNorm = normalizeForFuzzy(pattern);
	if (patternNorm.length === 0) return lineNorm.length === 0;
	return lineNorm.startsWith(patternNorm);
}

/** Check if line contains pattern as significant substring */
/** 检查行是否包含模式作为有意义的子串（需满足最小长度和比率要求） */
function lineIncludesPattern(line: string, pattern: string): boolean {
	const lineNorm = normalizeForFuzzy(line);
	const patternNorm = normalizeForFuzzy(pattern);
	if (patternNorm.length === 0) return lineNorm.length === 0;
	if (patternNorm.length < PARTIAL_MATCH_MIN_LENGTH) return false;
	if (!lineNorm.includes(patternNorm)) return false;
	return patternNorm.length / Math.max(1, lineNorm.length) >= PARTIAL_MATCH_MIN_RATIO;
}

/** 去除行首的注释前缀（支持 //, /*, *, #, ; 等多种注释风格） */
function stripCommentPrefix(line: string): string {
	let trimmed = line.trimStart();
	if (trimmed.startsWith("/*")) {
		trimmed = trimmed.slice(2);
	} else if (trimmed.startsWith("*/")) {
		trimmed = trimmed.slice(2);
	} else if (trimmed.startsWith("//")) {
		trimmed = trimmed.slice(2);
	} else if (trimmed.startsWith("*")) {
		trimmed = trimmed.slice(1);
	} else if (trimmed.startsWith("#")) {
		trimmed = trimmed.slice(1);
	} else if (trimmed.startsWith(";")) {
		trimmed = trimmed.slice(1);
	} else if (trimmed.startsWith("/") && trimmed[1] === " ") {
		trimmed = trimmed.slice(1);
	}
	return trimmed.trimStart();
}

/**
 * Find a sequence of pattern lines within content lines.
 *
 * Attempts matches with decreasing strictness:
 * 1. Exact match
 * 2. Trailing whitespace ignored
 * 3. All whitespace trimmed
 * 4. Unicode punctuation normalized
 * 5. Prefix match (pattern is prefix of line)
 * 6. Substring match (pattern is substring of line)
 * 7. Fuzzy similarity match
 *
 * 在内容行中查找模式行序列。
 *
 * 按严格度递减依次尝试匹配：
 * 1. 精确匹配
 * 2. 忽略尾部空白
 * 3. 忽略全部首尾空白
 * 4. Unicode 标点归一化
 * 5. 前缀匹配（模式是行的前缀）
 * 6. 子串匹配（模式是行的子串）
 * 7. 模糊相似度匹配
 *
 * @param lines - 文件内容的行数组
 * @param pattern - 要搜索的模式行
 * @param start - 搜索起始索引
 * @param eof - 若为 true，优先从文件末尾开始匹配
 */
export function seekSequence(
	lines: string[],
	pattern: string[],
	start: number,
	eof: boolean,
	options?: { allowFuzzy?: boolean },
): SequenceSearchResult {
	const allowFuzzy = options?.allowFuzzy ?? true;
	// 空模式立即匹配
	if (pattern.length === 0) {
		return { index: start, confidence: 1.0, strategy: "exact" };
	}

	// 模式长于可用内容，无法匹配
	if (pattern.length > lines.length) {
		return { index: undefined, confidence: 0 };
	}

	// 确定搜索起始位置
	const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
	const maxStart = lines.length - pattern.length;

	const runExactPasses = (from: number, to: number): SequenceSearchResult | undefined => {
		const comparisonPasses: Array<{
			compare: (a: string, b: string) => boolean;
			confidence: number;
			strategy: SequenceMatchStrategy;
		}> = [
			{ compare: (a, b) => a === b, confidence: 1.0, strategy: "exact" },
			{ compare: (a, b) => a.trimEnd() === b.trimEnd(), confidence: 0.99, strategy: "trim-trailing" },
			{ compare: (a, b) => a.trim() === b.trim(), confidence: 0.98, strategy: "trim" },
			{
				compare: (a, b) => stripCommentPrefix(a) === stripCommentPrefix(b),
				confidence: 0.975,
				strategy: "comment-prefix",
			},
			{
				compare: (a, b) => normalizeUnicode(a) === normalizeUnicode(b),
				confidence: 0.97,
				strategy: "unicode",
			},
		];

		for (const pass of comparisonPasses) {
			const matches = collectIndexedMatches(from, to, i => matchesAt(lines, pattern, i, pass.compare));
			const result = toSingleMatchResult(matches, pass.confidence, pass.strategy);
			if (result) {
				return result;
			}
		}

		if (!allowFuzzy) {
			return undefined;
		}

		const partialPasses: Array<{
			compare: (line: string, patternLine: string) => boolean;
			confidence: number;
			strategy: SequenceMatchStrategy;
		}> = [
			{ compare: lineStartsWithPattern, confidence: 0.965, strategy: "prefix" },
			{ compare: lineIncludesPattern, confidence: 0.94, strategy: "substring" },
		];

		for (const pass of partialPasses) {
			const matches = collectIndexedMatches(from, to, i => matchesAt(lines, pattern, i, pass.compare));
			const result = toAmbiguousMatchResult(matches, pass.confidence, pass.strategy);
			if (result) {
				return result;
			}
		}

		return undefined;
	};

	const primaryPassResult = runExactPasses(searchStart, maxStart);
	if (primaryPassResult) {
		return primaryPassResult;
	}

	if (eof && searchStart > start) {
		const fromStartResult = runExactPasses(start, maxStart);
		if (fromStartResult) {
			return fromStartResult;
		}
	}

	if (!allowFuzzy) {
		return { index: undefined, confidence: 0 };
	}

	// 第 7 轮：模糊匹配 - 查找超过阈值的最佳匹配
	let bestScore = 0;
	let secondBestScore = 0;
	let bestIndex: number | undefined;
	const fuzzyMatches: IndexedMatches = {
		firstMatch: undefined,
		matchCount: 0,
		matchIndices: [],
	};

	const scoreFuzzyRange = (from: number, to: number): void => {
		for (let i = from; i <= to; i++) {
			const score = fuzzyScoreAt(lines, pattern, i);
			if (score >= SEQUENCE_FUZZY_THRESHOLD) {
				if (fuzzyMatches.firstMatch === undefined) {
					fuzzyMatches.firstMatch = i;
				}
				fuzzyMatches.matchCount++;
				if (fuzzyMatches.matchIndices.length < MAX_RECORDED_MATCHES) {
					fuzzyMatches.matchIndices.push(i);
				}
			}
			if (score > bestScore) {
				secondBestScore = bestScore;
				bestScore = score;
				bestIndex = i;
			} else if (score > secondBestScore) {
				secondBestScore = score;
			}
		}
	};

	scoreFuzzyRange(searchStart, maxStart);

	// 如果 eof 模式从末尾开始搜索，也从起始位置搜索
	if (eof && searchStart > start) {
		scoreFuzzyRange(start, searchStart - 1);
	}

	if (bestIndex !== undefined && bestScore >= SEQUENCE_FUZZY_THRESHOLD) {
		if (
			fuzzyMatches.matchCount > 1 &&
			bestScore >= DOMINANT_FUZZY_MIN_CONFIDENCE &&
			bestScore - secondBestScore >= DOMINANT_FUZZY_DELTA
		) {
			return {
				index: bestIndex,
				confidence: bestScore,
				matchCount: 1,
				matchIndices: fuzzyMatches.matchIndices,
				strategy: "fuzzy-dominant",
			};
		}
		return {
			index: bestIndex,
			confidence: bestScore,
			matchCount: fuzzyMatches.matchCount,
			matchIndices: fuzzyMatches.matchIndices,
			strategy: "fuzzy",
		};
	}

	// 第 8 轮：通过 findMatch 进行字符级模糊匹配
	// 这是行级匹配失败后的最终回退方案
	const CHARACTER_MATCH_THRESHOLD = 0.92;
	const patternText = pattern.join("\n");
	const contentText = lines.slice(start).join("\n");
	const matchOutcome = findMatch(contentText, patternText, {
		allowFuzzy: true,
		threshold: CHARACTER_MATCH_THRESHOLD,
	});

	if (matchOutcome.match) {
		// 将字符索引转换回行索引
		const matchedContent = contentText.substring(0, matchOutcome.match.startIndex);
		const lineIndex = start + matchedContent.split("\n").length - 1;
		const fallbackMatchCount = matchOutcome.occurrences ?? matchOutcome.fuzzyMatches ?? 1;
		return {
			index: lineIndex,
			confidence: matchOutcome.match.confidence,
			matchCount: fallbackMatchCount,
			strategy: "character",
		};
	}

	const fallbackMatchCount = matchOutcome.occurrences ?? matchOutcome.fuzzyMatches;
	return { index: undefined, confidence: bestScore, matchCount: fallbackMatchCount };
}

/** 查找最接近的序列匹配位置，始终返回最佳模糊匹配结果（不要求达到阈值） */
export function findClosestSequenceMatch(
	lines: string[],
	pattern: string[],
	options?: { start?: number; eof?: boolean },
): { index: number | undefined; confidence: number; strategy: SequenceMatchStrategy } {
	if (pattern.length === 0) {
		return { index: options?.start ?? 0, confidence: 1, strategy: "exact" };
	}
	if (pattern.length > lines.length) {
		return { index: undefined, confidence: 0, strategy: "fuzzy" };
	}

	const start = options?.start ?? 0;
	const eof = options?.eof ?? false;
	const maxStart = lines.length - pattern.length;
	const searchStart = eof && lines.length >= pattern.length ? maxStart : start;

	let bestIndex: number | undefined;
	let bestScore = 0;

	for (let i = searchStart; i <= maxStart; i++) {
		const score = fuzzyScoreAt(lines, pattern, i);
		if (score > bestScore) {
			bestScore = score;
			bestIndex = i;
		}
	}

	if (eof && searchStart > start) {
		for (let i = start; i < searchStart; i++) {
			const score = fuzzyScoreAt(lines, pattern, i);
			if (score > bestScore) {
				bestScore = score;
				bestIndex = i;
			}
		}
	}

	return { index: bestIndex, confidence: bestScore, strategy: "fuzzy" };
}

/**
 * Find a context line in the file using progressive matching strategies.
 *
 * 使用渐进式匹配策略在文件中查找上下文行。
 * 依次尝试：精确 → 去空白 → Unicode 归一化 → 前缀 → 子串 → 模糊匹配。
 *
 * @param lines - 文件内容的行数组
 * @param context - 要搜索的上下文行
 * @param startFrom - 搜索起始索引
 */
export function findContextLine(
	lines: string[],
	context: string,
	startFrom: number,
	options?: { allowFuzzy?: boolean; skipFunctionFallback?: boolean },
): ContextLineResult {
	const allowFuzzy = options?.allowFuzzy ?? true;
	const trimmedContext = context.trim();

	const endIndex = lines.length - 1;
	const exactPasses: Array<{
		confidence: number;
		strategy: ContextMatchStrategy;
		predicate: (index: number) => boolean;
	}> = [
		{ confidence: 1.0, strategy: "exact", predicate: i => lines[i] === context },
		{ confidence: 0.99, strategy: "trim", predicate: i => lines[i].trim() === trimmedContext },
	];

	for (const pass of exactPasses) {
		const matches = collectIndexedMatches(startFrom, endIndex, pass.predicate);
		const result = toAmbiguousMatchResult(matches, pass.confidence, pass.strategy);
		if (result) {
			return result;
		}
	}

	// 第 3 轮：Unicode 归一化匹配
	const normalizedContext = normalizeUnicode(context);
	const unicodeMatches = collectIndexedMatches(
		startFrom,
		endIndex,
		i => normalizeUnicode(lines[i]) === normalizedContext,
	);
	const unicodeResult = toAmbiguousMatchResult(unicodeMatches, 0.98, "unicode");
	if (unicodeResult) {
		return unicodeResult;
	}

	if (!allowFuzzy) {
		return { index: undefined, confidence: 0 };
	}

	// 第 4 轮：前缀匹配（文件行以上下文开头）
	const contextNorm = normalizeForFuzzy(context);
	if (contextNorm.length > 0) {
		const prefixMatches = collectIndexedMatches(startFrom, endIndex, i =>
			normalizeForFuzzy(lines[i]).startsWith(contextNorm),
		);
		const prefixResult = toAmbiguousMatchResult(prefixMatches, 0.96, "prefix");
		if (prefixResult) {
			return prefixResult;
		}
	}

	// 第 5 轮：子串匹配（文件行包含上下文）
	// 第一遍：查找所有子串匹配（忽略比率）
	// 如果恰好一个匹配，直接接受（唯一性足够）
	// 如果多个匹配，应用比率过滤以消除歧义
	if (contextNorm.length >= PARTIAL_MATCH_MIN_LENGTH) {
		const allSubstringMatches: Array<{ index: number; ratio: number }> = [];
		for (let i = startFrom; i < lines.length; i++) {
			const lineNorm = normalizeForFuzzy(lines[i]);
			if (lineNorm.includes(contextNorm)) {
				const ratio = contextNorm.length / Math.max(1, lineNorm.length);
				allSubstringMatches.push({ index: i, ratio });
			}
		}
		const matchIndices = allSubstringMatches.slice(0, 5).map(match => match.index);

		// 如果恰好一个子串匹配，无论比率如何都接受
		if (allSubstringMatches.length === 1) {
			return {
				index: allSubstringMatches[0].index,
				confidence: 0.94,
				matchCount: 1,
				matchIndices,
				strategy: "substring",
			};
		}

		// 多个匹配：按比率过滤以消除歧义
		let firstMatch: number | undefined;
		let matchCount = 0;
		for (const match of allSubstringMatches) {
			if (match.ratio >= PARTIAL_MATCH_MIN_RATIO) {
				if (firstMatch === undefined) firstMatch = match.index;
				matchCount++;
			}
		}
		if (matchCount > 0) {
			return { index: firstMatch, confidence: 0.94, matchCount, matchIndices, strategy: "substring" };
		}

		// 如果存在子串匹配但无一通过比率过滤，
		// 返回歧义结果以告知调用方存在匹配
		if (allSubstringMatches.length > 1) {
			return {
				index: allSubstringMatches[0].index,
				confidence: 0.94,
				matchCount: allSubstringMatches.length,
				matchIndices,
				strategy: "substring",
			};
		}
	}

	// 第 6 轮：使用相似度的模糊匹配
	let bestIndex: number | undefined;
	let bestScore = 0;
	const fuzzyMatches: IndexedMatches = {
		firstMatch: undefined,
		matchCount: 0,
		matchIndices: [],
	};

	for (let i = startFrom; i < lines.length; i++) {
		const lineNorm = normalizeForFuzzy(lines[i]);
		const score = similarity(lineNorm, contextNorm);
		if (score >= CONTEXT_FUZZY_THRESHOLD) {
			if (fuzzyMatches.firstMatch === undefined) {
				fuzzyMatches.firstMatch = i;
			}
			fuzzyMatches.matchCount++;
			if (fuzzyMatches.matchIndices.length < MAX_RECORDED_MATCHES) {
				fuzzyMatches.matchIndices.push(i);
			}
		}
		if (score > bestScore) {
			bestScore = score;
			bestIndex = i;
		}
	}

	if (bestIndex !== undefined && bestScore >= CONTEXT_FUZZY_THRESHOLD) {
		return {
			index: bestIndex,
			confidence: bestScore,
			matchCount: fuzzyMatches.matchCount,
			matchIndices: fuzzyMatches.matchIndices,
			strategy: "fuzzy",
		};
	}

	if (!options?.skipFunctionFallback && trimmedContext.endsWith("()")) {
		const withParen = trimmedContext.replace(/\(\)\s*$/u, "(");
		const withoutParen = trimmedContext.replace(/\(\)\s*$/u, "");
		const parenResult = findContextLine(lines, withParen, startFrom, { allowFuzzy, skipFunctionFallback: true });
		if (parenResult.index !== undefined || (parenResult.matchCount ?? 0) > 0) {
			return parenResult;
		}
		return findContextLine(lines, withoutParen, startFrom, { allowFuzzy, skipFunctionFallback: true });
	}

	return { index: undefined, confidence: bestScore };
}

/** 单条替换编辑的参数 schema */
export const replaceEditEntrySchema = z
	.object({
		old_text: z.string().describe("text to find"),
		new_text: z.string().describe("replacement text"),
		all: z.boolean().describe("replace all occurrences").optional(),
	})
	.strict();

/** 替换编辑操作的完整参数 schema（包含文件路径和编辑列表） */
export const replaceEditSchema = z
	.object({
		path: z.string().describe("file path"),
		edits: z.array(replaceEditEntrySchema).min(1).describe("replacements"),
	})
	.strict();

/** 单条替换编辑条目的类型 */
export type ReplaceEditEntry = z.infer<typeof replaceEditEntrySchema>;
/** 替换编辑操作的完整参数类型 */
export type ReplaceParams = z.infer<typeof replaceEditSchema>;

/** 执行单次替换操作的选项 */
export interface ExecuteReplaceSingleOptions {
	session: ToolSession;
	path: string;
	params: ReplaceEditEntry;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	allowFuzzy: boolean;
	fuzzyThreshold: number;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}

/**
 * 执行单次文本替换操作。
 * 读取文件内容，执行替换（支持精确和模糊匹配），写回文件并生成 diff 结果。
 */
export async function executeReplaceSingle(
	options: ExecuteReplaceSingleOptions,
): Promise<AgentToolResult<EditToolDetails, typeof replaceEditEntrySchema>> {
	const {
		session,
		path,
		params,
		signal,
		batchRequest,
		allowFuzzy,
		fuzzyThreshold,
		writethrough,
		beginDeferredDiagnosticsForPath,
	} = options;
	const { old_text, new_text, all } = params;

	enforcePlanModeWrite(session, path);

	if (old_text.length === 0) {
		throw new Error("old_text must not be empty.");
	}

	const absolutePath = resolvePlanPath(session, path);
	const rawContent = await readEditFileText(absolutePath, path);
	const { bom, text: content } = stripBom(rawContent);
	const originalEnding = detectLineEnding(content);
	const normalizedContent = normalizeToLF(content);
	const normalizedOldText = normalizeToLF(old_text);
	const normalizedNewText = normalizeToLF(new_text);

	const result = replaceText(normalizedContent, normalizedOldText, normalizedNewText, {
		fuzzy: allowFuzzy,
		all: all ?? false,
		threshold: fuzzyThreshold,
	});

	if (result.count === 0) {
		const matchOutcome = findMatch(normalizedContent, normalizedOldText, {
			allowFuzzy,
			threshold: fuzzyThreshold,
		});

		if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
			throw new Error(formatOccurrenceError(path, matchOutcome));
		}

		throw new EditMatchError(path, normalizedOldText, matchOutcome.closest, {
			allowFuzzy,
			threshold: fuzzyThreshold,
			fuzzyMatches: matchOutcome.fuzzyMatches,
		});
	}

	if (normalizedContent === result.content) {
		throw new Error(`Edits to ${path} resulted in no changes being made.`);
	}

	const finalContent = await serializeEditFileText(
		absolutePath,
		path,
		bom + restoreLineEndings(result.content, originalEnding),
	);
	const diagnostics = await writethrough(
		absolutePath,
		finalContent,
		signal,
		Bun.file(absolutePath),
		batchRequest,
		dst => (dst === absolutePath ? beginDeferredDiagnosticsForPath(absolutePath) : undefined),
	);
	invalidateFsScanAfterWrite(absolutePath);

	const diffResult = generateDiffString(normalizedContent, result.content);
	const resultText =
		result.count > 1
			? `Successfully replaced ${result.count} occurrences in ${path}.`
			: `Successfully replaced text in ${path}.`;

	const meta = outputMeta()
		.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
		.get();

	return {
		content: [{ type: "text", text: resultText }],
		details: {
			diff: diffResult.diff,
			path: absolutePath,
			firstChangedLine: diffResult.firstChangedLine,
			diagnostics,
			meta,
			oldText: rawContent,
			newText: finalContent,
		},
	};
}


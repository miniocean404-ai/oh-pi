
/**
 * 编辑工具的文本标准化工具集。
 *
 * 处理行尾符、BOM、空白字符和 Unicode 标准化。
 *
 * Text normalization utilities for the edit tool.
 *
 * Handles line endings, BOM, whitespace, and Unicode normalization.
 */

import { padding } from "@oh-my-pi/pi-tui";

// ═══════════════════════════════════════════════════════════════════════════
// 行尾符工具
// ═══════════════════════════════════════════════════════════════════════════

/** 行尾符类型 */
export type LineEnding = "\r\n" | "\n";

/** 检测内容中主要使用的行尾符 */
/** Detect the predominant line ending in content */
export function detectLineEnding(content: string): LineEnding {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

/** 将所有行尾符统一为 LF */
/** Normalize all line endings to LF */
export function normalizeToLF(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** 将行尾符恢复为指定类型 */
/** Restore line endings to the specified type */
export function restoreLineEndings(text: string, ending: LineEnding): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

// ═══════════════════════════════════════════════════════════════════════════
// BOM 处理
// ═══════════════════════════════════════════════════════════════════════════

/** BOM 处理结果 */
export interface BomResult {
	/** BOM 字符（如存在），否则为空字符串 */
	/** The BOM character if present, empty string otherwise */
	bom: string;
	/** 去除 BOM 后的文本 */
	/** The text without the BOM */
	text: string;
}

/** 去除 UTF-8 BOM（如存在） */
/** Strip UTF-8 BOM if present */
export function stripBom(content: string): BomResult {
	return content.startsWith("﻿") ? { bom: "﻿", text: content.slice(1) } : { bom: "", text: content };
}

// ═══════════════════════════════════════════════════════════════════════════
// 空白字符工具
// ═══════════════════════════════════════════════════════════════════════════

/** 计算行首空白字符数量 */
/** Count leading whitespace characters in a line */
export function countLeadingWhitespace(line: string): number {
	let count = 0;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === " " || char === "\t") {
			count++;
		} else {
			break;
		}
	}
	return count;
}

/** 获取行首的空白字符串 */
/** Get the leading whitespace string from a line */
export function getLeadingWhitespace(line: string): string {
	return line.slice(0, countLeadingWhitespace(line));
}

/** 判断行是否非空（含非空白字符） */
function isNonEmptyLine(line: string): boolean {
	return line.trim().length > 0;
}

/** 计算非空行的最小缩进量 */
/** Compute minimum indentation of non-empty lines */
export function minIndent(text: string): number {
	const lines = text.split("\n");
	let min = Infinity;
	for (const line of lines) {
		if (isNonEmptyLine(line)) {
			min = Math.min(min, countLeadingWhitespace(line));
		}
	}
	return min === Infinity ? 0 : min;
}

/** 检测文本中使用的缩进字符（空格或制表符） */
/** Detect the indentation character used in text (space or tab) */
export function detectIndentChar(text: string): string {
	const lines = text.split("\n");
	for (const line of lines) {
		const ws = getLeadingWhitespace(line);
		if (ws.length > 0) {
			return ws[0];
		}
	}
	return " ";
}

/** 计算最大公约数 */
function gcd(a: number, b: number): number {
	let x = Math.abs(a);
	let y = Math.abs(b);
	while (y !== 0) {
		const temp = y;
		y = x % y;
		x = temp;
	}
	return x;
}

/** 缩进分析结果 */
interface IndentProfile {
	lines: string[];
	indentCounts: number[];
	char: " " | "\t" | undefined;
	spaceOnly: boolean;
	tabOnly: boolean;
	mixed: boolean;
	unit: number;
	nonEmptyCount: number;
}

/** 构建文本的缩进分析结果 */
function buildIndentProfile(text: string): IndentProfile {
	const lines = text.split("\n");
	const indentCounts: number[] = [];
	let char: " " | "\t" | undefined;
	let spaceOnly = true;
	let tabOnly = true;
	let mixed = false;
	let nonEmptyCount = 0;
	let unit = 0;

	for (const line of lines) {
		if (!isNonEmptyLine(line)) continue;
		nonEmptyCount++;
		const indent = getLeadingWhitespace(line);
		indentCounts.push(indent.length);
		if (indent.includes(" ")) {
			tabOnly = false;
		}
		if (indent.includes("\t")) {
			spaceOnly = false;
		}
		if (indent.includes(" ") && indent.includes("\t")) {
			mixed = true;
		}
		if (indent.length > 0) {
			const currentChar = indent[0] as " " | "\t";
			if (!char) {
				char = currentChar;
			} else if (char !== currentChar) {
				mixed = true;
			}
		}
	}

	if (spaceOnly && nonEmptyCount > 0) {
		let current = 0;
		for (const count of indentCounts) {
			if (count === 0) continue;
			current = current === 0 ? count : gcd(current, count);
		}
		unit = current;
	}

	if (tabOnly && nonEmptyCount > 0) {
		unit = 1;
	}

	return {
		lines,
		indentCounts,
		char,
		spaceOnly,
		tabOnly,
		mixed,
		unit,
		nonEmptyCount,
	};
}

/** 将行首制表符转换为空格 */
export function convertLeadingTabsToSpaces(text: string, spacesPerTab: number): string {
	if (spacesPerTab <= 0) return text;
	return text
		.split("\n")
		.map(line => {
			const trimmed = line.trimStart();
			if (trimmed.length === 0) return line;
			const leading = getLeadingWhitespace(line);
			if (!leading.includes("\t") || leading.includes(" ")) return line;
			const converted = padding(leading.length * spacesPerTab);
			return converted + trimmed;
		})
		.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Unicode 标准化
// ═══════════════════════════════════════════════════════════════════════════

/** Unicode 字符替换映射表 */
const UNICODE_REPLACEMENTS: [RegExp, string][] = [
	// 各种破折号/连字符码点 → ASCII '-'
	[/[‐-―−]/g, "-"],
	// 花式单引号 → '
	[/[‘-‛]/g, "'"],
	// 花式双引号 → "
	[/[“-‟]/g, '"'],
	// 不间断空格和其他特殊空格 → 普通空格
	[/[  -   　]/g, " "],
	// 不等号 → !=
	[/≠/g, "!="],
	// 分数 ½ → 1/2
	[/½/g, "1/2"],
	// 零宽字符 → 移除
	[/[​-‍﻿]/g, ""],
];

/** 标准化 Unicode 字符（替换花式标点、特殊空格等） */
export function normalizeUnicode(s: string): string {
	let result = s.trim();
	for (const [pattern, replacement] of UNICODE_REPLACEMENTS) {
		result = result.replace(pattern, replacement);
	}
	return result.normalize("NFC");
}

/**
 * 标准化行用于模糊比较。
 * 去除首尾空白、合并连续空白、标准化标点符号。
 *
 * Normalize a line for fuzzy comparison.
 * Trims, collapses whitespace, and normalizes punctuation.
 */
export function normalizeForFuzzy(line: string): string {
	const trimmed = line.trim();
	if (trimmed.length === 0) return "";

	return trimmed
		.replace(/[""„‟«»]/g, '"')
		.replace(/[''‚‛`´]/g, "'")
		.replace(/[‐‑‒–—−]/g, "-")
		.replace(/[ \t]+/g, " ");
}

/** 判断是否仅是缩进变更（去除空白后内容相同） */
function isIndentationOnlyRewrite(oldText: string, newText: string): boolean {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	if (oldLines.length !== newLines.length) {
		return false;
	}
	for (let i = 0; i < oldLines.length; i++) {
		if (oldLines[i].trim() !== newLines[i].trim()) {
			return false;
		}
	}
	return true;
}

/** 尝试将制表符缩进转换为空格缩进（当模式匹配时） */
function maybeConvertTabIndentation(
	oldProfile: IndentProfile,
	actualProfile: IndentProfile,
	newProfile: IndentProfile,
	newText: string,
): string | undefined {
	if (!actualProfile.spaceOnly || !oldProfile.tabOnly || !newProfile.tabOnly || actualProfile.unit <= 0) {
		return undefined;
	}

	const lineCount = Math.min(oldProfile.lines.length, actualProfile.lines.length);
	for (let i = 0; i < lineCount; i++) {
		const oldLine = oldProfile.lines[i];
		const actualLine = actualProfile.lines[i];
		if (!isNonEmptyLine(oldLine) || !isNonEmptyLine(actualLine)) continue;
		const oldIndent = getLeadingWhitespace(oldLine);
		if (oldIndent.length === 0) continue;
		const actualIndent = getLeadingWhitespace(actualLine);
		if (actualIndent.length !== oldIndent.length * actualProfile.unit) {
			return undefined;
		}
	}

	return convertLeadingTabsToSpaces(newText, actualProfile.unit);
}

/** 计算统一的缩进偏移量（所有行的缩进差相同时） */
function computeUniformIndentDelta(oldProfile: IndentProfile, actualProfile: IndentProfile): number | undefined {
	const lineCount = Math.min(oldProfile.lines.length, actualProfile.lines.length);
	const deltas: number[] = [];
	for (let i = 0; i < lineCount; i++) {
		const oldLine = oldProfile.lines[i];
		const actualLine = actualProfile.lines[i];
		if (!isNonEmptyLine(oldLine) || !isNonEmptyLine(actualLine)) continue;
		deltas.push(countLeadingWhitespace(actualLine) - countLeadingWhitespace(oldLine));
	}

	if (deltas.length === 0) {
		return undefined;
	}

	const delta = deltas[0];
	return deltas.every(value => value === delta) ? delta : undefined;
}

/** 将缩进偏移量应用到文本的每一行 */
function applyIndentDelta(text: string, delta: number, indentChar: string): string {
	const adjusted = text.split("\n").map(line => {
		if (!isNonEmptyLine(line)) {
			return line;
		}
		if (delta > 0) {
			return indentChar.repeat(delta) + line;
		}
		const toRemove = Math.min(-delta, countLeadingWhitespace(line));
		return line.slice(toRemove);
	});

	return adjusted.join("\n");
}

/** 检查所有缩进分析是否都包含非空行 */
function hasNonEmptyIndentProfiles(...profiles: IndentProfile[]): boolean {
	return profiles.every(profile => profile.nonEmptyCount > 0);
}

/** 检查是否存在混合缩进（空格和制表符混用） */
function hasMixedIndentation(...profiles: IndentProfile[]): boolean {
	return profiles.some(profile => profile.mixed);
}

// ═══════════════════════════════════════════════════════════════════════════
// 缩进调整
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 调整 newText 的缩进，使其匹配提供内容（oldText）和实际匹配内容（actualText）
 * 之间的缩进差异。
 *
 * 例如，如果 oldText 缩进为 0 但 actualText 有 12 个空格，
 * 则给 newText 的每一行添加 12 个空格。
 *
 * Adjust newText indentation to match the indentation delta between
 * what was provided (oldText) and what was actually matched (actualText).
 *
 * If oldText has 0 indent but actualText has 12 spaces, we add 12 spaces
 * to each line in newText.
 */
export function adjustIndentation(oldText: string, actualText: string, newText: string): string {
	// 如果旧文本与实际文本完全匹配，保持 agent 预期的缩进
	if (oldText === actualText) {
		return newText;
	}

	// 如果补丁仅为缩进更改（去空白后内容相同），按原样应用
	if (isIndentationOnlyRewrite(oldText, newText)) {
		return newText;
	}

	const oldProfile = buildIndentProfile(oldText);
	const actualProfile = buildIndentProfile(actualText);
	const newProfile = buildIndentProfile(newText);

	if (!hasNonEmptyIndentProfiles(oldProfile, actualProfile, newProfile)) {
		return newText;
	}

	if (hasMixedIndentation(oldProfile, actualProfile, newProfile)) {
		return newText;
	}

	if (oldProfile.char && actualProfile.char && oldProfile.char !== actualProfile.char) {
		const converted = maybeConvertTabIndentation(oldProfile, actualProfile, newProfile, newText);
		if (converted !== undefined) {
			return converted;
		}
		return newText;
	}

	const delta = computeUniformIndentDelta(oldProfile, actualProfile);
	if (delta === undefined || delta === 0) {
		return newText;
	}

	if (newProfile.char && actualProfile.char && newProfile.char !== actualProfile.char) {
		return newText;
	}

	const indentChar = actualProfile.char ?? oldProfile.char ?? detectIndentChar(actualText);
	return applyIndentDelta(newText, delta, indentChar);
}


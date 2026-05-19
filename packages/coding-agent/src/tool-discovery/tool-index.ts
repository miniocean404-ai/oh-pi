
import type { AgentTool } from "@oh-my-pi/pi-agent-core";

// ─── 通用工具发现类型 ────────────────────────────────────────────────────────

/** 可发现工具的来源类型 */
export type DiscoverableToolSource = "builtin" | "mcp" | "extension" | "custom";

/** 可发现工具的描述信息 */
export interface DiscoverableTool {
	/** 工具名称 */
	name: string;
	/** 工具显示标签 */
	label: string;
	/** Short BM25 corpus entry; falls back to description first 200 chars */
	/** BM25 语料库短条目；回退为描述的前 200 个字符 */
	summary: string;
	/** 工具来源 */
	source: DiscoverableToolSource;
	/** MCP only */
	/** 仅 MCP：所属服务器名称 */
	serverName?: string;
	/** MCP only */
	/** 仅 MCP：MCP 工具原始名称 */
	mcpToolName?: string;
	/** 输入参数的 schema 属性键列表 */
	schemaKeys: string[];
}

/** 可发现工具的服务器摘要 */
export interface DiscoverableToolServerSummary {
	/** 服务器名称 */
	name: string;
	/** 该服务器下的工具数量 */
	toolCount: number;
}

/** 可发现工具的整体摘要 */
export interface DiscoverableToolSummary {
	/** 各服务器摘要列表 */
	servers: DiscoverableToolServerSummary[];
	/** 工具总数 */
	toolCount: number;
}

/** 搜索文档：将工具信息转换为可检索的文档结构 */
export interface DiscoverableToolSearchDocument {
	/** 关联的工具信息 */
	tool: DiscoverableTool;
	/** 词项频率映射 */
	termFrequencies: Map<string, number>;
	/** 文档加权长度 */
	length: number;
}

/** BM25 搜索索引 */
export interface DiscoverableToolSearchIndex {
	/** 所有文档列表 */
	documents: DiscoverableToolSearchDocument[];
	/** 文档平均长度 */
	averageLength: number;
	/** 文档频率映射（每个词项在多少文档中出现） */
	documentFrequencies: Map<string, number>;
}

/** 搜索结果条目 */
export interface DiscoverableToolSearchResult {
	/** 匹配的工具 */
	tool: DiscoverableTool;
	/** BM25 相关性得分 */
	score: number;
}

// ─── 旧版 MCP 类型别名（向后兼容） ──────────────────────────────────────────

/** @deprecated Use DiscoverableTool with source === "mcp" */
/** @deprecated 请使用 source === "mcp" 的 DiscoverableTool */
export type DiscoverableMCPTool = Pick<
	DiscoverableTool,
	"name" | "label" | "schemaKeys" | "serverName" | "mcpToolName"
> & { description: string };

/** @deprecated Use DiscoverableToolServerSummary */
/** @deprecated 请使用 DiscoverableToolServerSummary */
export type DiscoverableMCPToolServerSummary = DiscoverableToolServerSummary;

/** @deprecated Use DiscoverableToolSummary */
/** @deprecated 请使用 DiscoverableToolSummary */
export type DiscoverableMCPToolSummary = DiscoverableToolSummary;

/** Tool object stored on legacy MCP index documents. Carries both legacy `description` and the
 *  generic `summary`/`source` so the legacy index is structurally assignable to
 *  DiscoverableToolSearchIndex (search functions read termFrequencies, not the tool fields). */
/** 旧版 MCP 索引文档中存储的工具对象。同时携带旧版 `description` 和通用 `summary`/`source`，
 *  使旧版索引在结构上可赋值给 DiscoverableToolSearchIndex（搜索函数读取 termFrequencies 而非工具字段）。 */
export type DiscoverableMCPSearchTool = DiscoverableTool & { description: string };

/** @deprecated Use DiscoverableToolSearchDocument */
/** @deprecated 请使用 DiscoverableToolSearchDocument */
export interface DiscoverableMCPSearchDocument {
	tool: DiscoverableMCPSearchTool;
	termFrequencies: Map<string, number>;
	length: number;
}

/** @deprecated Use DiscoverableToolSearchIndex.
 *  Documents on this index expose `tool.description` (legacy MCP shape) while still being
 *  searchable via `searchDiscoverableTools`. */
/** @deprecated 请使用 DiscoverableToolSearchIndex。
 *  此索引上的文档暴露 `tool.description`（旧版 MCP 结构），同时仍可通过 `searchDiscoverableTools` 搜索。 */
export interface DiscoverableMCPSearchIndex {
	documents: DiscoverableMCPSearchDocument[];
	averageLength: number;
	documentFrequencies: Map<string, number>;
}

/** @deprecated Use DiscoverableToolSearchResult */
/** @deprecated 请使用 DiscoverableToolSearchResult */
export interface DiscoverableMCPSearchResult {
	tool: DiscoverableMCPSearchTool;
	score: number;
}

// ─── BM25 常量 ───────────────────────────────────────────────────────────────

/** BM25 词频饱和参数 */
const BM25_K1 = 1.2;
/** BM25 文档长度归一化参数 */
const BM25_B = 0.75;
/** BM25+ 的 delta 偏移量，避免长文档惩罚过大 */
const BM25_DELTA = 1.0;
/** 各字段的权重配置 */
const FIELD_WEIGHTS = {
	name: 6,
	label: 4,
	serverName: 2,
	mcpToolName: 4,
	summary: 2,
	schemaKey: 1,
} as const;

// ─── 辅助函数 ────────────────────────────────────────────────────────────────

/** 判断工具名称是否为 MCP 工具（以 "mcp__" 前缀开头） */
export function isMCPToolName(name: string): boolean {
	return name.startsWith("mcp__");
}

/** 从参数 schema 中提取属性键列表并排序 */
function getSchemaPropertyKeys(parameters: unknown): string[] {
	if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return [];
	const properties = (parameters as { properties?: unknown }).properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
	return Object.keys(properties as Record<string, unknown>).sort();
}

/** 对字符串进行分词：归一化、驼峰拆分、去除非字母数字字符、转小写 */
function tokenize(value: string): string[] {
	return (
		value
			.normalize("NFKD")
			// Drop combining marks (accents) so "café" → "cafe".
			.replace(/\p{M}+/gu, "")
			// Split ACRONYMBoundary: "MCPTool" → "MCP Tool".
			.replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
			// Split camelCase / digit→letter: "fooBar" → "foo Bar", "v2Beta" → "v2 Beta".
			.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
			// Everything that isn't a letter or digit becomes a separator. This subsumes markdown
			// punctuation (`|*_`#-~>[]()`), box-drawing glyphs (─│┌), em/en dashes, smart quotes,
			// zero-width spaces, NBSPs, etc.
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.toLowerCase()
			.trim()
			.split(/\s+/)
			.filter(token => token.length > 0)
	);
}

/** 将加权分词结果累加到词频映射中 */
function addWeightedTokens(termFrequencies: Map<string, number>, value: string | undefined, weight: number): void {
	if (!value) return;
	for (const token of tokenize(value)) {
		termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + weight);
	}
}

/** 为工具构建搜索文档，按各字段权重提取词频 */
function buildSearchDocument(tool: DiscoverableTool): DiscoverableToolSearchDocument {
	const termFrequencies = new Map<string, number>();
	addWeightedTokens(termFrequencies, tool.name, FIELD_WEIGHTS.name);
	addWeightedTokens(termFrequencies, tool.label, FIELD_WEIGHTS.label);
	addWeightedTokens(termFrequencies, tool.serverName, FIELD_WEIGHTS.serverName);
	addWeightedTokens(termFrequencies, tool.mcpToolName, FIELD_WEIGHTS.mcpToolName);
	addWeightedTokens(termFrequencies, tool.summary, FIELD_WEIGHTS.summary);
	for (const schemaKey of tool.schemaKeys) {
		addWeightedTokens(termFrequencies, schemaKey, FIELD_WEIGHTS.schemaKey);
	}
	const length = Array.from(termFrequencies.values()).reduce((sum, value) => sum + value, 0);
	return { tool, termFrequencies, length };
}

// ─── 通用工具发现函数 ────────────────────────────────────────────────────────

/**
 * Convert a raw AgentTool into a DiscoverableTool generic descriptor.
 * 将原始 AgentTool 转换为通用的 DiscoverableTool 描述符。
 * source: "mcp" if name starts with "mcp__", else "builtin" (caller may override).
 * 来源：名称以 "mcp__" 开头则为 "mcp"，否则为 "builtin"（调用方可覆盖）。
 */
export function getDiscoverableTool(
	tool: AgentTool,
	overrides?: { source?: DiscoverableToolSource; summary?: string },
): DiscoverableTool | null {
	const toolRecord = tool as AgentTool & {
		label?: string;
		description?: string;
		mcpServerName?: string;
		summary?: string;
		mcpToolName?: string;
		parameters?: unknown;
	};
	const source: DiscoverableToolSource = overrides?.source ?? (isMCPToolName(tool.name) ? "mcp" : "builtin");
	const rawSummary =
		typeof overrides?.summary === "string"
			? overrides.summary
			: typeof toolRecord.summary === "string"
				? toolRecord.summary
				: undefined;
	const rawDescription = typeof toolRecord.description === "string" ? toolRecord.description : "";
	const summary = rawSummary ?? rawDescription.slice(0, 200);
	return {
		name: tool.name,
		label: typeof toolRecord.label === "string" ? toolRecord.label : tool.name,
		summary,
		source,
		serverName: typeof toolRecord.mcpServerName === "string" ? toolRecord.mcpServerName : undefined,
		mcpToolName: typeof toolRecord.mcpToolName === "string" ? toolRecord.mcpToolName : undefined,
		schemaKeys: getSchemaPropertyKeys(toolRecord.parameters),
	};
}

/** Collect all DiscoverableTools from a tool iterable. Skips tools that return null. */
/** 从工具迭代器中收集所有可发现工具，跳过返回 null 的工具。 */
export function collectDiscoverableTools(
	tools: Iterable<AgentTool>,
	options?: { source?: DiscoverableToolSource; summaryMap?: Map<string, string> },
): DiscoverableTool[] {
	const discoverable: DiscoverableTool[] = [];
	for (const tool of tools) {
		const summary = options?.summaryMap?.get(tool.name);
		const meta = getDiscoverableTool(tool, { source: options?.source, summary });
		if (meta) {
			discoverable.push(meta);
		}
	}
	return discoverable;
}

/** Filter discoverable tools by source */
/** 按来源类型过滤可发现工具 */
export function filterBySource(tools: DiscoverableTool[], source: DiscoverableToolSource): DiscoverableTool[] {
	return tools.filter(t => t.source === source);
}

/** 格式化服务器摘要为可读字符串，如 "serverName (3 tools)" */
export function formatDiscoverableToolServerSummary(server: DiscoverableToolServerSummary): string {
	const toolLabel = server.toolCount === 1 ? "tool" : "tools";
	return `${server.name} (${server.toolCount} ${toolLabel})`;
}

/** 根据服务器名称集合筛选工具名称列表 */
export function selectDiscoverableToolNamesByServer(
	tools: Iterable<DiscoverableTool>,
	serverNames: ReadonlySet<string>,
): string[] {
	if (serverNames.size === 0) return [];
	return Array.from(tools)
		.filter(tool => tool.serverName !== undefined && serverNames.has(tool.serverName))
		.map(tool => tool.name);
}

/** 汇总可发现工具信息，按服务器分组统计工具数量 */
export function summarizeDiscoverableTools(tools: DiscoverableTool[]): DiscoverableToolSummary {
	const serverToolCounts = new Map<string, number>();
	for (const tool of tools) {
		if (!tool.serverName) continue;
		serverToolCounts.set(tool.serverName, (serverToolCounts.get(tool.serverName) ?? 0) + 1);
	}
	const servers = Array.from(serverToolCounts.entries())
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, toolCount]) => ({ name, toolCount }));
	return {
		servers,
		toolCount: tools.length,
	};
}

/** 构建 BM25 搜索索引，计算文档频率和平均文档长度 */
export function buildDiscoverableToolSearchIndex(tools: Iterable<DiscoverableTool>): DiscoverableToolSearchIndex {
	const documents = Array.from(tools, buildSearchDocument);
	const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1;
	const documentFrequencies = new Map<string, number>();
	for (const document of documents) {
		for (const token of new Set(document.termFrequencies.keys())) {
			documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
		}
	}
	return {
		documents,
		averageLength,
		documentFrequencies,
	};
}

/** 使用 BM25+ 算法在索引中搜索工具，返回按相关性排序的结果 */
export function searchDiscoverableTools(
	index: DiscoverableToolSearchIndex,
	query: string,
	limit: number,
): DiscoverableToolSearchResult[] {
	// 对查询字符串分词
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) {
		throw new Error("Query must contain at least one letter or number.");
	}
	if (index.documents.length === 0) {
		return [];
	}

	// 统计查询中每个词项的出现次数
	const queryTermCounts = new Map<string, number>();
	for (const token of queryTokens) {
		queryTermCounts.set(token, (queryTermCounts.get(token) ?? 0) + 1);
	}

	return index.documents
		.map(document => {
			let score = 0;
			for (const [token, queryTermCount] of queryTermCounts) {
				const termFrequency = document.termFrequencies.get(token) ?? 0;
				if (termFrequency === 0) continue;
				const documentFrequency = index.documentFrequencies.get(token) ?? 0;
				// 计算逆文档频率（IDF）
				const idf = Math.log(1 + (index.documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
				// 文档长度归一化
				const normalization = BM25_K1 * (1 - BM25_B + BM25_B * (document.length / index.averageLength));
				// BM25+ 得分公式
				score +=
					queryTermCount * idf * ((termFrequency * (BM25_K1 + 1)) / (termFrequency + normalization) + BM25_DELTA);
			}
			return { tool: document.tool, score };
		})
		.filter(result => result.score > 0)
		// 按得分降序排列，得分相同则按名称字母序排列
		.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
		.slice(0, limit);
}

// ─── 旧版 MCP 专用垫片（向后兼容包装器） ────────────────────────────────────

/** @deprecated Use getDiscoverableTool */
/** @deprecated 请使用 getDiscoverableTool */
export function getDiscoverableMCPTool(tool: AgentTool): DiscoverableMCPTool | null {
	if (!isMCPToolName(tool.name)) return null;
	const toolRecord = tool as AgentTool & {
		label?: string;
		description?: string;
		mcpServerName?: string;
		mcpToolName?: string;
		parameters?: unknown;
	};
	return {
		name: tool.name,
		label: typeof toolRecord.label === "string" ? toolRecord.label : tool.name,
		description: typeof toolRecord.description === "string" ? toolRecord.description : "",
		serverName: typeof toolRecord.mcpServerName === "string" ? toolRecord.mcpServerName : undefined,
		mcpToolName: typeof toolRecord.mcpToolName === "string" ? toolRecord.mcpToolName : undefined,
		schemaKeys: getSchemaPropertyKeys(toolRecord.parameters),
	};
}

/** @deprecated Use collectDiscoverableTools with source filter */
/** @deprecated 请使用带 source 过滤的 collectDiscoverableTools */
export function collectDiscoverableMCPTools(tools: Iterable<AgentTool>): DiscoverableMCPTool[] {
	const discoverable: DiscoverableMCPTool[] = [];
	for (const tool of tools) {
		const metadata = getDiscoverableMCPTool(tool);
		if (metadata) {
			discoverable.push(metadata);
		}
	}
	return discoverable;
}

/** @deprecated Use selectDiscoverableToolNamesByServer */
/** @deprecated 请使用 selectDiscoverableToolNamesByServer */
export function selectDiscoverableMCPToolNamesByServer(
	tools: Iterable<DiscoverableMCPTool>,
	serverNames: ReadonlySet<string>,
): string[] {
	if (serverNames.size === 0) return [];
	return Array.from(tools)
		.filter(tool => tool.serverName !== undefined && serverNames.has(tool.serverName))
		.map(tool => tool.name);
}

/** @deprecated Use summarizeDiscoverableTools */
/** @deprecated 请使用 summarizeDiscoverableTools */
export function summarizeDiscoverableMCPTools(tools: DiscoverableMCPTool[]): DiscoverableMCPToolSummary {
	const serverToolCounts = new Map<string, number>();
	for (const tool of tools) {
		if (!tool.serverName) continue;
		serverToolCounts.set(tool.serverName, (serverToolCounts.get(tool.serverName) ?? 0) + 1);
	}
	const servers = Array.from(serverToolCounts.entries())
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, toolCount]) => ({ name, toolCount }));
	return {
		servers,
		toolCount: tools.length,
	};
}

/** @deprecated Use buildDiscoverableToolSearchIndex.
 *  Builds an index whose documents preserve the legacy `description` field on each tool while
 *  also carrying the generic `summary` (set from `description`) so the index remains usable
 *  with `searchDiscoverableTools`. */
/** @deprecated 请使用 buildDiscoverableToolSearchIndex。
 *  构建的索引文档保留了每个工具上的旧版 `description` 字段，同时携带通用 `summary`
 * （从 `description` 设置），使索引仍可通过 `searchDiscoverableTools` 使用。 */
export function buildDiscoverableMCPSearchIndex(tools: Iterable<DiscoverableMCPTool>): DiscoverableMCPSearchIndex {
	const adapted: DiscoverableMCPSearchTool[] = Array.from(tools).map(t => ({
		name: t.name,
		label: t.label,
		description: t.description,
		summary: t.description,
		source: "mcp" as DiscoverableToolSource,
		serverName: t.serverName,
		mcpToolName: t.mcpToolName,
		schemaKeys: t.schemaKeys,
	}));
	const generic = buildDiscoverableToolSearchIndex(adapted);
	// Documents reference `adapted` tools (with `description`), so the cast is sound.
	return generic as unknown as DiscoverableMCPSearchIndex;
}

/** @deprecated Use searchDiscoverableTools */
/** @deprecated 请使用 searchDiscoverableTools */
export function searchDiscoverableMCPTools(
	index: DiscoverableMCPSearchIndex | DiscoverableToolSearchIndex,
	query: string,
	limit: number,
): DiscoverableMCPSearchResult[] {
	return searchDiscoverableTools(index as DiscoverableToolSearchIndex, query, limit) as DiscoverableMCPSearchResult[];
}

/** @deprecated Use formatDiscoverableToolServerSummary */
/** @deprecated 请使用 formatDiscoverableToolServerSummary */
export const formatDiscoverableMCPToolServerSummary = formatDiscoverableToolServerSummary;


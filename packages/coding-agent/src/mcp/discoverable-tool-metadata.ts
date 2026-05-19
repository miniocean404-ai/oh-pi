
/**
 * Back-compat re-export layer.
 * 向后兼容的重导出层。
 * All types and functions have moved to src/tool-discovery/tool-index.ts.
 * 所有类型和函数已迁移到 src/tool-discovery/tool-index.ts。
 * This file exists solely so existing imports continue to compile without changes.
 * 此文件仅为确保现有导入无需修改即可继续编译而存在。
 */
export type {
	DiscoverableMCPSearchDocument,
	DiscoverableMCPSearchIndex,
	DiscoverableMCPSearchResult,
	DiscoverableMCPTool,
	DiscoverableMCPToolServerSummary,
	DiscoverableMCPToolSummary,
} from "../tool-discovery/tool-index";

export {
	buildDiscoverableMCPSearchIndex,
	collectDiscoverableMCPTools,
	formatDiscoverableMCPToolServerSummary,
	getDiscoverableMCPTool,
	isMCPToolName,
	searchDiscoverableMCPTools,
	selectDiscoverableMCPToolNamesByServer,
	summarizeDiscoverableMCPTools,
} from "../tool-discovery/tool-index";


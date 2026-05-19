
/**
 * MCP (Model Context Protocol) support.
 * MCP（模型上下文协议）支持。
 *
 * Provides per-project .mcp.json configuration for connecting to
 * MCP servers via stdio or HTTP transports.
 * 提供基于项目的 .mcp.json 配置，用于通过 stdio 或 HTTP 传输连接 MCP 服务器。
 */

// 客户端
export * from "./client";
// 配置
export * from "./config";
export * from "./config-writer";
// JSON-RPC（轻量级基于 HTTP 的 MCP 调用）
export { callMCP, parseSSE } from "./json-rpc";
// 加载器（用于 SDK 集成）
export * from "./loader";
// 管理器
export * from "./manager";
// OAuth 发现
export * from "./oauth-discovery";
// 工具桥接
export * from "./tool-bridge";
// 工具缓存
export * from "./tool-cache";
// 传输层
export * from "./transports/http";
export * from "./transports/stdio";
// 类型
export * from "./types";



/**
 * Internal URL routing system for internal protocols like agent://, memory://,
 * skill://, mcp://, and local://.
 *
 * One process-global `InternalUrlRouter` is shared across sessions. Handlers
 * are stateless; they pull whatever they need (active skills/rules, active
 * MCP/async managers, AgentRegistry-listed sessions) from the owning module
 * on each resolve call.
 *
 * 面向内部协议（agent://、memory://、skill://、mcp://、local:// 等）的 URL 路由系统模块入口。
 * 整个进程共享一个全局 `InternalUrlRouter` 实例，处理器本身无状态，
 * 在每次 resolve 调用时从所属模块拉取所需依赖（活跃的 skill/rule、
 * 活跃的 MCP/异步管理器、AgentRegistry 中登记的会话等）。
 */

export * from "./agent-protocol";
export * from "./artifact-protocol";
export * from "./issue-pr-protocol";
export * from "./json-query";
export * from "./local-protocol";
export * from "./mcp-protocol";
export * from "./memory-protocol";
export * from "./omp-protocol";
export * from "./parse";
export * from "./router";
export * from "./rule-protocol";
export * from "./skill-protocol";
export type * from "./types";


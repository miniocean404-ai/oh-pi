
import type { LspStartupServerInfo } from "./index";

/** LSP 启动事件频道名称 */
export const LSP_STARTUP_EVENT_CHANNEL = "lsp:startup";

/** LSP 启动事件类型（完成或失败） */
export type LspStartupEvent =
	| {
			type: "completed";
			servers: Array<LspStartupServerInfo & { status: "ready" | "error" }>;
	  }
	| {
			type: "failed";
			error: string;
	  };


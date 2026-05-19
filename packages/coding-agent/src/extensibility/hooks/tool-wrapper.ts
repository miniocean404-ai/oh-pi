
/**
 * Tool wrapper - wraps tools with hook callbacks for interception.
 * 工具包装器 —— 在工具执行前后插入 hook 回调以实现拦截。
 */
import type { AgentTool, AgentToolContext, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Static, TSchema } from "@oh-my-pi/pi-ai";
import { applyToolProxy } from "../tool-proxy";
import type { HookRunner } from "./runner";
import type { ToolCallEventResult, ToolResultEventResult } from "./types";

/**
 * Wraps an AgentTool with hook callbacks for interception.
 *
 * Features:
 * - Emits tool_call event before execution (can block)
 * - Emits tool_result event after execution (can modify result)
 * - Forwards onUpdate callback to wrapped tool for progress streaming
 *
 * 在 AgentTool 外层包一层 hook 回调以实现拦截：
 * - 执行前派发 tool_call 事件（hook 可阻断）
 * - 执行后派发 tool_result 事件（hook 可改写结果）
 * - 透传 onUpdate 回调以保留进度流式输出
 */
export class HookToolWrapper<TParameters extends TSchema = TSchema, TDetails = unknown>
	implements AgentTool<TParameters, TDetails>
{
	declare name: string;
	declare description: string;
	declare parameters: TParameters;
	declare label: string;
	declare strict: boolean;

	constructor(
		private tool: AgentTool<TParameters, TDetails>,
		private hookRunner: HookRunner,
	) {
		applyToolProxy(tool, this);
	}

	async execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
		context?: AgentToolContext,
	) {
		// Emit tool_call event - hooks can block execution
		// If hook errors/times out, block by default (fail-safe)
		// 派发 tool_call 事件 —— hook 可阻断执行
		// 若 hook 出错或超时，默认按阻断处理（fail-safe）
		if (this.hookRunner.hasHandlers("tool_call")) {
			try {
				const callResult = (await this.hookRunner.emitToolCall({
					type: "tool_call",
					toolName: this.tool.name,
					toolCallId,
					input: params as Record<string, unknown>,
				})) as ToolCallEventResult | undefined;

				if (callResult?.block) {
					const reason = callResult.reason || "Tool execution was blocked by a hook";
					throw new Error(reason);
				}
			} catch (err) {
				// Hook error or block - throw to mark as error
				// hook 报错或主动阻断 —— 抛出错误以标记失败
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Hook failed, blocking execution: ${String(err)}`);
			}
		}

		// Execute the actual tool, forwarding onUpdate for progress streaming
		// 调用底层工具，并透传 onUpdate 以保留进度流
		try {
			const result = await this.tool.execute(toolCallId, params, signal, onUpdate, context);

			// Emit tool_result event - hooks can modify the result
			// 派发 tool_result 事件 —— hook 可改写结果
			if (this.hookRunner.hasHandlers("tool_result")) {
				const resultResult = (await this.hookRunner.emit({
					type: "tool_result",
					toolName: this.tool.name,
					toolCallId,
					input: params as Record<string, unknown>,
					content: result.content,
					details: result.details,
					isError: false,
				})) as ToolResultEventResult | undefined;

				// Apply modifications if any
				// 应用 hook 返回的内容/详情覆盖（若有）
				if (resultResult) {
					return {
						content: resultResult.content ?? result.content,
						details: (resultResult.details ?? result.details) as TDetails,
					};
				}
			}

			return result;
		} catch (err) {
			// Emit tool_result event for errors so hooks can observe failures
			// 工具失败时也派发 tool_result 事件，使 hook 能观测到错误
			if (this.hookRunner.hasHandlers("tool_result")) {
				await this.hookRunner.emit({
					type: "tool_result",
					toolName: this.tool.name,
					toolCallId,
					input: params as Record<string, unknown>,
					content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
					details: undefined,
					isError: true,
				});
			}
			throw err; // Re-throw original error for agent-loop // 将原始错误抛回给 agent 循环
		}
	}
}


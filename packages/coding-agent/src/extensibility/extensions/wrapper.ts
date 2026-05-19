
/**
 * Tool wrappers for extensions.
 * 扩展使用的工具包装器集合（适配器 + 拦截器）。
 */
import type { AgentTool, AgentToolContext, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Static, TextContent, TSchema } from "@oh-my-pi/pi-ai";
import type { Theme } from "../../modes/theme/theme";
import { applyToolProxy } from "../tool-proxy";
import type { ExtensionRunner } from "./runner";
import type { RegisteredTool, ToolCallEventResult } from "./types";

/**
 * Adapts a RegisteredTool into an AgentTool.
 * 将扩展注册的 `RegisteredTool` 适配为 agent-core 所需的 `AgentTool` 实例。
 */
export class RegisteredToolAdapter implements AgentTool<any, any, any> {
	declare name: string;
	declare description: string;
	declare parameters: any;
	declare label: string;
	declare strict: boolean;

	renderCall?: (args: any, options: any, theme: any) => any;
	renderResult?: (result: any, options: any, theme: any, args?: any) => any;

	constructor(
		private registeredTool: RegisteredTool,
		private runner: ExtensionRunner,
	) {
		applyToolProxy(registeredTool.definition, this);

		// Only define render methods when the underlying definition provides them.
		// If these exist unconditionally on the prototype, ToolExecutionComponent
		// enters the custom-renderer path, gets undefined back, and silently
		// discards tool result text (extensions without renderers show blank).
		// 仅当底层定义提供 render 方法时才挂载到实例上。
		// 若原型上无条件存在这些方法，ToolExecutionComponent 会进入
		// 自定义渲染分支并拿到 undefined，从而静默丢弃工具结果文本，
		// 导致未提供渲染器的扩展显示为空。
		if (registeredTool.definition.renderCall) {
			this.renderCall = (args: any, options: any, theme: any) =>
				registeredTool.definition.renderCall!(args, options, theme as Theme);
		}
		if (registeredTool.definition.renderResult) {
			this.renderResult = (result: any, options: any, theme: any, args?: any) =>
				registeredTool.definition.renderResult!(
					result,
					{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
					theme as Theme,
					args,
				);
		}
	}

	async execute(
		toolCallId: string,
		params: any,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<any>,
		_context?: AgentToolContext,
	) {
		return this.registeredTool.definition.execute(toolCallId, params, signal, onUpdate, this.runner.createContext());
	}
}

/**
 * Backward-compatible factory function wrapper.
 * 工厂函数形式的向后兼容包装，内部委托给 {@link RegisteredToolAdapter}。
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	return new RegisteredToolAdapter(registeredTool, runner);
}

/**
 * Wrap all registered tools into AgentTools.
 * 批量将注册工具包装为 `AgentTool` 数组。
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map(rt => wrapRegisteredTool(rt, runner));
}

/**
 * Wraps a tool with extension callbacks for interception.
 * - Emits tool_call event before execution (can block)
 * - Emits tool_result event after execution (can modify result)
 *
 * 在工具执行前后插入扩展回调以实现拦截：
 * - 执行前触发 `tool_call` 事件（扩展可阻断执行）
 * - 执行后触发 `tool_result` 事件（扩展可改写结果）
 */
export class ExtensionToolWrapper<TParameters extends TSchema = TSchema, TDetails = unknown>
	implements AgentTool<TParameters, TDetails>
{
	declare name: string;
	declare description: string;
	declare parameters: TParameters;
	declare label: string;
	declare strict: boolean;

	constructor(
		private tool: AgentTool<TParameters, TDetails>,
		private runner: ExtensionRunner,
	) {
		applyToolProxy(tool, this);
	}

	/**
	 * Forward browser mode changes when available.
	 * 若底层工具支持模式切换重启（如浏览器工具），则转发该调用。
	 */
	restartForModeChange(): Promise<void> {
		const target = this.tool as { restartForModeChange?: () => Promise<void> };
		if (!target.restartForModeChange) return Promise.resolve();
		return target.restartForModeChange();
	}

	async execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
		context?: AgentToolContext,
	) {
		// Emit tool_call event - extensions can block execution
		// 触发 tool_call 事件 —— 扩展可在此阶段阻断执行
		if (this.runner.hasHandlers("tool_call")) {
			try {
				const callResult = (await this.runner.emitToolCall({
					type: "tool_call",
					toolName: this.tool.name,
					toolCallId,
					input: params as Record<string, unknown>,
				})) as ToolCallEventResult | undefined;

				if (callResult?.block) {
					const reason = callResult.reason || "Tool execution was blocked by an extension";
					throw new Error(reason);
				}
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		}

		// Execute the actual tool
		// 调用真正的工具实现；捕获错误以便后续 tool_result 事件能感知到失败
		let result: { content: any; details?: TDetails };
		let executionError: Error | undefined;

		try {
			result = await this.tool.execute(toolCallId, params, signal, onUpdate, context);
		} catch (err) {
			executionError = err instanceof Error ? err : new Error(String(err));
			result = {
				content: [{ type: "text", text: executionError.message }],
				details: undefined as TDetails,
			};
		}

		// Emit tool_result event - extensions can modify the result and error status
		// 触发 tool_result 事件 —— 扩展可改写返回内容及错误标志
		if (this.runner.hasHandlers("tool_result")) {
			const resultResult = await this.runner.emitToolResult({
				type: "tool_result",
				toolName: this.tool.name,
				toolCallId,
				input: params as Record<string, unknown>,
				content: result.content,
				details: result.details,
				isError: !!executionError,
			});

			if (resultResult) {
				const modifiedContent: (TextContent | ImageContent)[] = resultResult.content ?? result.content;
				const modifiedDetails = (resultResult.details ?? result.details) as TDetails;

				// Extension can override error status
				// 扩展可覆盖错误状态
				if (resultResult.isError === true && !executionError) {
					// Extension marks a successful result as error
					// 扩展将原本成功的结果标记为错误
					const textBlocks = (modifiedContent ?? []).filter((c): c is TextContent => c.type === "text");
					const errorText = textBlocks.map(t => t.text).join("\n") || "Tool result marked as error by extension";
					throw new Error(errorText);
				}
				if (resultResult.isError === false && executionError) {
					// Extension clears the error - return success
					// 扩展清除了错误标志 —— 返回成功结果
					return { content: modifiedContent, details: modifiedDetails };
				}

				// Error status unchanged, but content/details may be modified
				// 错误状态未变，但内容/详情可能被修改
				if (executionError) {
					throw executionError;
				}
				return { content: modifiedContent, details: modifiedDetails };
			}
		}

		// No extension modification
		// 没有扩展介入，直接返回原结果（或抛出原始错误）
		if (executionError) {
			throw executionError;
		}
		return result;
	}
}


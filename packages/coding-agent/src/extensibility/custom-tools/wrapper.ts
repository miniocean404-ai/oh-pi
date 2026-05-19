
/**
 * CustomToolAdapter wraps CustomTool instances into AgentTool for use with the agent.
 *
 * CustomToolAdapter 将 CustomTool 实例包装为 AgentTool，供 agent 运行时使用。
 */
import type { AgentTool, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Static, TSchema } from "@oh-my-pi/pi-ai";
import type { Theme } from "../../modes/theme/theme";
import { applyToolProxy } from "../tool-proxy";
import type { CustomTool, CustomToolContext } from "./types";

/**
 * 将 CustomTool 适配为 AgentTool 的适配器。
 *
 * 通过 applyToolProxy 将原始工具的元信息（name/label/description/parameters 等）
 * 代理到适配器实例上，从而对外暴露完整的 AgentTool 接口；
 * 同时通过 getContext 注入上下文，让自定义工具按需访问会话状态与模型信息。
 */
export class CustomToolAdapter<TParams extends TSchema = TSchema, TDetails = any, TTheme extends Theme = Theme>
	implements AgentTool<TParams, TDetails, TTheme>
{
	// 以下字段通过 applyToolProxy 在运行时代理到原始 tool
	declare name: string;
	declare label: string;
	declare description: string;
	declare parameters: TParams;
	readonly strict: boolean | undefined;

	constructor(
		private tool: CustomTool<TParams, TDetails>,
		private getContext: () => CustomToolContext,
	) {
		// 将 tool 上的属性代理映射到 this，避免重复拷贝
		applyToolProxy(tool, this);
		this.strict = tool.strict;
	}

	/** 执行工具：若调用方未传入 context，则通过 getContext 获取最新上下文 */
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParams>,
		context?: CustomToolContext,
	) {
		return this.tool.execute(toolCallId, params, onUpdate, context ?? this.getContext(), signal);
	}

	/**
	 * Backward-compatible export of factory function for existing callers.
	 * Prefer CustomToolAdapter constructor directly.
	 *
	 * 为现有调用方保留的向后兼容工厂方法。
	 * 新代码请优先直接使用 CustomToolAdapter 构造函数。
	 */
	static wrap<TParams extends TSchema = TSchema, TDetails = any, TTheme extends Theme = Theme>(
		tool: CustomTool<TParams, TDetails>,
		getContext: () => CustomToolContext,
	): AgentTool<TParams, TDetails, TTheme> {
		return new CustomToolAdapter(tool, getContext);
	}
}


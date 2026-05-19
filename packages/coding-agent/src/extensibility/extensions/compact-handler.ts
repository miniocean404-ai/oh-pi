
/**
 * Helper for wiring the `compact` action of an {@link ExtensionContext}.
 *
 * Extension-facing APIs accept `string | CompactOptions`, but `AgentSession.compact`
 * takes two positional arguments `(instructions, options)`. This helper splits the
 * union so the same adapter can be reused by print-mode, rpc-mode, and the executor.
 *
 * 用于将 {@link ExtensionContext} 的 `compact` 动作连接到底层会话的辅助函数。
 *
 * 扩展面向的 API 接受 `string | CompactOptions`，但 `AgentSession.compact`
 * 接受两个位置参数 `(instructions, options)`。该辅助函数拆分联合类型，
 * 以便相同的适配器可以被 print-mode、rpc-mode 和 executor 复用。
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { CompactOptions } from "./types";

interface CompactableSession {
	compact(instructions?: string, options?: CompactOptions): Promise<unknown>;
}

/**
 * 执行扩展的 compact 操作：将 `string | CompactOptions` 联合参数拆分为
 * `session.compact(instructions, options)` 所需的两个位置参数。
 */
export async function runExtensionCompact(
	session: CompactableSession,
	instructionsOrOptions: string | CompactOptions | undefined,
): Promise<void> {
	// 字符串视为压缩指令；对象视为选项
	const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
	const options =
		instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
	await session.compact(instructions, options);
}

interface SetModelCapableSession {
	modelRegistry: { getApiKey(model: Model): Promise<string | undefined> };
	setModel(model: Model): Promise<unknown>;
}

/**
 * Helper for wiring the `setModel` action of an {@link ExtensionContext}.
 *
 * Returns false when no API key is available for the requested model.
 *
 * 用于将 {@link ExtensionContext} 的 `setModel` 动作连接到底层会话的辅助函数。
 * 若所请求模型没有可用的 API key，则返回 false。
 */
export async function runExtensionSetModel(session: SetModelCapableSession, model: Model): Promise<boolean> {
	// 缺少 API key 时拒绝切换模型
	const key = await session.modelRegistry.getApiKey(model);
	if (!key) return false;
	await session.setModel(model);
	return true;
}


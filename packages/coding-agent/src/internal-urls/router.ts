
/**
 * Internal URL router for internal protocols (agent://, artifact://, memory://, skill://, rule://, mcp://, omp://, local://).
 *
 * One process-global router with one handler per scheme. Access via
 * `InternalUrlRouter.instance()`. Handlers are stateless; per-session and
 * shared state lives in `./state.ts`.
 *
 * 内部协议（agent://、artifact://、memory://、skill://、rule://、mcp://、omp://、local://）的 URL 路由器。
 * 全进程共享一个 router 实例，每个 scheme 仅对应一个处理器，
 * 通过 `InternalUrlRouter.instance()` 获取。处理器自身无状态，
 * 会话级与共享状态都存放在 `./state.ts` 中。
 */
import { AgentProtocolHandler } from "./agent-protocol";
import { ArtifactProtocolHandler } from "./artifact-protocol";
import { IssueProtocolHandler, PrProtocolHandler } from "./issue-pr-protocol";
import { LocalProtocolHandler } from "./local-protocol";
import { McpProtocolHandler } from "./mcp-protocol";
import { MemoryProtocolHandler } from "./memory-protocol";
import { OmpProtocolHandler } from "./omp-protocol";
import { parseInternalUrl } from "./parse";
import { RuleProtocolHandler } from "./rule-protocol";
import { SkillProtocolHandler } from "./skill-protocol";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext } from "./types";

/**
 * 内部 URL 路由器：按 scheme 分发到对应的协议处理器。
 */
export class InternalUrlRouter {
	static #instance: InternalUrlRouter | undefined;

	#handlers = new Map<string, ProtocolHandler>();

	constructor() {
		this.register(new OmpProtocolHandler());
		this.register(new AgentProtocolHandler());
		this.register(new ArtifactProtocolHandler());
		this.register(new MemoryProtocolHandler());
		this.register(new LocalProtocolHandler());
		this.register(new SkillProtocolHandler());
		this.register(new RuleProtocolHandler());
		this.register(new McpProtocolHandler());
		this.register(new IssueProtocolHandler());
		this.register(new PrProtocolHandler());
	}

	/** Process-global router instance.
	 *  获取全进程共享的 router 实例。 */
	static instance(): InternalUrlRouter {
		InternalUrlRouter.#instance ??= new InternalUrlRouter();
		return InternalUrlRouter.#instance;
	}

	/** Reset the global instance in tests.
	 *  仅用于测试场景：重置全局实例。 */
	static resetForTests(): void {
		InternalUrlRouter.#instance = undefined;
	}

	/** 注册一个协议处理器（按 scheme 小写写入）。 */
	register(handler: ProtocolHandler): void {
		this.#handlers.set(handler.scheme.toLowerCase(), handler);
	}

	/** 注销指定 scheme 的处理器，返回是否实际移除。 */
	unregister(scheme: string): boolean {
		return this.#handlers.delete(scheme.toLowerCase());
	}

	/** 获取指定 scheme 对应的处理器（若未注册返回 undefined）。 */
	getHandler(scheme: string): ProtocolHandler | undefined {
		return this.#handlers.get(scheme.toLowerCase());
	}

	/** 判断给定字符串是否为可由当前 router 处理的内部 URL。 */
	canHandle(input: string): boolean {
		const match = input.match(/^([a-z][a-z0-9+.-]*):\/\//i);
		if (!match) return false;
		return this.#handlers.has(match[1].toLowerCase());
	}

	/** 解析内部 URL 字符串：分发到对应处理器并补全 immutable 标志。 */
	async resolve(input: string, context?: ResolveContext): Promise<InternalResource> {
		const parsed = parseInternalUrl(input);
		const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
		const handler = this.#handlers.get(scheme);

		if (!handler) {
			const available = Array.from(this.#handlers.keys())
				.map(s => `${s}://`)
				.join(", ");
			throw new Error(`Unknown protocol: ${scheme}://\nSupported: ${available || "none"}`);
		}

		const resource = await handler.resolve(parsed as InternalUrl, context);
		return { ...resource, immutable: resource.immutable ?? handler.immutable };
	}
}


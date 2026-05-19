
/**
 * /green 命令 —— 生成持续迭代 CI 失败直到分支变绿的 prompt。
 */
import { prompt } from "@oh-my-pi/pi-utils";
import type { CustomCommand, CustomCommandAPI } from "../../../../extensibility/custom-commands/types";
import type { HookCommandContext } from "../../../../extensibility/hooks/types";
import ciGreenRequestTemplate from "../../../../prompts/ci-green-request.md" with { type: "text" };
import * as git from "../../../../utils/git";

/** 获取 HEAD 上指向的首个 tag，没有则返回 undefined */
async function getHeadTag(api: CustomCommandAPI): Promise<string | undefined> {
	try {
		return (await git.ref.tags(api.cwd))[0];
	} catch {
		return undefined;
	}
}

/**
 * /green 命令实现：根据当前 HEAD tag 渲染 ci-green-request 模板，
 * 引导 agent 不断修复 CI 失败直到流水线变绿。
 */
export class GreenCommand implements CustomCommand {
	name = "green";
	description = "Generate a prompt to iterate on CI failures until the branch is green";

	constructor(private api: CustomCommandAPI) {}

	async execute(_args: string[], _ctx: HookCommandContext): Promise<string> {
		const headTag = await getHeadTag(this.api);
		// 使用 Handlebars 模板渲染最终发送给 LLM 的 prompt
		return prompt.render(ciGreenRequestTemplate, { headTag });
	}
}


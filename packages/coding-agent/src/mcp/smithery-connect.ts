
/**
 * Smithery 连接管理。
 *
 * 提供与 Smithery API 交互的连接管理功能。
 */
const SMITHERY_API_BASE_URL = (process.env.SMITHERY_API_URL || "https://api.smithery.ai").replace(/\/+$/, "");

/** Smithery 连接错误 */
export class SmitheryConnectError extends Error {
	status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "SmitheryConnectError";
		this.status = status;
	}
}

/** Smithery 命名空间 */
type SmitheryNamespace = {
	name: string;
};

type SmitheryNamespacesResponse = {
	namespaces?: SmitheryNamespace[];
};

/** Smithery 连接状态 */
type SmitheryConnectionStatus =
	| { state: "connected" }
	| { state: "auth_required"; authorizationUrl?: string }
	| { state: "error"; message: string }
	| { state: string; [key: string]: unknown };

/** Smithery 连接信息 */
export type SmitheryConnection = {
	connectionId: string;
	mcpUrl: string;
	name: string;
	status?: SmitheryConnectionStatus;
	createdAt?: string;
};

type SmitheryConnectionsResponse = {
	connections?: SmitheryConnection[];
	nextCursor?: string | null;
};

/** 构建认证请求头 */
function buildAuthHeaders(apiKey: string): Headers {
	const headers = new Headers();
	headers.set("Authorization", `Bearer ${apiKey}`);
	headers.set("Content-Type", "application/json");
	return headers;
}

/** 构建 API URL */
function toApiUrl(path: string): string {
	return `${SMITHERY_API_BASE_URL}${path}`;
}

/** 检查响应状态，非成功则抛出错误 */
async function expectOk(response: Response, context: string): Promise<void> {
	if (response.ok) return;
	const responseText = await response.text().catch(() => "");
	const suffix = responseText ? `: ${responseText}` : "";
	throw new SmitheryConnectError(`${context}: ${response.status} ${response.statusText}${suffix}`, response.status);
}

/** 获取 Smithery API 基础 URL */
export function getSmitheryApiBaseUrl(): string {
	return SMITHERY_API_BASE_URL;
}

/** 列出 Smithery 命名空间 */
export async function listSmitheryNamespaces(apiKey: string): Promise<SmitheryNamespace[]> {
	const response = await fetch(toApiUrl("/namespaces"), {
		headers: buildAuthHeaders(apiKey),
	});
	await expectOk(response, "Failed to list Smithery namespaces");
	const payload = (await response.json()) as SmitheryNamespacesResponse;
	return payload.namespaces ?? [];
}

/** 创建 Smithery 命名空间 */
export async function createSmitheryNamespace(apiKey: string): Promise<SmitheryNamespace> {
	const response = await fetch(toApiUrl("/namespaces"), {
		method: "POST",
		headers: buildAuthHeaders(apiKey),
	});
	await expectOk(response, "Failed to create Smithery namespace");
	return (await response.json()) as SmitheryNamespace;
}

/** 解析 Smithery 命名空间，不存在则创建 */
export async function resolveSmitheryNamespace(apiKey: string): Promise<string> {
	const namespaces = await listSmitheryNamespaces(apiKey);
	if (namespaces.length > 0) {
		return namespaces[0]?.name ?? "";
	}
	const created = await createSmitheryNamespace(apiKey);
	return created.name;
}

/** 按 URL 列出 Smithery 连接 */
export async function listSmitheryConnectionsByUrl(
	apiKey: string,
	namespace: string,
	mcpUrl: string,
): Promise<SmitheryConnection[]> {
	const endpoint = new URL(toApiUrl(`/connect/${encodeURIComponent(namespace)}`));
	endpoint.searchParams.set("mcpUrl", mcpUrl);
	const response = await fetch(endpoint.toString(), {
		headers: buildAuthHeaders(apiKey),
	});
	await expectOk(response, "Failed to list Smithery connections");
	const payload = (await response.json()) as SmitheryConnectionsResponse;
	return payload.connections ?? [];
}

export async function createSmitheryConnection(
	apiKey: string,
	namespace: string,
	params: { mcpUrl: string; name?: string },
): Promise<SmitheryConnection> {
	const response = await fetch(toApiUrl(`/connect/${encodeURIComponent(namespace)}`), {
		method: "POST",
		headers: buildAuthHeaders(apiKey),
		body: JSON.stringify({
			mcpUrl: params.mcpUrl,
			name: params.name,
		}),
	});
	await expectOk(response, "Failed to create Smithery connection");
	return (await response.json()) as SmitheryConnection;
}

export async function getSmitheryConnection(
	apiKey: string,
	namespace: string,
	connectionId: string,
): Promise<SmitheryConnection> {
	const response = await fetch(
		toApiUrl(`/connect/${encodeURIComponent(namespace)}/${encodeURIComponent(connectionId)}`),
		{
			headers: buildAuthHeaders(apiKey),
		},
	);
	await expectOk(response, "Failed to get Smithery connection");
	return (await response.json()) as SmitheryConnection;
}

export async function deleteSmitheryConnection(apiKey: string, namespace: string, connectionId: string): Promise<void> {
	const response = await fetch(
		toApiUrl(`/connect/${encodeURIComponent(namespace)}/${encodeURIComponent(connectionId)}`),
		{
			method: "DELETE",
			headers: buildAuthHeaders(apiKey),
		},
	);
	await expectOk(response, "Failed to delete Smithery connection");
}


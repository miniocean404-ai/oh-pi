
/**
 * MCP OAuth Auto-Discovery
 * MCP OAuth 自动发现
 *
 * Automatically detects OAuth requirements from MCP server responses
 * and extracts authentication endpoints.
 * 自动检测 MCP 服务器响应中的 OAuth 需求并提取认证端点。
 */

/** OAuth 端点信息 */
export interface OAuthEndpoints {
	authorizationUrl: string;
	tokenUrl: string;
	clientId?: string;
	scopes?: string;
}

/** 认证检测结果 */
export interface AuthDetectionResult {
	requiresAuth: boolean;
	authType?: "oauth" | "apikey" | "unknown";
	oauth?: OAuthEndpoints;
	authServerUrl?: string;
	message?: string;
}

/** 从错误消息中解析 MCP 认证服务器 URL */
function parseMcpAuthServerUrl(errorMessage: string): string | undefined {
	const match = errorMessage.match(/Mcp-Auth-Server:\s*([^;\]\s]+)/i);
	if (!match?.[1]) return undefined;

	try {
		return new URL(match[1]).toString();
	} catch {
		return undefined;
	}
}

/** 从错误中提取 MCP 认证服务器 URL */
export function extractMcpAuthServerUrl(error: Error): string | undefined {
	return parseMcpAuthServerUrl(error.message);
}

/**
 * Detect if an error indicates authentication is required.
 * 检测错误是否表示需要认证。
 * Checks for common auth error patterns.
 * 检查常见的认证错误模式。
 */
export function detectAuthError(error: Error): boolean {
	const errorMsg = error.message.toLowerCase();

	// 检查 HTTP 认证状态码
	if (
		errorMsg.includes("401") ||
		errorMsg.includes("403") ||
		errorMsg.includes("unauthorized") ||
		errorMsg.includes("forbidden") ||
		errorMsg.includes("authentication required") ||
		errorMsg.includes("authentication failed")
	) {
		return true;
	}

	return false;
}

/**
 * Extract OAuth endpoints from error response.
 * 从错误响应中提取 OAuth 端点。
 * Looks for WWW-Authenticate header format or JSON error bodies.
 * 查找 WWW-Authenticate 头格式或 JSON 错误体。
 */
export function extractOAuthEndpoints(error: Error): OAuthEndpoints | null {
	const errorMsg = error.message;

	const readEndpointsFromObject = (obj: Record<string, unknown>): OAuthEndpoints | null => {
		const authorizationUrl =
			(obj.authorization_url as string | undefined) ||
			(obj.authorizationUrl as string | undefined) ||
			(obj.authorization_endpoint as string | undefined) ||
			(obj.authorizationEndpoint as string | undefined) ||
			(obj.authorization_uri as string | undefined) ||
			(obj.authorizationUri as string | undefined);
		const tokenUrl =
			(obj.token_url as string | undefined) ||
			(obj.tokenUrl as string | undefined) ||
			(obj.token_endpoint as string | undefined) ||
			(obj.tokenEndpoint as string | undefined) ||
			(obj.token_uri as string | undefined) ||
			(obj.tokenUri as string | undefined);

		if (!authorizationUrl || !tokenUrl) return null;

		const scopeFromArray = Array.isArray(obj.scopes_supported)
			? (obj.scopes_supported as unknown[]).filter(v => typeof v === "string").join(" ")
			: undefined;
		const scopes = (obj.scopes as string | undefined) || (obj.scope as string | undefined) || scopeFromArray;
		const clientId =
			(obj.client_id as string | undefined) ||
			(obj.clientId as string | undefined) ||
			(obj.default_client_id as string | undefined) ||
			(obj.public_client_id as string | undefined);

		return { authorizationUrl, tokenUrl, clientId, scopes };
	};

	const clientIdFromAuthUrl = (authorizationUrl: string): string | undefined => {
		try {
			return new URL(authorizationUrl).searchParams.get("client_id") ?? undefined;
		} catch {
			return undefined;
		}
	};

	const scopeFromAuthUrl = (authorizationUrl: string): string | undefined => {
		try {
			return new URL(authorizationUrl).searchParams.get("scope") ?? undefined;
		} catch {
			return undefined;
		}
	};

	try {
		// 尝试解析为 JSON 错误响应
		// 许多 MCP 服务器在错误体中返回包含 OAuth 端点的 JSON
		const jsonMatch = errorMsg.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const errorBody = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

			// 检查错误体中的 OAuth 端点
			if (errorBody.oauth || errorBody.authorization || errorBody.auth) {
				const oauthData = (errorBody.oauth || errorBody.authorization || errorBody.auth) as Record<string, unknown>;
				const endpoints = readEndpointsFromObject(oauthData);
				if (endpoints) {
					return {
						...endpoints,
						clientId: endpoints.clientId || clientIdFromAuthUrl(endpoints.authorizationUrl),
						scopes: endpoints.scopes || scopeFromAuthUrl(endpoints.authorizationUrl),
					};
				}
			}

			const topLevelEndpoints = readEndpointsFromObject(errorBody);
			if (topLevelEndpoints) {
				return {
					...topLevelEndpoints,
					clientId: topLevelEndpoints.clientId || clientIdFromAuthUrl(topLevelEndpoints.authorizationUrl),
					scopes: topLevelEndpoints.scopes || scopeFromAuthUrl(topLevelEndpoints.authorizationUrl),
				};
			}
		}
	} catch {
		// 不是 JSON，继续其他检测方法
	}

	const challengeEntries = Array.from(errorMsg.matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]+)"/g));
	if (challengeEntries.length > 0) {
		const challengeValues = new Map<string, string>();
		for (const [, rawKey, value] of challengeEntries) {
			challengeValues.set(rawKey.toLowerCase(), value);
		}

		const authorizationUrl =
			challengeValues.get("authorization_uri") ||
			challengeValues.get("authorization_url") ||
			challengeValues.get("authorization_endpoint") ||
			challengeValues.get("authorize_url") ||
			challengeValues.get("realm");
		const tokenUrl =
			challengeValues.get("token_url") || challengeValues.get("token_uri") || challengeValues.get("token_endpoint");

		if (authorizationUrl && tokenUrl) {
			return {
				authorizationUrl,
				tokenUrl,
				clientId: challengeValues.get("client_id") || clientIdFromAuthUrl(authorizationUrl),
				scopes: challengeValues.get("scope") || challengeValues.get("scopes") || scopeFromAuthUrl(authorizationUrl),
			};
		}
	}

	// Try to extract from WWW-Authenticate header format
	// Example: Bearer realm="https://auth.example.com/oauth/authorize" token_url="https://auth.example.com/oauth/token"
	const wwwAuthMatch = errorMsg.match(/realm="([^"]+)".*token_url="([^"]+)"/);
	if (wwwAuthMatch) {
		return {
			authorizationUrl: wwwAuthMatch[1],
			tokenUrl: wwwAuthMatch[2],
			clientId: clientIdFromAuthUrl(wwwAuthMatch[1]),
			scopes: scopeFromAuthUrl(wwwAuthMatch[1]),
		};
	}

	return null;
}

/**
 * Analyze an error to determine authentication requirements.
 * 分析错误以确定认证需求。
 * Returns structured info about what auth is needed.
 * 返回关于所需认证的结构化信息。
 */
export function analyzeAuthError(error: Error): AuthDetectionResult {
	if (!detectAuthError(error)) {
		return { requiresAuth: false };
	}

	const authServerUrl = extractMcpAuthServerUrl(error);

	// 尝试提取 OAuth 端点
	const oauth = extractOAuthEndpoints(error);

	if (oauth) {
		return {
			requiresAuth: true,
			authType: "oauth",
			oauth,
			authServerUrl,
			message: "Server requires OAuth authentication. Launching authorization flow...",
		};
	}

	// 检查是否可能是 API 密钥认证
	const errorMsg = error.message.toLowerCase();
	if (
		errorMsg.includes("api key") ||
		errorMsg.includes("api_key") ||
		errorMsg.includes("token") ||
		errorMsg.includes("bearer")
	) {
		return {
			requiresAuth: true,
			authType: "apikey",
			authServerUrl,
			message: "Server requires API key authentication.",
		};
	}

	// 未知认证类型
	return {
		requiresAuth: true,
		authType: "unknown",
		authServerUrl,
		message: "Server requires authentication but type could not be determined.",
	};
}

/**
 * Try to discover OAuth endpoints by querying the server's well-known endpoints.
 * 尝试通过查询服务器的知名端点来发现 OAuth 端点。
 * This is a fallback when error responses don't include OAuth metadata.
 * 当错误响应不包含 OAuth 元数据时作为回退方案。
 */
export async function discoverOAuthEndpoints(
	serverUrl: string,
	authServerUrl?: string,
): Promise<OAuthEndpoints | null> {
	const wellKnownPaths = [
		"/.well-known/oauth-authorization-server",
		"/.well-known/openid-configuration",
		"/.well-known/oauth-protected-resource",
		"/oauth/metadata",
		"/.mcp/auth",
		"/authorize", // Some MCP servers expose OAuth config here
	];
	const urlsToQuery = [authServerUrl, serverUrl].filter((value): value is string => Boolean(value));
	const visitedAuthServers = new Set<string>();

	const findEndpoints = (metadata: Record<string, unknown>): OAuthEndpoints | null => {
		if (metadata.authorization_endpoint && metadata.token_endpoint) {
			const scopesSupported = Array.isArray(metadata.scopes_supported)
				? metadata.scopes_supported.filter((scope): scope is string => typeof scope === "string").join(" ")
				: undefined;
			return {
				authorizationUrl: String(metadata.authorization_endpoint),
				tokenUrl: String(metadata.token_endpoint),
				clientId:
					typeof metadata.client_id === "string"
						? metadata.client_id
						: typeof metadata.clientId === "string"
							? metadata.clientId
							: typeof metadata.default_client_id === "string"
								? metadata.default_client_id
								: typeof metadata.public_client_id === "string"
									? metadata.public_client_id
									: undefined,
				scopes:
					scopesSupported ||
					(typeof metadata.scopes === "string"
						? metadata.scopes
						: typeof metadata.scope === "string"
							? metadata.scope
							: undefined),
			};
		}

		if (metadata.oauth || metadata.authorization || metadata.auth) {
			const oauthData = (metadata.oauth || metadata.authorization || metadata.auth) as Record<string, unknown>;
			if (typeof oauthData.authorization_url === "string" && typeof oauthData.token_url === "string") {
				return {
					authorizationUrl: oauthData.authorization_url || String(oauthData.authorizationUrl),
					tokenUrl: oauthData.token_url || String(oauthData.tokenUrl),
					clientId:
						typeof oauthData.client_id === "string"
							? oauthData.client_id
							: typeof oauthData.clientId === "string"
								? oauthData.clientId
								: typeof oauthData.default_client_id === "string"
									? oauthData.default_client_id
									: typeof oauthData.public_client_id === "string"
										? oauthData.public_client_id
										: undefined,
					scopes:
						typeof oauthData.scopes === "string"
							? oauthData.scopes
							: typeof oauthData.scope === "string"
								? oauthData.scope
								: undefined,
				};
			}
		}

		return null;
	};

	for (const baseUrl of urlsToQuery) {
		visitedAuthServers.add(baseUrl);
		for (const path of wellKnownPaths) {
			try {
				const url = new URL(path, baseUrl);
				const response = await fetch(url.toString(), {
					method: "GET",
					headers: { Accept: "application/json" },
				});

				if (response.ok) {
					const metadata = (await response.json()) as Record<string, unknown>;
					const endpoints = findEndpoints(metadata);
					if (endpoints) return endpoints;

					if (path === "/.well-known/oauth-protected-resource") {
						const authServers = Array.isArray(metadata.authorization_servers)
							? metadata.authorization_servers.filter((entry): entry is string => typeof entry === "string")
							: [];

						for (const discoveredAuthServer of authServers) {
							if (visitedAuthServers.has(discoveredAuthServer)) {
								continue;
							}
							const discovered = await discoverOAuthEndpoints(serverUrl, discoveredAuthServer);
							if (discovered) return discovered;
						}
					}
				}
			} catch {
				// Ignore errors, try next path
			}
		}
	}

	return null;
}



/**
 * Feature bracket parser for plugin specifiers.
 *
 * Supports syntax like:
 * - "my-plugin" -> base features (null)
 * - "my-plugin[search,web]" -> specific features
 * - "my-plugin[*]" -> all features
 * - "my-plugin[]" -> no optional features
 * - "@scope/plugin@1.2.3[feat]" -> scoped with version and features
 *
 * 插件 specifier 中括号特性语法解析器。
 * 支持：
 * - "my-plugin"              -> 基础特性（null）
 * - "my-plugin[search,web]"  -> 指定特性
 * - "my-plugin[*]"           -> 所有特性
 * - "my-plugin[]"            -> 不启用任何可选特性
 * - "@scope/plugin@1.2.3[feat]" -> 带 scope、版本及特性
 */

/** 解析后的插件 specifier 结构 */
export interface ParsedPluginSpec {
	/** Package name (may include version specifier like @1.0.0) */
	packageName: string;
	/**
	 * Feature selection:
	 * - null: use defaults (base features on first install, preserve on reinstall)
	 * - "*": all features
	 * - string[]: specific features (empty array = no optional features)
	 */
	features: string[] | null | "*";
}

/**
 * Parse plugin specifier with feature bracket syntax.
 *
 * 解析带特性括号语法的插件 specifier。
 *
 * @example
 * parsePluginSpec("my-plugin") // { packageName: "my-plugin", features: null }
 * parsePluginSpec("my-plugin[search,web]") // { packageName: "my-plugin", features: ["search", "web"] }
 * parsePluginSpec("my-plugin[*]") // { packageName: "my-plugin", features: "*" }
 * parsePluginSpec("my-plugin[]") // { packageName: "my-plugin", features: [] }
 * parsePluginSpec("@scope/pkg@1.2.3[feat]") // { packageName: "@scope/pkg@1.2.3", features: ["feat"] }
 */
export function parsePluginSpec(spec: string): ParsedPluginSpec {
	// Find the last bracket pair (to handle version specifiers like @1.0.0)
	// 取最后一对中括号（避免与版本号 @1.0.0 等混淆）
	const bracketStart = spec.lastIndexOf("[");
	const bracketEnd = spec.lastIndexOf("]");

	// No brackets or malformed -> base features
	// 没有括号或格式错误 -> 仅启用基础特性
	if (bracketStart === -1 || bracketEnd === -1 || bracketEnd < bracketStart) {
		return { packageName: spec, features: null };
	}

	const packageName = spec.slice(0, bracketStart);
	const featureStr = spec.slice(bracketStart + 1, bracketEnd).trim();

	// All features
	// "*" 表示启用全部特性
	if (featureStr === "*") {
		return { packageName, features: "*" };
	}

	// No optional features
	// 空括号表示不启用任何可选特性
	if (featureStr === "") {
		return { packageName, features: [] };
	}

	// Specific features (comma-separated)
	// 按逗号分隔的特性名列表
	const features = featureStr
		.split(",")
		.map(f => f.trim())
		.filter(Boolean);

	return { packageName, features };
}

/**
 * Format a parsed plugin spec back to string form.
 *
 * 将解析后的插件 spec 还原为字符串形式。
 *
 * @example
 * formatPluginSpec({ packageName: "pkg", features: null }) // "pkg"
 * formatPluginSpec({ packageName: "pkg", features: "*" }) // "pkg[*]"
 * formatPluginSpec({ packageName: "pkg", features: [] }) // "pkg[]"
 * formatPluginSpec({ packageName: "pkg", features: ["a", "b"] }) // "pkg[a,b]"
 */
export function formatPluginSpec(spec: ParsedPluginSpec): string {
	if (spec.features === null) {
		return spec.packageName;
	}
	if (spec.features === "*") {
		return `${spec.packageName}[*]`;
	}
	if (spec.features.length === 0) {
		return `${spec.packageName}[]`;
	}
	return `${spec.packageName}[${spec.features.join(",")}]`;
}

/**
 * Extract the base package name without version specifier.
 * Used for path lookups after npm install.
 *
 * 从 specifier 中提取去除版本号后的纯包名，用于 npm install 后的路径定位。
 *
 * @example
 * extractPackageName("lodash@4.17.21") // "lodash"
 * extractPackageName("@scope/pkg@1.0.0") // "@scope/pkg"
 * extractPackageName("@scope/pkg") // "@scope/pkg"
 */
export function extractPackageName(specifier: string): string {
	// Handle scoped packages: @scope/name@version -> @scope/name
	// 处理 scope 包：@scope/name@version -> @scope/name
	if (specifier.startsWith("@")) {
		const match = specifier.match(/^(@[^/]+\/[^@]+)/);
		return match ? match[1] : specifier;
	}
	// Unscoped: name@version -> name
	// 非 scope 包：name@version -> name
	return specifier.replace(/@[^@]+$/, "");
}


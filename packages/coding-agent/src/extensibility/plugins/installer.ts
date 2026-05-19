
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getProjectDir, isEnoent } from "@oh-my-pi/pi-utils";
import { extractPackageName } from "./parser";
import type { InstalledPlugin } from "./types";

// 插件根目录（位于 agent dir 下的 plugins/ 子目录）
const PLUGINS_DIR = path.join(getAgentDir(), "plugins");

// Valid npm package name pattern (scoped and unscoped)
// 合法 npm 包名正则（同时支持 scope 与普通包）
const VALID_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-z0-9-._^~>=<]+)?$/i;

/**
 * Validate package name to prevent command injection
 *
 * 校验包名以防止命令注入。
 */
function validatePackageName(name: string): void {
	if (!VALID_PACKAGE_NAME.test(name)) {
		throw new Error(`Invalid package name: ${name}`);
	}
	// Extra safety: no shell metacharacters
	// 额外保险：禁止包名中出现 shell 元字符
	if (/[;&|`$(){}[\]<>\\]/.test(name)) {
		throw new Error(`Invalid characters in package name: ${name}`);
	}
}

/**
 * Ensure the plugins directory exists
 *
 * 确保 plugins 根目录及其 node_modules 已存在。
 */
async function ensurePluginsDir(): Promise<void> {
	await fs.mkdir(PLUGINS_DIR, { recursive: true });
	await fs.mkdir(path.join(PLUGINS_DIR, "node_modules"), { recursive: true });
}

/** 安装 npm 插件包并返回基本元数据 */
export async function installPlugin(packageName: string): Promise<InstalledPlugin> {
	// Validate package name to prevent command injection
	// 校验包名以阻止命令注入
	validatePackageName(packageName);

	// Ensure plugins directory exists
	// 确保 plugins 目录存在
	await ensurePluginsDir();

	// Initialize package.json if it doesn't exist
	// 首次使用时自动创建 package.json 占位
	const pkgJsonPath = path.join(PLUGINS_DIR, "package.json");
	const pkgJson = Bun.file(pkgJsonPath);
	if (!(await pkgJson.exists())) {
		await pkgJson.write(JSON.stringify({ name: "omp-plugins", private: true, dependencies: {} }, null, 2));
	}

	// Run npm install in plugins directory
	// 在 plugins 目录中执行 bun install
	const proc = Bun.spawn(["bun", "install", packageName], {
		cwd: PLUGINS_DIR,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`Failed to install ${packageName}: ${stderr}`);
	}

	// Extract the actual package name (without version specifier) for path lookup
	// 提取不含版本号的真实包名，用于路径定位
	const actualName = extractPackageName(packageName);

	// Read the installed package's package.json
	// 读取已安装包的 package.json
	const pkgPath = path.join(PLUGINS_DIR, "node_modules", actualName, "package.json");
	const pkgFile = Bun.file(pkgPath);
	if (!(await pkgFile.exists())) {
		throw new Error(`Package installed but package.json not found at ${pkgPath}`);
	}

	const pkg = await pkgFile.json();

	return {
		name: pkg.name,
		version: pkg.version,
		path: path.join(PLUGINS_DIR, "node_modules", actualName),
		manifest: pkg.omp || pkg.pi || { version: pkg.version },
		enabledFeatures: null,
		enabled: true,
	};
}

/** 卸载已安装插件包 */
export async function uninstallPlugin(name: string): Promise<void> {
	// Validate package name
	// 校验包名
	validatePackageName(name);

	await ensurePluginsDir();

	const proc = Bun.spawn(["bun", "uninstall", name], {
		cwd: PLUGINS_DIR,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Failed to uninstall ${name}`);
	}
}

/** 列出 plugins 目录下所有已安装包 */
export async function listPlugins(): Promise<InstalledPlugin[]> {
	const pkgJsonPath = Bun.file(path.join(PLUGINS_DIR, "package.json"));
	if (!(await pkgJsonPath.exists())) {
		return [];
	}

	const pkg = await pkgJsonPath.json();
	const deps = pkg.dependencies || {};

	const plugins: InstalledPlugin[] = [];
	for (const [name, _version] of Object.entries(deps)) {
		const pluginPath = path.join(PLUGINS_DIR, "node_modules", name);
		const fpkg = Bun.file(path.join(pluginPath, "package.json"));
		if (await fpkg.exists()) {
			const pkg = await fpkg.json();
			plugins.push({
				name,
				version: pkg.version,
				path: pluginPath,
				manifest: pkg.omp || pkg.pi || { version: pkg.version },
				enabledFeatures: null,
				enabled: true,
			});
		}
	}

	return plugins;
}

/** 将本地路径下的插件通过 symlink 链接到 plugins 目录 */
export async function linkPlugin(localPath: string): Promise<void> {
	const cwd = getProjectDir();
	const absolutePath = path.resolve(cwd, localPath);

	// Validate that resolved path is within cwd to prevent path traversal
	// 校验路径不会逃逸出当前工作目录，防止路径穿越
	const normalizedCwd = path.resolve(cwd);
	const normalizedPath = path.resolve(absolutePath);
	if (!normalizedPath.startsWith(`${normalizedCwd}/`) && normalizedPath !== normalizedCwd) {
		throw new Error(`Invalid path: ${localPath} resolves outside working directory`);
	}

	// Validate package.json exists
	// 校验 package.json 存在
	const pkgFile = Bun.file(path.join(absolutePath, "package.json"));
	if (!(await pkgFile.exists())) {
		throw new Error(`package.json not found at ${absolutePath}`);
	}

	let pkg: { name?: string };
	try {
		pkg = await pkgFile.json();
	} catch (err) {
		throw new Error(`Invalid package.json at ${absolutePath}: ${err}`);
	}

	if (!pkg.name || typeof pkg.name !== "string") {
		throw new Error("package.json must have a valid name field");
	}

	// Validate package name to prevent path traversal via pkg.name
	// 校验包名以防止通过 pkg.name 形式的路径穿越（scope 包允许且仅允许一个斜杠）
	if (pkg.name.includes("..") || pkg.name.includes("/") || pkg.name.includes("\\")) {
		// Exception: scoped packages have one slash
		if (!pkg.name.startsWith("@") || (pkg.name.match(/\//g) || []).length !== 1) {
			throw new Error(`Invalid package name in package.json: ${pkg.name}`);
		}
	}

	await ensurePluginsDir();

	// Create symlink in plugins/node_modules
	// 在 plugins/node_modules 下创建 symlink
	const linkPath = path.join(PLUGINS_DIR, "node_modules", pkg.name);

	// For scoped packages, ensure the scope directory exists
	// scope 包需先确保 scope 目录存在
	if (pkg.name.startsWith("@")) {
		const scopeDir = path.join(PLUGINS_DIR, "node_modules", pkg.name.split("/")[0]);
		await fs.mkdir(scopeDir, { recursive: true });
	}

	// Remove existing if present
	// 若已存在则先移除（symlink 或目录）
	try {
		const stats = await fs.lstat(linkPath);
		if (stats.isSymbolicLink() || stats.isDirectory()) {
			await fs.unlink(linkPath);
		}
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}

	// Create symlink using fs instead of shell command
	// 使用 fs 而非 shell 命令创建 symlink，避免命令注入
	await fs.symlink(absolutePath, linkPath);
}


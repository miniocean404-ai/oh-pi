
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core"
import { logger, once, prompt, untilAborted } from "@oh-my-pi/pi-utils"
import type { BunFile } from "bun"
import * as fs from "node:fs"
import path from "node:path"
import { type Theme, theme } from "../modes/theme/theme"
import lspDescription from "../prompts/tools/lsp.md" with { type: "text" }
import type { ToolSession } from "../tools"
import { formatPathRelativeToCwd, resolveToCwd } from "../tools/path-utils"
import { throwIfAborted, ToolAbortError } from "../tools/tool-errors"
import { clampTimeout } from "../tools/tool-timeouts"
import {
  ensureFileOpen,
  getActiveClients,
  getOrCreateClient,
  type LspServerStatus,
  notifySaved,
  refreshFile,
  sendNotification,
  sendRequest,
  setIdleTimeout,
  syncContent,
  waitForProjectLoaded,
  WARMUP_TIMEOUT_MS,
} from "./client"
import { getLinterClient } from "./clients"
import { getServersForFile, loadConfig, type LspConfig } from "./config"
import { applyTextEditsToString, applyWorkspaceEdit } from "./edits"
import { detectLspmux } from "./lspmux"
import { renderCall, renderResult } from "./render"
import {
  type CodeAction,
  type CodeActionContext,
  type Command,
  type Diagnostic,
  type DocumentSymbol,
  type Hover,
  type Location,
  type LocationLink,
  type LspClient,
  type LspParams,
  lspSchema,
  type LspToolDetails,
  type Position,
  type PublishedDiagnostics,
  type ServerConfig,
  type SymbolInformation,
  type TextEdit,
  type WorkspaceEdit,
} from "./types"
import {
  applyCodeAction,
  dedupeWorkspaceSymbols,
  extractHoverText,
  fileToUri,
  filterWorkspaceSymbols,
  formatCodeAction,
  formatDiagnostic,
  formatDiagnosticsSummary,
  formatDocumentSymbol,
  formatGroupedDiagnosticMessages,
  formatLocation,
  formatSymbolInformation,
  formatWorkspaceEdit,
  readLocationContext,
  resolveDiagnosticTargets,
  resolveSymbolColumn,
  sortDiagnostics,
  symbolKindToIcon,
  uriToFile,
} from "./utils"

export type { LspServerStatus } from "./client"
export type { LspToolDetails } from "./types"

/** LSP 启动时的服务器信息 */
export interface LspStartupServerInfo {
  name: string
  status: "connecting" | "ready" | "error"
  fileTypes: string[]
  error?: string
}

/** Result from warming up LSP servers */
/** LSP 服务器预热结果 */
export interface LspWarmupResult {
  servers: Array<LspStartupServerInfo & { status: "ready" | "error" }>
}

/** Options for warming up LSP servers */
/** LSP 服务器预热选项 */
export interface LspWarmupOptions {
  /** Called when starting to connect to servers */
  /** 开始连接服务器时的回调 */
  onConnecting?: (serverNames: string[]) => void
}

/** 发现启动时可用的 LSP 服务器列表 */
export function discoverStartupLspServers(cwd: string): LspStartupServerInfo[] {
  const config = loadConfig(cwd)
  return getLspServers(config).map(([name, serverConfig]) => ({
    name,
    status: "connecting",
    fileTypes: serverConfig.fileTypes,
  }))
}

/**
 * Warm up LSP servers for a directory by connecting to all detected servers.
 * This should be called at startup to avoid cold-start delays.
 * 预热目录下的 LSP 服务器，连接所有检测到的服务器。应在启动时调用以避免冷启动延迟。
 *
 * @param cwd - Working directory to detect and start servers for
 * @param options - Optional callbacks for progress reporting
 * @returns Status of each server that was started
 */
export async function warmupLspServers(cwd: string, options?: LspWarmupOptions): Promise<LspWarmupResult> {
  const config = loadConfig(cwd)
  setIdleTimeout(config.idleTimeoutMs)
  const servers: LspWarmupResult["servers"] = []
  const lspServers = getLspServers(config)

  // Notify caller which servers we're connecting to
  if (lspServers.length > 0 && options?.onConnecting) {
    options.onConnecting(lspServers.map(([name]) => name))
  }

  // Start all detected servers in parallel with a short timeout
  // Servers that don't respond quickly will be initialized lazily on first use
  const results = await Promise.allSettled(
    lspServers.map(async ([name, serverConfig]) => {
      const client = await getOrCreateClient(serverConfig, cwd, serverConfig.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS)
      return { name, client, fileTypes: serverConfig.fileTypes }
    }),
  )

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const [name, serverConfig] = lspServers[i]
    if (result.status === "fulfilled") {
      servers.push({
        name: result.value.name,
        status: "ready",
        fileTypes: result.value.fileTypes,
      })
    } else {
      const errorMsg = result.reason?.message ?? String(result.reason)
      logger.warn("LSP server failed to start", { server: name, error: errorMsg })
      servers.push({
        name,
        status: "error",
        fileTypes: serverConfig.fileTypes,
        error: errorMsg,
      })
    }
  }

  return { servers }
}

/**
 * Get status of currently active LSP servers.
 * 获取当前活跃 LSP 服务器的状态
 */
export function getLspStatus(): LspServerStatus[] {
  return getActiveClients()
}

/**
 * Sync in-memory file content to all applicable LSP servers.
 * Sends didOpen (if new) or didChange (if already open).
 * 将内存中的文件内容同步到所有适用的 LSP 服务器，发送 didOpen 或 didChange 通知。
 *
 * @param absolutePath - Absolute path to the file
 * @param content - The new file content
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to sync to
 */
async function syncFileContent(
  absolutePath: string,
  content: string,
  cwd: string,
  servers: Array<[string, ServerConfig]>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  await Promise.allSettled(
    servers.map(async ([_serverName, serverConfig]) => {
      throwIfAborted(signal)
      if (serverConfig.createClient) {
        return
      }
      const client = await getOrCreateClient(serverConfig, cwd)
      throwIfAborted(signal)
      await syncContent(client, absolutePath, content, signal)
    }),
  )
}

/**
 * Notify all LSP servers that a file was saved.
 * Assumes content was already synced via syncFileContent.
 * 通知所有 LSP 服务器文件已保存。假定内容已通过 syncFileContent 同步。
 *
 * @param absolutePath - Absolute path to the file
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to notify
 */
async function notifyFileSaved(
  absolutePath: string,
  cwd: string,
  servers: Array<[string, ServerConfig]>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  await Promise.allSettled(
    servers.map(async ([_serverName, serverConfig]) => {
      throwIfAborted(signal)
      if (serverConfig.createClient) {
        return
      }
      const client = await getOrCreateClient(serverConfig, cwd)
      await notifySaved(client, absolutePath, signal)
    }),
  )
}

// 按工作目录缓存配置，避免重复文件 I/O
const configCache = new Map<string, LspConfig>()

/** 获取或加载指定工作目录的 LSP 配置 */
function getConfig(cwd: string): LspConfig {
  let config = configCache.get(cwd)
  if (!config) {
    config = loadConfig(cwd)
    setIdleTimeout(config.idleTimeoutMs)
    configCache.set(cwd, config)
  }
  return config
}

/** 判断服务器是否为自定义代码检查器 */
function isCustomLinter(serverConfig: ServerConfig): boolean {
  return Boolean(serverConfig.createClient)
}

/** 将服务器列表拆分为 LSP 服务器和自定义代码检查器 */
function splitServers(servers: Array<[string, ServerConfig]>): {
  lspServers: Array<[string, ServerConfig]>
  customLinterServers: Array<[string, ServerConfig]>
} {
  const lspServers: Array<[string, ServerConfig]> = []
  const customLinterServers: Array<[string, ServerConfig]> = []
  for (const entry of servers) {
    if (isCustomLinter(entry[1])) {
      customLinterServers.push(entry)
    } else {
      lspServers.push(entry)
    }
  }
  return { lspServers, customLinterServers }
}

/** 获取所有非自定义检查器的 LSP 服务器 */
function getLspServers(config: LspConfig): Array<[string, ServerConfig]> {
  return (Object.entries(config.servers) as Array<[string, ServerConfig]>).filter(
    ([, serverConfig]) => !isCustomLinter(serverConfig),
  )
}

/** 获取指定文件适用的 LSP 服务器（不含自定义检查器） */
function getLspServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
  return getServersForFile(config, filePath).filter(([, serverConfig]) => !isCustomLinter(serverConfig))
}

/** 获取指定文件的主 LSP 服务器 */
function getLspServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
  const servers = getLspServersForFile(config, filePath)
  return servers.length > 0 ? servers[0] : null
}

/** 判断是否为项目感知型 LSP 服务器（非自定义检查器且非代码检查器） */
function isProjectAwareLspServer(serverConfig: ServerConfig): boolean {
  return !serverConfig.createClient && !serverConfig.isLinter
}

/** 诊断消息数量上限 */
const DIAGNOSTIC_MESSAGE_LIMIT = 50
/** 单文件诊断等待超时（毫秒） */
const SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 3000
/** 批量诊断等待超时（毫秒） */
const BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS = 400
/** glob 模式最大匹配文件数 */
const MAX_GLOB_DIAGNOSTIC_TARGETS = 20
/** 工作区符号查询结果上限 */
const WORKSPACE_SYMBOL_LIMIT = 200

/** 限制诊断消息数量 */
function limitDiagnosticMessages(messages: string[]): string[] {
  if (messages.length <= DIAGNOSTIC_MESSAGE_LIMIT) {
    return messages
  }
  return messages.slice(0, DIAGNOSTIC_MESSAGE_LIMIT)
}

/** 位置上下文行数 */
const LOCATION_CONTEXT_LINES = 1
/** 引用上下文显示限制数 */
const REFERENCE_CONTEXT_LIMIT = 50

/** 引用查询重试次数 */
const REFERENCES_RETRY_COUNT = 2
/** 引用查询重试间隔（毫秒） */
const REFERENCES_RETRY_DELAY_MS = 250

/** 比较两个位置 */
function comparePosition(a: Position, b: Position): number {
  return a.line === b.line ? a.character - b.character : a.line - b.line
}

/** 判断范围是否包含指定位置 */
function rangeContainsPosition(range: Location["range"], position: Position): boolean {
  return comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) <= 0
}

/** 判断结果是否仅包含查询位置处的声明本身 */
function isOnlyQueriedDeclaration(locations: Location[], uri: string, position: Position): boolean {
  return locations.length === 1 && locations[0]?.uri === uri && rangeContainsPosition(locations[0].range, position)
}

/** 标准化位置结果（Location 或 LocationLink）为统一的 Location 数组 */
function normalizeLocationResult(result: Location | Location[] | LocationLink | LocationLink[] | null): Location[] {
  if (!result) return []
  const raw = Array.isArray(result) ? result : [result]
  return raw.flatMap((loc) => {
    if ("uri" in loc) {
      return [loc as Location]
    }
    if ("targetUri" in loc) {
      const link = loc as LocationLink
      return [{ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange }]
    }
    return []
  })
}

/** 格式化位置信息（带上下文代码行） */
async function formatLocationWithContext(location: Location, cwd: string): Promise<string> {
  const header = `  ${formatLocation(location, cwd)}`
  const context = await readLocationContext(
    uriToFile(location.uri),
    location.range.start.line + 1,
    LOCATION_CONTEXT_LINES,
  )
  if (context.length === 0) {
    return header
  }
  return `${header}\n${context.map((lineText) => `    ${lineText}`).join("\n")}`
}

/** 最大重命名文件对数 */
const MAX_RENAME_PAIRS = 1000

/** 文件重命名对（旧 URI 和新 URI） */
interface FileRenamePair {
  oldUri: string
  newUri: string
}

/**
 * Enumerate the {oldUri, newUri} pairs needed for an LSP willRenameFiles/didRenameFiles request.
 * For files this is a single pair. For directories this walks every regular file underneath
 * and produces a parallel pair anchored at the new directory root.
 * 枚举 LSP willRenameFiles/didRenameFiles 请求所需的 {oldUri, newUri} 对。
 * 文件为单对，目录则遍历所有子文件并生成对应的重命名对。
 */
async function enumerateRenamePairs(
  source: string,
  dest: string,
): Promise<{ pairs: FileRenamePair[]; directory: boolean; exceeded: boolean }> {
  const stat = await fs.promises.stat(source)
  if (!stat.isDirectory()) {
    return {
      pairs: [{ oldUri: fileToUri(source), newUri: fileToUri(dest) }],
      directory: false,
      exceeded: false,
    }
  }
  const entries = await fs.promises.readdir(source, { recursive: true, withFileTypes: true })
  const pairs: FileRenamePair[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (pairs.length >= MAX_RENAME_PAIRS) {
      return { pairs, directory: true, exceeded: true }
    }
    const parent = entry.parentPath ?? source
    const absOld = path.join(parent, entry.name)
    const rel = path.relative(source, absOld)
    pairs.push({
      oldUri: fileToUri(absOld),
      newUri: fileToUri(path.join(dest, rel)),
    })
  }
  return { pairs, directory: true, exceeded: false }
}

/** True when an LSP error indicates the server doesn't implement the requested method. */
/** 当 LSP 错误表示服务器未实现请求的方法时返回 true */
function isMethodNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return (
    msg.includes("method not found") ||
    msg.includes("unhandled method") ||
    msg.includes("not supported") ||
    msg.includes("-32601")
  )
}

/** 重新加载 LSP 服务器（尝试重载命令或重启进程） */
async function reloadServer(client: LspClient, serverName: string, signal?: AbortSignal): Promise<string> {
  let output = `Restarted ${serverName}`
  const reloadMethods = ["rust-analyzer/reloadWorkspace", "workspace/didChangeConfiguration"]
  for (const method of reloadMethods) {
    try {
      await sendRequest(client, method, method.includes("Configuration") ? { settings: {} } : null, signal)
      output = `Reloaded ${serverName}`
      break
    } catch {
      // Method not supported, try next
    }
  }
  if (output.startsWith("Restarted")) {
    client.proc.kill()
  }
  return output
}

/** 等待诊断信息的选项 */
interface WaitForDiagnosticsOptions {
  timeoutMs?: number
  signal?: AbortSignal
  minVersion?: number
  expectedDocumentVersion?: number
  allowUnversioned?: boolean
}

/** 获取可接受的诊断信息（根据版本号判断是否过期） */
function getAcceptedDiagnostics(
  publishedDiagnostics: PublishedDiagnostics | undefined,
  expectedDocumentVersion?: number,
  allowUnversioned = true,
): Diagnostic[] | undefined {
  if (!publishedDiagnostics) {
    return undefined
  }
  if (expectedDocumentVersion === undefined) {
    return publishedDiagnostics.diagnostics
  }
  if (publishedDiagnostics.version === expectedDocumentVersion) {
    return publishedDiagnostics.diagnostics
  }
  if (allowUnversioned && publishedDiagnostics.version == null) {
    return publishedDiagnostics.diagnostics
  }
  return undefined
}

/** 轮询等待诊断信息更新 */
async function waitForDiagnostics(
  client: LspClient,
  uri: string,
  options: WaitForDiagnosticsOptions = {},
): Promise<Diagnostic[]> {
  const { timeoutMs = 3000, signal, minVersion, expectedDocumentVersion, allowUnversioned = true } = options
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    throwIfAborted(signal)
    const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion
    const diagnostics = getAcceptedDiagnostics(client.diagnostics.get(uri), expectedDocumentVersion, allowUnversioned)
    if (diagnostics !== undefined && versionOk) {
      return diagnostics
    }
    await Bun.sleep(100)
  }
  const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion
  if (!versionOk) {
    return []
  }
  return getAcceptedDiagnostics(client.diagnostics.get(uri), expectedDocumentVersion, allowUnversioned) ?? []
}

/** Project type detection result */
/** 项目类型检测结果 */
interface ProjectType {
  type: "rust" | "typescript" | "go" | "python" | "unknown"
  command?: string[]
  description: string
}

/** Detect project type from root markers */
/** 根据根标记文件检测项目类型 */
function detectProjectType(cwd: string): ProjectType {
  // Check for Rust (Cargo.toml)
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
    return { type: "rust", command: ["cargo", "check", "--message-format=short"], description: "Rust (cargo check)" }
  }

  // Check for TypeScript (tsconfig.json)
  if (fs.existsSync(path.join(cwd, "tsconfig.json"))) {
    return { type: "typescript", command: ["npx", "tsc", "--noEmit"], description: "TypeScript (tsc --noEmit)" }
  }

  // Check for Go (go.mod)
  if (fs.existsSync(path.join(cwd, "go.mod"))) {
    return { type: "go", command: ["go", "build", "./..."], description: "Go (go build)" }
  }

  // Check for Python (pyproject.toml or pyrightconfig.json)
  if (fs.existsSync(path.join(cwd, "pyproject.toml")) || fs.existsSync(path.join(cwd, "pyrightconfig.json"))) {
    return { type: "python", command: ["pyright"], description: "Python (pyright)" }
  }

  return { type: "unknown", description: "Unknown project type" }
}

/** Run workspace diagnostics command and parse output */
/** 运行工作区诊断命令并解析输出 */
async function runWorkspaceDiagnostics(
  cwd: string,
  signal?: AbortSignal,
): Promise<{ output: string; projectType: ProjectType }> {
  throwIfAborted(signal)
  const projectType = detectProjectType(cwd)
  if (!projectType.command) {
    return {
      output: `Cannot detect project type. Supported: Rust (Cargo.toml), TypeScript (tsconfig.json), Go (go.mod), Python (pyproject.toml)`,
      projectType,
    }
  }
  const proc = Bun.spawn(projectType.command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const abortHandler = () => {
    proc.kill()
  }
  if (signal) {
    signal.addEventListener("abort", abortHandler, { once: true })
  }

  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    throwIfAborted(signal)
    const combined = (stdout + stderr).trim()
    if (!combined) {
      return { output: "No issues found", projectType }
    }
    // Limit output length
    const lines = combined.split("\n")
    if (lines.length > 50) {
      return { output: `${lines.slice(0, 50).join("\n")}\n... and ${lines.length - 50} more lines`, projectType }
    }
    return { output: combined, projectType }
  } catch (e) {
    if (signal?.aborted) {
      throw new ToolAbortError()
    }
    return { output: `Failed to run ${projectType.command.join(" ")}: ${e}`, projectType }
  } finally {
    signal?.removeEventListener("abort", abortHandler)
  }
}

/** Result from getDiagnosticsForFile */
/** 文件诊断结果 */
export interface FileDiagnosticsResult {
  /** Name of the LSP server used (if available) */
  /** 使用的 LSP 服务器名称 */
  server?: string
  /** Formatted diagnostic messages */
  /** 格式化后的诊断消息 */
  messages: string[]
  /** Summary string (e.g., "2 error(s), 1 warning(s)") */
  /** 摘要字符串 */
  summary: string
  /** Whether there are any errors (severity 1) */
  /** 是否有错误（严重级别 1） */
  errored: boolean
  /** Whether the file was formatted */
  /** 文件是否被格式化 */
  formatter?: FileFormatResult
}

/** 服务器版本号映射 */
type ServerVersionMap = Map<string, number>

/** 获取文件诊断信息的选项 */
interface GetDiagnosticsForFileOptions {
  signal?: AbortSignal
  minVersions?: ServerVersionMap
  expectedDocumentVersions?: ServerVersionMap
  allowUnversionedLspDiagnostics?: boolean
}

/**
 * Capture current diagnostic versions for all LSP servers.
 * Call this BEFORE syncing content to detect stale diagnostics later.
 * 捕获所有 LSP 服务器当前的诊断版本号，应在同步内容之前调用以便后续检测过期诊断。
 */
async function captureDiagnosticVersions(
  cwd: string,
  servers: Array<[string, ServerConfig]>,
): Promise<ServerVersionMap> {
  const versions = new Map<string, number>()
  await Promise.allSettled(
    servers.map(async ([serverName, serverConfig]) => {
      if (serverConfig.createClient) return
      const client = await getOrCreateClient(serverConfig, cwd)
      versions.set(serverName, client.diagnosticsVersion)
    }),
  )
  return versions
}

/** 捕获已打开文件在各服务器中的版本号 */
async function captureOpenFileVersions(
  absolutePath: string,
  cwd: string,
  servers: Array<[string, ServerConfig]>,
): Promise<ServerVersionMap> {
  const uri = fileToUri(absolutePath)
  const versions = new Map<string, number>()
  await Promise.allSettled(
    servers.map(async ([serverName, serverConfig]) => {
      const client = await getOrCreateClient(serverConfig, cwd)
      const version = client.openFiles.get(uri)?.version
      if (version !== undefined) {
        versions.set(serverName, version)
      }
    }),
  )
  return versions
}

/**
 * Get diagnostics for a file using LSP or custom linter client.
 * 通过 LSP 或自定义代码检查客户端获取文件的诊断信息。
 *
 * @param absolutePath - Absolute path to the file
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to query diagnostics for
 * @param minVersions - Minimum diagnostic versions per server (to detect stale results)
 * @returns Diagnostic results or undefined if no servers
 */
async function getDiagnosticsForFile(
  absolutePath: string,
  cwd: string,
  servers: Array<[string, ServerConfig]>,
  options: GetDiagnosticsForFileOptions = {},
): Promise<FileDiagnosticsResult | undefined> {
  const { signal, minVersions, expectedDocumentVersions, allowUnversionedLspDiagnostics = true } = options
  if (servers.length === 0) {
    return undefined
  }

  const uri = fileToUri(absolutePath)
  const relPath = formatPathRelativeToCwd(absolutePath, cwd)
  const allDiagnostics: Diagnostic[] = []
  const serverNames: string[] = []

  // Wait for diagnostics from all servers in parallel
  const results = await Promise.allSettled(
    servers.map(async ([serverName, serverConfig]) => {
      throwIfAborted(signal)
      // Use custom linter client if configured
      if (serverConfig.createClient) {
        const linterClient = getLinterClient(serverName, serverConfig, cwd)
        const diagnostics = await linterClient.lint(absolutePath)
        return { serverName, diagnostics }
      }

      // Default: use LSP
      const client = await getOrCreateClient(serverConfig, cwd)
      throwIfAborted(signal)
      if (isProjectAwareLspServer(serverConfig)) {
        await waitForProjectLoaded(client, signal)
        throwIfAborted(signal)
      }
      // Content already synced + didSave sent, wait for fresh diagnostics
      const minVersion = minVersions?.get(serverName)
      const expectedDocumentVersion = expectedDocumentVersions?.get(serverName)
      const diagnostics = await waitForDiagnostics(client, uri, {
        timeoutMs: 3000,
        signal,
        minVersion,
        expectedDocumentVersion,
        allowUnversioned: allowUnversionedLspDiagnostics,
      })
      return { serverName, diagnostics }
    }),
  )

  for (const result of results) {
    if (result.status === "fulfilled") {
      serverNames.push(result.value.serverName)
      allDiagnostics.push(...result.value.diagnostics)
    }
  }

  if (serverNames.length === 0) {
    return undefined
  }

  if (allDiagnostics.length === 0) {
    return {
      server: serverNames.join(", "),
      messages: [],
      summary: "OK",
      errored: false,
    }
  }

  // Deduplicate diagnostics by range + message (different servers might report similar issues)
  const seen = new Set<string>()
  const uniqueDiagnostics: Diagnostic[] = []
  for (const d of allDiagnostics) {
    const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.message}`
    if (!seen.has(key)) {
      seen.add(key)
      uniqueDiagnostics.push(d)
    }
  }

  sortDiagnostics(uniqueDiagnostics)
  const formatted = uniqueDiagnostics.map((d) => formatDiagnostic(d, relPath))
  const limited = limitDiagnosticMessages(formatted)
  const summary = formatDiagnosticsSummary(uniqueDiagnostics)
  const hasErrors = uniqueDiagnostics.some((d) => d.severity === 1)

  return {
    server: serverNames.join(", "),
    messages: limited,
    summary,
    errored: hasErrors,
  }
}

/** 文件格式化结果枚举 */
export enum FileFormatResult {
  UNCHANGED = "unchanged",
  FORMATTED = "formatted",
}

/** Default formatting options for LSP */
/** LSP 默认格式化选项 */
const DEFAULT_FORMAT_OPTIONS = {
  tabSize: 3,
  insertSpaces: true,
  trimTrailingWhitespace: true,
  insertFinalNewline: true,
  trimFinalNewlines: true,
}

/**
 * Format content using LSP or custom linter client.
 * 通过 LSP 或自定义代码检查客户端格式化内容。
 *
 * @param absolutePath - Absolute path (for URI)
 * @param content - Content to format
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to try formatting with
 * @returns Formatted content, or original if no formatter available
 */
async function formatContent(
  absolutePath: string,
  content: string,
  cwd: string,
  servers: Array<[string, ServerConfig]>,
  signal?: AbortSignal,
): Promise<string> {
  if (servers.length === 0) {
    return content
  }

  const uri = fileToUri(absolutePath)

  for (const [serverName, serverConfig] of servers) {
    try {
      throwIfAborted(signal)
      // Use custom linter client if configured
      if (serverConfig.createClient) {
        const linterClient = getLinterClient(serverName, serverConfig, cwd)
        return await linterClient.format(absolutePath, content)
      }

      // Default: use LSP
      const client = await getOrCreateClient(serverConfig, cwd)
      throwIfAborted(signal)

      const caps = client.serverCapabilities
      if (!caps?.documentFormattingProvider) {
        continue
      }

      // Request formatting (content already synced)
      const edits = (await sendRequest(
        client,
        "textDocument/formatting",
        {
          textDocument: { uri },
          options: DEFAULT_FORMAT_OPTIONS,
        },
        signal,
      )) as TextEdit[] | null

      if (!edits || edits.length === 0) {
        return content
      }

      // Apply edits in-memory and return
      return applyTextEditsToString(content, edits)
    } catch {}
  }

  return content
}

/** Options for creating the LSP writethrough callback */
/** LSP 写入透传回调的选项 */
export interface WritethroughOptions {
  /** Whether to format the file using LSP after writing */
  /** 写入后是否通过 LSP 格式化文件 */
  enableFormat?: boolean
  /** Whether to get LSP diagnostics after writing */
  /** 写入后是否获取 LSP 诊断信息 */
  enableDiagnostics?: boolean
  /** Called when diagnostics arrive after the main timeout. */
  /** 主超时后诊断信息到达时的回调 */
  onDeferredDiagnostics?: (diagnostics: FileDiagnosticsResult) => void
  /** Signal to cancel a pending deferred diagnostics fetch. */
  /** 取消待处理延迟诊断获取的信号 */
  deferredSignal?: AbortSignal
}

/** Internal resolved form of {@link WritethroughOptions} that the writethrough machinery operates on. */
/** 写入透传机制内部使用的已解析选项 */
type ResolvedWritethroughOptions = {
  enableFormat: boolean
  enableDiagnostics: boolean
}

/** Per-file deferred LSP diagnostics wiring for {@link WritethroughCallback}. */
/** 单文件延迟 LSP 诊断的连接句柄 */
export type WritethroughDeferredHandle = {
  onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void
  signal: AbortSignal
  finalize: (diagnostics: FileDiagnosticsResult | undefined) => void
}

/** Callback type for the LSP writethrough */
/** LSP 写入透传回调类型 */
export type WritethroughCallback = (
  dst: string,
  content: string,
  signal?: AbortSignal,
  file?: BunFile,
  batch?: LspWritethroughBatchRequest,
  getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
) => Promise<FileDiagnosticsResult | undefined>

/** No-op writethrough callback */
/** 空操作写入透传回调（仅写入文件） */
export async function writethroughNoop(
  dst: string,
  content: string,
  _signal?: AbortSignal,
  file?: BunFile,
  _batch?: LspWritethroughBatchRequest,
  _getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<FileDiagnosticsResult | undefined> {
  if (file) {
    await file.write(content)
  } else {
    await Bun.write(dst, content)
  }
  return undefined
}

/** 待处理的写入透传项 */
interface PendingWritethrough {
  dst: string
  content: string
  file?: BunFile
}

/** LSP 写入透传批处理请求 */
interface LspWritethroughBatchRequest {
  id: string
  flush: boolean
}

/** LSP 写入透传批处理状态 */
interface LspWritethroughBatchState {
  entries: Map<string, PendingWritethrough>
  options: ResolvedWritethroughOptions
}

/** 写入透传批处理缓存 */
const writethroughBatches = new Map<string, LspWritethroughBatchState>()

/** 获取或创建写入透传批处理状态 */
function getOrCreateWritethroughBatch(id: string, options: ResolvedWritethroughOptions): LspWritethroughBatchState {
  const existing = writethroughBatches.get(id)
  if (existing) {
    existing.options.enableFormat ||= options.enableFormat
    existing.options.enableDiagnostics ||= options.enableDiagnostics
    return existing
  }
  const batch: LspWritethroughBatchState = {
    entries: new Map<string, PendingWritethrough>(),
    options: { ...options },
  }
  writethroughBatches.set(id, batch)
  return batch
}

/** 刷新指定 ID 的写入透传批处理 */
export async function flushLspWritethroughBatch(
  id: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<FileDiagnosticsResult | undefined> {
  const state = writethroughBatches.get(id)
  if (!state) {
    return undefined
  }
  writethroughBatches.delete(id)
  return flushWritethroughBatch(Array.from(state.entries.values()), cwd, state.options, signal)
}

/** 从格式化的诊断消息中提取摘要统计 */
function summarizeDiagnosticMessages(messages: string[]): { summary: string; errored: boolean } {
  const counts = { error: 0, warning: 0, info: 0, hint: 0 }
  for (const message of messages) {
    const match = message.match(/\[(error|warning|info|hint)\]/i)
    if (!match) continue
    const key = match[1].toLowerCase() as keyof typeof counts
    counts[key] += 1
  }

  const parts: string[] = []
  if (counts.error > 0) parts.push(`${counts.error} error(s)`)
  if (counts.warning > 0) parts.push(`${counts.warning} warning(s)`)
  if (counts.info > 0) parts.push(`${counts.info} info(s)`)
  if (counts.hint > 0) parts.push(`${counts.hint} hint(s)`)

  return {
    summary: parts.length > 0 ? parts.join(", ") : "no issues",
    errored: counts.error > 0,
  }
}

/** 合并多个文件的诊断结果 */
function mergeDiagnostics(
  results: Array<FileDiagnosticsResult | undefined>,
  options: ResolvedWritethroughOptions,
): FileDiagnosticsResult | undefined {
  const messages: string[] = []
  const servers = new Set<string>()
  let hasResults = false
  let hasFormatter = false
  let formatted = false

  for (const result of results) {
    if (!result) continue
    hasResults = true
    if (result.server) {
      for (const server of result.server.split(",")) {
        const trimmed = server.trim()
        if (trimmed) {
          servers.add(trimmed)
        }
      }
    }
    if (result.messages.length > 0) {
      messages.push(...result.messages)
    }
    if (result.formatter !== undefined) {
      hasFormatter = true
      if (result.formatter === FileFormatResult.FORMATTED) {
        formatted = true
      }
    }
  }

  if (!hasResults && !hasFormatter) {
    return undefined
  }

  let summary = options.enableDiagnostics ? "no issues" : "OK"
  let errored = false
  let limitedMessages = messages
  if (messages.length > 0) {
    const summaryInfo = summarizeDiagnosticMessages(messages)
    summary = summaryInfo.summary
    errored = summaryInfo.errored
    limitedMessages = limitDiagnosticMessages(messages)
  }
  const formatter = hasFormatter ? (formatted ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED) : undefined

  return {
    server: servers.size > 0 ? Array.from(servers).join(", ") : undefined,
    messages: limitedMessages,
    summary,
    errored,
    formatter,
  }
}

/** 调度延迟诊断信息获取（后台执行） */
async function scheduleDeferredDiagnosticsFetch(args: {
  dst: string
  cwd: string
  servers: Array<[string, ServerConfig]>
  minVersions: ServerVersionMap | undefined
  expectedDocumentVersions: ServerVersionMap | undefined
  signal: AbortSignal
  callback: (diagnostics: FileDiagnosticsResult) => void
}): Promise<void> {
  try {
    const deferredTimeout = AbortSignal.timeout(25_000)
    const combined = AbortSignal.any([args.signal, deferredTimeout])
    const diagnostics = await getDiagnosticsForFile(args.dst, args.cwd, args.servers, {
      signal: combined,
      minVersions: args.minVersions,
      expectedDocumentVersions: args.expectedDocumentVersions,
    })
    if (args.signal.aborted || diagnostics === undefined) return
    args.callback(diagnostics)
  } catch {
    // Cancelled or LSP gave up; silently discard.
  }
}

/** 执行单文件 LSP 写入透传（格式化 + 诊断） */
async function runLspWritethrough(
  dst: string,
  content: string,
  cwd: string,
  options: ResolvedWritethroughOptions,
  signal?: AbortSignal,
  file?: BunFile,
  deferred?: {
    onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void
    signal: AbortSignal
  },
): Promise<FileDiagnosticsResult | undefined> {
  const { enableFormat, enableDiagnostics } = options
  const config = getConfig(cwd)
  const servers = getServersForFile(config, dst)
  if (servers.length === 0) {
    return writethroughNoop(dst, content, signal, file)
  }
  const { lspServers, customLinterServers } = splitServers(servers)

  let finalContent = content
  const writeContent = async (value: string) => (file ? file.write(value) : Bun.write(dst, value))
  const getWritePromise = once(() => writeContent(finalContent))
  const useCustomFormatter = enableFormat && customLinterServers.length > 0

  // Capture diagnostic versions BEFORE syncing to detect stale diagnostics
  const minVersions = enableDiagnostics ? await captureDiagnosticVersions(cwd, servers) : undefined
  let expectedDocumentVersions: ServerVersionMap | undefined

  let formatter: FileFormatResult | undefined
  let diagnostics: FileDiagnosticsResult | undefined
  let timedOut = false
  try {
    const timeoutSignal = AbortSignal.timeout(5_000)
    timeoutSignal.addEventListener(
      "abort",
      () => {
        timedOut = true
      },
      { once: true },
    )
    const operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    await untilAborted(operationSignal, async () => {
      if (useCustomFormatter) {
        // Custom linters (e.g. Biome CLI) require on-disk input.
        await writeContent(content)
        finalContent = await formatContent(dst, content, cwd, customLinterServers, operationSignal)
        formatter = finalContent !== content ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED
        await writeContent(finalContent)
        await syncFileContent(dst, finalContent, cwd, lspServers, operationSignal)
      } else {
        // 1. Sync original content to LSP servers
        await syncFileContent(dst, content, cwd, lspServers, operationSignal)

        // 2. Format in-memory via LSP
        if (enableFormat) {
          finalContent = await formatContent(dst, content, cwd, lspServers, operationSignal)
          formatter = finalContent !== content ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED
        }

        // 3. If formatted, sync formatted content to LSP servers
        if (finalContent !== content) {
          await syncFileContent(dst, finalContent, cwd, lspServers, operationSignal)
        }

        // 4. Write to disk
        await getWritePromise()
      }

      if (enableDiagnostics) {
        expectedDocumentVersions = await captureOpenFileVersions(dst, cwd, lspServers)
      }

      // 5. Notify saved to LSP servers
      await notifyFileSaved(dst, cwd, lspServers, operationSignal)

      // 6. Get diagnostics from all servers (wait for fresh results)
      if (enableDiagnostics) {
        diagnostics = await getDiagnosticsForFile(dst, cwd, servers, {
          signal: operationSignal,
          minVersions,
          expectedDocumentVersions,
          allowUnversionedLspDiagnostics: false,
        })
      }
    })
  } catch {
    if (timedOut) {
      formatter = undefined
      diagnostics = undefined
      // Schedule background diagnostic fetch if caller wants deferred results
      if (deferred && !deferred.signal.aborted && enableDiagnostics) {
        void scheduleDeferredDiagnosticsFetch({
          dst,
          cwd,
          servers,
          minVersions,
          expectedDocumentVersions,
          signal: deferred.signal,
          callback: deferred.onDeferredDiagnostics,
        })
      }
    }
    await getWritePromise()
  }

  if (formatter !== undefined) {
    diagnostics ??= {
      server: servers.map(([name]) => name).join(", "),
      messages: [],
      summary: "OK",
      errored: false,
    }
    diagnostics.formatter = formatter
  }

  return diagnostics
}

/** 刷新写入透传批处理中的所有条目 */
async function flushWritethroughBatch(
  batch: PendingWritethrough[],
  cwd: string,
  options: ResolvedWritethroughOptions,
  signal?: AbortSignal,
  getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<FileDiagnosticsResult | undefined> {
  if (batch.length === 0) {
    return undefined
  }
  const results: Array<FileDiagnosticsResult | undefined> = []
  for (const entry of batch) {
    const bundle = getDeferred?.(entry.dst)
    const deferredInner =
      bundle &&
      ({
        onDeferredDiagnostics: bundle.onDeferredDiagnostics,
        signal: bundle.signal,
      } as const)
    const diag = await runLspWritethrough(entry.dst, entry.content, cwd, options, signal, entry.file, deferredInner)
    bundle?.finalize(diag)
    results.push(diag)
  }
  return mergeDiagnostics(results, options)
}

/** Create a writethrough callback for LSP aware write operations */
/** 创建感知 LSP 的写入透传回调 */
export function createLspWritethrough(cwd: string, options?: WritethroughOptions): WritethroughCallback {
  const resolvedOptions: ResolvedWritethroughOptions = {
    enableFormat: options?.enableFormat ?? false,
    enableDiagnostics: options?.enableDiagnostics ?? false,
  }
  if (!resolvedOptions.enableFormat && !resolvedOptions.enableDiagnostics) {
    return writethroughNoop
  }
  return async (
    dst: string,
    content: string,
    signal?: AbortSignal,
    file?: BunFile,
    batch?: LspWritethroughBatchRequest,
    getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
  ) => {
    if (!batch) {
      const bundle = getDeferred?.(dst)
      const deferredInner =
        bundle &&
        ({
          onDeferredDiagnostics: bundle.onDeferredDiagnostics,
          signal: bundle.signal,
        } as const)
      const diagnostics = await runLspWritethrough(dst, content, cwd, resolvedOptions, signal, file, deferredInner)
      bundle?.finalize(diagnostics)
      return diagnostics
    }

    const state = getOrCreateWritethroughBatch(batch.id, resolvedOptions)
    state.entries.set(dst, { dst, content, file })

    if (!batch.flush) {
      await writethroughNoop(dst, content, signal, file)
      return undefined
    }

    writethroughBatches.delete(batch.id)
    return flushWritethroughBatch(Array.from(state.entries.values()), cwd, state.options, signal, getDeferred)
  }
}

/**
 * LSP tool for language server protocol operations.
 * LSP 工具类，提供语言服务器协议操作。
 */
export class LspTool implements AgentTool<typeof lspSchema, LspToolDetails, Theme> {
  readonly name = "lsp"
  readonly label = "LSP"
  readonly loadMode = "discoverable"
  readonly summary = "Query LSP (language server) for diagnostics, hover info, and references"
  readonly description: string
  readonly parameters = lspSchema
  readonly renderCall = renderCall
  readonly renderResult = renderResult
  readonly mergeCallAndResult = true
  readonly inline = true
  readonly strict = true

  constructor(private readonly session: ToolSession) {
    this.description = prompt.render(lspDescription)
  }

  static createIf(session: ToolSession): LspTool | null {
    return session.enableLsp === false ? null : new LspTool(session)
  }

  /**
   * LSP 工具入口：根据 params.action 分派到不同的 LSP 操作（诊断、跳转、引用、重命名、悬停等）。
   * 返回符合 AgentToolResult 协议的执行结果。
   */
  async execute(
    _toolCallId: string,
    params: LspParams,
    signal?: AbortSignal,
    _onUpdate?: AgentToolUpdateCallback<LspToolDetails>,
    _context?: AgentToolContext,
  ): Promise<AgentToolResult<LspToolDetails>> {
    const { action, file, line, symbol, query, new_name, apply, timeout } = params
    // 按工具白名单对超时参数进行收敛（防止过大/过小）
    const timeoutSec = clampTimeout("lsp", timeout)
    // 基于超时构造一个 AbortSignal
    const timeoutSignal = AbortSignal.timeout(timeoutSec * 1000)
    // 与外部传入的 signal 合并：任一触发都视为取消
    signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    // 若已被取消则立即抛出 ToolAbortError
    throwIfAborted(signal)

    // 读取当前 cwd 下的 LSP 配置（带缓存）
    const config = getConfig(this.session.cwd)

    // Status action doesn't need a file
    // status 动作无需文件参数：返回当前已配置的服务器列表与 lspmux 状态
    if (action === "status") {
      // 当前 LSP 配置中声明的所有服务器名称
      const servers = Object.keys(config.servers)
      // 探测 lspmux 多路复用器是否可用与运行中
      const lspmuxState = await detectLspmux()
      // 根据探测结果拼装一行状态描述
      const lspmuxStatus = lspmuxState.available
        ? lspmuxState.running
          ? "lspmux: active (multiplexing enabled)"
          : "lspmux: installed but server not running"
        : ""

      // 拼装“活跃服务器”状态文本
      const serverStatus =
        servers.length > 0
          ? `Active language servers: ${servers.join(", ")}`
          : "No language servers configured for this project"

      // 最终输出：有 lspmux 信息时附加在第二行
      const output = lspmuxStatus ? `${serverStatus}\n${lspmuxStatus}` : serverStatus
      return {
        content: [{ type: "text", text: output }],
        details: { action, success: true, request: params },
      }
    }

    // Diagnostics can be batch or single-file - queries all applicable servers
    // diagnostics 动作：支持工作区级（file === "*"）、单文件或 glob 批量诊断
    if (action === "diagnostics") {
      if (file === "*") {
        // `*` => run workspace diagnostics across all configured servers
        // 工作区诊断：根据项目类型调用 cargo/tsc/go build 等命令
        const result = await runWorkspaceDiagnostics(this.session.cwd, signal)
        return {
          content: [
            {
              type: "text",
              text: `Workspace diagnostics (${result.projectType.description}):\n${result.output}`,
            },
          ],
          details: { action, success: true, request: params },
        }
      }

      // 非工作区诊断必须提供 file 参数
      if (!file) {
        return {
          content: [
            {
              type: "text",
              text: "Error: file parameter required. Use `*` for workspace-wide diagnostics or a path/glob for specific files.",
            },
          ],
          details: { action, success: false, request: params },
        }
      }

      let targets: string[]
      let truncatedGlobTargets = false
      // 解析 glob/路径为具体文件列表，并限制最大文件数
      const resolvedTargets = await resolveDiagnosticTargets(file, this.session.cwd, MAX_GLOB_DIAGNOSTIC_TARGETS)
      targets = resolvedTargets.matches
      truncatedGlobTargets = resolvedTargets.truncated

      // 无文件命中则直接返回
      if (targets.length === 0) {
        return {
          content: [{ type: "text", text: `No files matched pattern: ${file}` }],
          details: { action, success: true, request: params },
        }
      }

      // 多文件 / 被截断时进入“详细批处理模式”，使用较短的诊断等待超时
      const detailed = targets.length > 1 || truncatedGlobTargets
      const diagnosticsWaitTimeoutMs = detailed
        ? Math.min(BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1000)
        : Math.min(SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1000)

      const results: string[] = []
      const allServerNames = new Set<string>()
      // 命中数被截断时给出警告提示，让用户收窄 glob
      if (truncatedGlobTargets) {
        results.push(
          `${theme.status.warning} Pattern matched more than ${MAX_GLOB_DIAGNOSTIC_TARGETS} files; showing first ${MAX_GLOB_DIAGNOSTIC_TARGETS}. Narrow the glob or use workspace diagnostics.`,
        )
      }

      // 遍历每个目标文件，分别向其适用的 LSP / 自定义 linter 请求诊断
      for (const target of targets) {
        throwIfAborted(signal)
        // 解析为相对 cwd 的绝对路径
        const resolved = resolveToCwd(target, this.session.cwd)
        // 找到该文件适用的所有服务器
        const servers = getServersForFile(config, resolved)
        if (servers.length === 0) {
          results.push(`${theme.status.error} ${target}: No language server found`)
          continue
        }

        const uri = fileToUri(resolved)
        const relPath = formatPathRelativeToCwd(resolved, this.session.cwd)
        const allDiagnostics: Diagnostic[] = []

        // Query all applicable servers for this file
        // 逐个服务器查询诊断；单个失败不影响其他服务器
        for (const [serverName, serverConfig] of servers) {
          allServerNames.add(serverName)
          try {
            throwIfAborted(signal)
            // 自定义 linter（如 Biome CLI）直接调用 lint
            if (serverConfig.createClient) {
              const linterClient = getLinterClient(serverName, serverConfig, this.session.cwd)
              const diagnostics = await linterClient.lint(resolved)
              allDiagnostics.push(...diagnostics)
              continue
            }
            // 标准 LSP：获取或创建客户端
            const client = await getOrCreateClient(serverConfig, this.session.cwd)
            // 项目感知型服务器需等待项目加载完成
            if (isProjectAwareLspServer(serverConfig)) {
              await waitForProjectLoaded(client, signal)
              throwIfAborted(signal)
            }
            // 记录基线版本号，用以判断后续返回的诊断是否“新鲜”
            const minVersion = client.diagnosticsVersion
            // 主动刷新文件，触发服务器重新分析
            await refreshFile(client, resolved, signal)
            // 期望的文档版本：用于过滤掉版本不匹配的过期诊断
            const expectedDocumentVersion = client.openFiles.get(uri)?.version
            // 轮询等待该 uri 的新诊断
            const diagnostics = await waitForDiagnostics(client, uri, {
              timeoutMs: diagnosticsWaitTimeoutMs,
              signal,
              minVersion,
              expectedDocumentVersion,
            })
            allDiagnostics.push(...diagnostics)
          } catch (err) {
            if (err instanceof ToolAbortError || signal?.aborted) {
              throw err
            }
            // Server failed, continue with others
            // 单服务器失败时忽略，继续查询其他服务器
          }
        }

        // Deduplicate diagnostics
        // 多服务器可能返回重复诊断；按 range+message 去重
        const seen = new Set<string>()
        const uniqueDiagnostics: Diagnostic[] = []
        for (const d of allDiagnostics) {
          const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.message}`
          if (!seen.has(key)) {
            seen.add(key)
            uniqueDiagnostics.push(d)
          }
        }

        // 按位置/严重级排序
        sortDiagnostics(uniqueDiagnostics)

        // 单文件、非批处理模式：直接返回该文件诊断结果
        if (!detailed && targets.length === 1) {
          if (uniqueDiagnostics.length === 0) {
            return {
              content: [{ type: "text", text: "OK" }],
              details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
            }
          }

          // 汇总 + 详细信息分行展示
          const summary = formatDiagnosticsSummary(uniqueDiagnostics)
          const formatted = uniqueDiagnostics.map((d) => formatDiagnostic(d, relPath))
          const output = `${summary}:\n${formatGroupedDiagnosticMessages(formatted)}`
          return {
            content: [{ type: "text", text: output }],
            details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
          }
        }

        // 批处理模式：仅追加每个文件的简短摘要 + 详细
        if (uniqueDiagnostics.length === 0) {
          results.push(`${theme.status.success} ${relPath}: no issues`)
        } else {
          const summary = formatDiagnosticsSummary(uniqueDiagnostics)
          results.push(`${theme.status.error} ${relPath}: ${summary}`)
          const formatted = uniqueDiagnostics.map((d) => formatDiagnostic(d, relPath))
          results.push(formatGroupedDiagnosticMessages(formatted))
        }
      }

      // 返回所有目标文件合并后的诊断结果
      return {
        content: [{ type: "text", text: results.join("\n") }],
        details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
      }
    }

    // rename_file 动作：通过 LSP willRenameFiles 协同重命名文件/目录，并应用工作区编辑
    if (action === "rename_file") {
      // 必须同时提供源路径与目标路径
      if (!file || !new_name) {
        return {
          content: [
            {
              type: "text",
              text: "Error: rename_file requires both `file` (source path) and `new_name` (destination path)",
            },
          ],
          details: { action, success: false, request: params },
        }
      }

      // 解析为绝对路径
      const source = resolveToCwd(file, this.session.cwd)
      const dest = resolveToCwd(new_name, this.session.cwd)

      // 源与目标完全一致时直接拒绝
      if (source === dest) {
        return {
          content: [{ type: "text", text: "Error: source and destination paths are identical" }],
          details: { action, success: false, request: params },
        }
      }

      // 校验源路径存在；不存在则报错
      let sourceStat: fs.Stats
      try {
        sourceStat = await fs.promises.stat(source)
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `Error: source path does not exist: ${formatPathRelativeToCwd(source, this.session.cwd)}`,
            },
          ],
          details: { action, success: false, request: params },
        }
      }

      // 校验目标路径不存在，避免覆盖已有文件
      let destExists = false
      try {
        await fs.promises.stat(dest)
        destExists = true
      } catch {
        // expected: destination must not exist
        // 预期分支：目标路径不存在则继续
      }
      if (destExists) {
        return {
          content: [
            {
              type: "text",
              text: `Error: destination already exists: ${formatPathRelativeToCwd(dest, this.session.cwd)}`,
            },
          ],
          details: { action, success: false, request: params },
        }
      }

      // 枚举所有 (oldUri, newUri) 重命名对；目录会递归展开
      const enumerated = await enumerateRenamePairs(source, dest)
      if (enumerated.exceeded) {
        return {
          content: [
            {
              type: "text",
              text: `Error: directory contains more than ${MAX_RENAME_PAIRS} files; rename in smaller batches to keep LSP edits accurate`,
            },
          ],
          details: { action, success: false, request: params },
        }
      }
      const { pairs } = enumerated
      if (pairs.length === 0) {
        return {
          content: [{ type: "text", text: "Error: no files to rename" }],
          details: { action, success: false, request: params },
        }
      }

      // LSP 重命名请求体
      const lspParams = { files: pairs }
      // 取出所有 LSP 服务器（排除自定义 linter）
      const servers = getLspServers(config)
      // 成功响应的服务器集合
      const respondingServers = new Set<string>()
      // 各服务器返回的 willRenameFiles 编辑
      const perServerEdits: Array<{ serverName: string; edit: WorkspaceEdit }> = []
      // 各服务器异常/不支持时的备注
      const serverNotes: string[] = []

      // 逐个服务器询问 willRenameFiles，收集其推荐的工作区编辑
      for (const [serverName, serverConfig] of servers) {
        throwIfAborted(signal)
        try {
          const client = await getOrCreateClient(serverConfig, this.session.cwd)
          // 项目感知型服务器需要等待索引完成
          if (isProjectAwareLspServer(serverConfig)) {
            await waitForProjectLoaded(client, signal)
          }
          // 询问“如果发生重命名，应当如何调整引用”
          const result = (await sendRequest(
            client,
            "workspace/willRenameFiles",
            lspParams,
            signal,
          )) as WorkspaceEdit | null
          respondingServers.add(serverName)
          if (result && (result.changes || result.documentChanges)) {
            perServerEdits.push({ serverName, edit: result })
          }
        } catch (err) {
          if (err instanceof ToolAbortError || signal?.aborted) {
            throw err
          }
          // 仅记录非 method-not-found 的错误（服务器不支持该方法属正常）
          if (!isMethodNotFoundError(err)) {
            const msg = err instanceof Error ? err.message : String(err)
            serverNotes.push(`  ${serverName}: ${msg}`)
          }
        }
      }

      // 准备展示用的相对路径标签
      const sourceLabel = formatPathRelativeToCwd(source, this.session.cwd)
      const destLabel = formatPathRelativeToCwd(dest, this.session.cwd)
      // 目录显示文件数；文件则直接显示路径
      const fileCountLabel = sourceStat.isDirectory()
        ? `${pairs.length} file${pairs.length !== 1 ? "s" : ""} under ${sourceLabel}`
        : sourceLabel

      // apply 默认为 true；显式传 false 表示仅预览
      const shouldApply = apply !== false
      if (!shouldApply) {
        const lines: string[] = []
        lines.push(`Rename preview: ${fileCountLabel} → ${destLabel}`)
        if (perServerEdits.length === 0) {
          lines.push("  No LSP edits would be applied")
        } else {
          for (const { serverName, edit } of perServerEdits) {
            const edits = formatWorkspaceEdit(edit, this.session.cwd)
            if (edits.length === 0) continue
            lines.push(`  ${serverName}:`)
            for (const e of edits) {
              lines.push(`    ${e}`)
            }
          }
        }
        if (serverNotes.length > 0) {
          lines.push("  Server notes:")
          lines.push(...serverNotes)
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            action,
            serverName: Array.from(respondingServers).join(", "),
            success: true,
            request: params,
          },
        }
      }

      // 实际应用阶段：先对各服务器产出的工作区编辑落盘
      const summary: string[] = []
      for (const { serverName, edit } of perServerEdits) {
        const applied = await applyWorkspaceEdit(edit, this.session.cwd)
        if (applied.length > 0) {
          summary.push(`  ${serverName}:`)
          summary.push(...applied.map((line) => `    ${line}`))
        }
      }

      // 确保目标目录存在，然后执行真正的文件系统重命名
      await fs.promises.mkdir(path.dirname(dest), { recursive: true })
      await fs.promises.rename(source, dest)
      summary.push(`  Renamed ${sourceLabel} → ${destLabel}`)

      // 通知各 LSP 服务器：关闭旧 URI、发送 didRenameFiles 事件
      for (const [serverName, serverConfig] of servers) {
        try {
          const client = await getOrCreateClient(serverConfig, this.session.cwd)
          for (const { oldUri } of pairs) {
            // 已打开的旧文件需要先 didClose，否则服务器会认为它仍然存在
            if (client.openFiles.has(oldUri)) {
              await sendNotification(client, "textDocument/didClose", {
                textDocument: { uri: oldUri },
              })
              client.openFiles.delete(oldUri)
            }
          }
          // 通知服务器重命名已完成，触发其内部状态更新
          await sendNotification(client, "workspace/didRenameFiles", lspParams)
        } catch (err) {
          if (err instanceof ToolAbortError || signal?.aborted) {
            throw err
          }
          const msg = err instanceof Error ? err.message : String(err)
          serverNotes.push(`  ${serverName}: ${msg}`)
        }
      }

      if (serverNotes.length > 0) {
        summary.push("  Server notes:")
        summary.push(...serverNotes)
      }

      const header = `Renamed ${fileCountLabel} → ${destLabel}`
      return {
        content: [{ type: "text", text: `${header}\n${summary.join("\n")}` }],
        details: {
          action,
          serverName: Array.from(respondingServers).join(", "),
          success: true,
          request: params,
        },
      }
    }

    // capabilities 动作：返回服务器（或某文件适用服务器）的能力声明
    if (action === "capabilities") {
      let serverList: Array<[string, ServerConfig]>
      if (file && file !== "*") {
        // 给出 file 时取该文件适用的服务器
        const resolved = resolveToCwd(file, this.session.cwd)
        serverList = getLspServersForFile(config, resolved)
        if (serverList.length === 0) {
          return {
            content: [{ type: "text", text: "No language server found for this file" }],
            details: { action, success: false, request: params },
          }
        }
      } else {
        // 未给 file 或 * 时返回全部 LSP 服务器
        serverList = getLspServers(config)
      }

      if (serverList.length === 0) {
        return {
          content: [{ type: "text", text: "No language servers configured" }],
          details: { action, success: false, request: params },
        }
      }

      // 收集每个服务器的能力描述，逐段拼接输出
      const sections: string[] = []
      const respondingServers = new Set<string>()
      for (const [serverName, serverConfig] of serverList) {
        throwIfAborted(signal)
        try {
          const client = await getOrCreateClient(serverConfig, this.session.cwd)
          respondingServers.add(serverName)
          const caps = client.serverCapabilities ?? {}
          sections.push(`${serverName}:`)
          // 缩进两格输出能力 JSON
          sections.push(`  capabilities: ${JSON.stringify(caps, null, 2).split("\n").join("\n  ")}`)
        } catch (err) {
          if (err instanceof ToolAbortError || signal?.aborted) {
            throw err
          }
          const msg = err instanceof Error ? err.message : String(err)
          sections.push(`${serverName}: failed to start (${msg})`)
        }
      }

      return {
        content: [{ type: "text", text: sections.join("\n") }],
        details: {
          action,
          serverName: Array.from(respondingServers).join(", "),
          success: true,
          request: params,
        },
      }
    }

    // request 动作：向 LSP 服务器发送任意原始请求（用于自定义/厂商扩展方法）
    if (action === "request") {
      // 必须通过 query 指定 LSP 方法名
      const method = query?.trim()
      if (!method) {
        return {
          content: [
            {
              type: "text",
              text: "Error: action=request requires `query` to specify the LSP method name (e.g., 'rust-analyzer/expandMacro')",
            },
          ],
          details: { action, success: false, request: params },
        }
      }

      // 选定目标服务器与可选的目标文件
      let chosenServer: [string, ServerConfig] | null = null
      let resolvedTarget: string | null = null
      if (file && file !== "*") {
        // 指定文件时使用该文件对应的服务器
        resolvedTarget = resolveToCwd(file, this.session.cwd)
        chosenServer = getLspServerForFile(config, resolvedTarget)
        if (!chosenServer) {
          return {
            content: [{ type: "text", text: "No language server found for this file" }],
            details: { action, success: false, request: params },
          }
        }
      } else {
        // 未指定文件时默认取第一个 LSP 服务器
        const all = getLspServers(config)
        if (all.length === 0) {
          return {
            content: [{ type: "text", text: "No language servers configured" }],
            details: { action, success: false, request: params },
          }
        }
        chosenServer = all[0]
      }

      const [chosenName, chosenConfig] = chosenServer
      // 构造请求参数
      let requestParams: unknown
      if (params.payload !== undefined) {
        // 调用方显式提供 JSON 负载，解析失败时返回错误
        try {
          requestParams = JSON.parse(params.payload)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return {
            content: [{ type: "text", text: `Error: invalid JSON in payload: ${msg}` }],
            details: { action, serverName: chosenName, success: false, request: params },
          }
        }
      } else if (resolvedTarget) {
        // 未提供负载但有文件：自动组装 textDocument(+position) 参数
        const uri = fileToUri(resolvedTarget)
        if (line !== undefined) {
          // 提供了行号则解析符号所在列，组成 position
          const character = await resolveSymbolColumn(resolvedTarget, line, symbol)
          requestParams = { textDocument: { uri }, position: { line: line - 1, character } }
        } else {
          requestParams = { textDocument: { uri } }
        }
      } else {
        // 无文件无负载：空对象参数
        requestParams = {}
      }

      try {
        // 取得 LSP 客户端
        const client = await getOrCreateClient(chosenConfig, this.session.cwd)
        // 如有目标文件需要先确保该文件已 didOpen
        if (resolvedTarget) {
          await ensureFileOpen(client, resolvedTarget, signal)
        }
        // 发送原始 LSP 请求
        const result = await sendRequest(client, method, requestParams, signal)
        // 格式化输出：null/undefined 显示为 "null"；字符串原样；其它 JSON 缩进序列化
        const formatted =
          result === null || result === undefined
            ? "null"
            : typeof result === "string"
              ? result
              : JSON.stringify(result, null, 2)
        return {
          content: [{ type: "text", text: `${chosenName} ← ${method}:\n${formatted}` }],
          details: { action, serverName: chosenName, success: true, request: params },
        }
      } catch (err) {
        // 取消时直接抛出 ToolAbortError 让上层捕获
        if (err instanceof ToolAbortError || signal?.aborted) {
          throw new ToolAbortError()
        }
        // 其它错误转为可读文本返回
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text", text: `LSP error from ${chosenName} on ${method}: ${msg}` }],
          details: { action, serverName: chosenName, success: false, request: params },
        }
      }
    }

    // `*` means workspace scope for symbols/reload; other actions need a concrete file.
    // `*` 表示工作区范围（适用于 symbols/reload）；其他动作需要具体文件
    const isWorkspace = file === "*"
    // 除 reload 外的动作必须提供 file
    const requiresFile = !file && action !== "reload"

    if (requiresFile) {
      return {
        content: [
          {
            type: "text",
            text: "Error: file parameter required. Use `*` for workspace scope where supported.",
          },
        ],
        details: { action, success: false },
      }
    }

    // 解析文件参数为绝对路径（工作区作用域时为 null）
    const resolvedFile = file && !isWorkspace ? resolveToCwd(file, this.session.cwd) : null
    // 工作区符号搜索：file 为 * 或未提供时启用
    if (action === "symbols" && (isWorkspace || !resolvedFile)) {
      // workspace/symbol 必须提供 query
      const normalizedQuery = query?.trim()
      if (!normalizedQuery) {
        return {
          content: [{ type: "text", text: "Error: query parameter required for workspace symbol search" }],
          details: { action, success: false, request: params },
        }
      }
      const servers = getLspServers(config)
      if (servers.length === 0) {
        return {
          content: [{ type: "text", text: "No language server found for this action" }],
          details: { action, success: false, request: params },
        }
      }
      // 跨服务器聚合工作区符号
      const aggregatedSymbols: SymbolInformation[] = []
      const respondingServers = new Set<string>()
      for (const [workspaceServerName, workspaceServerConfig] of servers) {
        throwIfAborted(signal)
        try {
          const workspaceClient = await getOrCreateClient(workspaceServerConfig, this.session.cwd)
          // 向单个服务器发起 workspace/symbol 查询
          const workspaceResult = (await sendRequest(
            workspaceClient,
            "workspace/symbol",
            { query: normalizedQuery },
            signal,
          )) as SymbolInformation[] | null
          if (!workspaceResult || workspaceResult.length === 0) {
            continue
          }
          respondingServers.add(workspaceServerName)
          // 按查询词进行二次过滤，过滤掉名称不匹配的符号
          aggregatedSymbols.push(...filterWorkspaceSymbols(workspaceResult, normalizedQuery))
        } catch (err) {
          if (err instanceof ToolAbortError || signal?.aborted) {
            throw err
          }
          // 单服务器失败不影响其他服务器
        }
      }
      // 跨服务器去重（按符号唯一标识）
      const dedupedSymbols = dedupeWorkspaceSymbols(aggregatedSymbols)
      if (dedupedSymbols.length === 0) {
        return {
          content: [{ type: "text", text: `No symbols matching "${normalizedQuery}"` }],
          details: {
            action,
            serverName: Array.from(respondingServers).join(", "),
            success: true,
            request: params,
          },
        }
      }
      // 截断到 WORKSPACE_SYMBOL_LIMIT 防止输出过长
      const limitedSymbols = dedupedSymbols.slice(0, WORKSPACE_SYMBOL_LIMIT)
      const lines = limitedSymbols.map((s) => formatSymbolInformation(s, this.session.cwd))
      // 被截断时附加省略提示
      const truncationLine =
        dedupedSymbols.length > WORKSPACE_SYMBOL_LIMIT
          ? `\n... ${dedupedSymbols.length - WORKSPACE_SYMBOL_LIMIT} additional symbol(s) omitted`
          : ""
      return {
        content: [
          {
            type: "text",
            text: `Found ${dedupedSymbols.length} symbol(s) matching "${normalizedQuery}":\n${lines.map((l) => `  ${l}`).join("\n")}${truncationLine}`,
          },
        ],
        details: {
          action,
          serverName: Array.from(respondingServers).join(", "),
          success: true,
          request: params,
        },
      }
    }

    // 工作区级 reload：未指定文件或 file 为 * 时重启所有 LSP 服务器
    if (action === "reload" && (isWorkspace || !resolvedFile)) {
      const servers = getLspServers(config)
      if (servers.length === 0) {
        return {
          content: [{ type: "text", text: "No language server found for this action" }],
          details: { action, success: false, request: params },
        }
      }
      const outputs: string[] = []
      // 逐个尝试 reload；优先调用 reload 方法，失败则 kill 进程重启
      for (const [workspaceServerName, workspaceServerConfig] of servers) {
        throwIfAborted(signal)
        try {
          const workspaceClient = await getOrCreateClient(workspaceServerConfig, this.session.cwd)
          outputs.push(await reloadServer(workspaceClient, workspaceServerName, signal))
        } catch (err) {
          if (err instanceof ToolAbortError || signal?.aborted) {
            throw err
          }
          // 单个服务器失败时记录错误信息，继续处理其他服务器
          const errorMessage = err instanceof Error ? err.message : String(err)
          outputs.push(`Failed to reload ${workspaceServerName}: ${errorMessage}`)
        }
      }
      return {
        content: [{ type: "text", text: outputs.join("\n") }],
        details: { action, serverName: servers.map(([name]) => name).join(", "), success: true, request: params },
      }
    }

    // 到这里属于文件级操作：找出该文件适用的主 LSP 服务器
    const serverInfo = resolvedFile ? getLspServerForFile(config, resolvedFile) : null
    if (!serverInfo) {
      return {
        content: [{ type: "text", text: "No language server found for this action" }],
        details: { action, success: false },
      }
    }

    const [serverName, serverConfig] = serverInfo

    try {
      // 获取/创建该服务器的客户端
      const client = await getOrCreateClient(serverConfig, this.session.cwd)
      const targetFile = resolvedFile

      // 文件必须先 didOpen 才能进行后续基于位置的查询
      if (targetFile) {
        await ensureFileOpen(client, targetFile, signal)
      }

      const uri = targetFile ? fileToUri(targetFile) : ""
      // 行号缺省为 1（LSP 内部使用 0-based）
      const resolvedLine = line ?? 1
      // 解析符号所在列（如果给了 symbol 名，则在该行中定位 symbol 的起始列）
      const resolvedCharacter = targetFile ? await resolveSymbolColumn(targetFile, resolvedLine, symbol) : 0
      // 构造 0-based 的 LSP 位置
      const position = { line: resolvedLine - 1, character: resolvedCharacter }

      let output: string

      // Wait for project loading to complete before cross-file operations
      // to ensure the server has indexed all project files.
      // 跨文件操作前等待项目加载完成，确保服务器已索引所有项目文件
      const crossFileActions = new Set(["definition", "type_definition", "implementation", "references", "rename"])
      if (crossFileActions.has(action)) {
        await waitForProjectLoaded(client, signal)
      }

      switch (action) {
        // =====================================================================
        // Standard LSP Operations
        // 标准 LSP 操作
        // =====================================================================

        // definition：跳转到定义
        case "definition": {
          const result = (await sendRequest(
            client,
            "textDocument/definition",
            {
              textDocument: { uri },
              position,
            },
            signal,
          )) as Location | Location[] | LocationLink | LocationLink[] | null

          // 把 Location/LocationLink 统一为 Location[]
          const locations = normalizeLocationResult(result)

          if (locations.length === 0) {
            output = "No definition found"
          } else {
            // 对每个定义位置读取上下文代码行并格式化输出
            const lines = await Promise.all(
              locations.map((location) => formatLocationWithContext(location, this.session.cwd)),
            )
            output = `Found ${locations.length} definition(s):\n${lines.join("\n")}`
          }
          break
        }

        // type_definition：跳转到类型定义
        case "type_definition": {
          const result = (await sendRequest(
            client,
            "textDocument/typeDefinition",
            {
              textDocument: { uri },
              position,
            },
            signal,
          )) as Location | Location[] | LocationLink | LocationLink[] | null

          const locations = normalizeLocationResult(result)

          if (locations.length === 0) {
            output = "No type definition found"
          } else {
            const lines = await Promise.all(
              locations.map((location) => formatLocationWithContext(location, this.session.cwd)),
            )
            output = `Found ${locations.length} type definition(s):\n${lines.join("\n")}`
          }
          break
        }

        // implementation：跳转到接口/抽象方法的实现
        case "implementation": {
          const result = (await sendRequest(
            client,
            "textDocument/implementation",
            {
              textDocument: { uri },
              position,
            },
            signal,
          )) as Location | Location[] | LocationLink | LocationLink[] | null

          const locations = normalizeLocationResult(result)

          if (locations.length === 0) {
            output = "No implementation found"
          } else {
            const lines = await Promise.all(
              locations.map((location) => formatLocationWithContext(location, this.session.cwd)),
            )
            output = `Found ${locations.length} implementation(s):\n${lines.join("\n")}`
          }
          break
        }
        // references：查找符号的所有引用
        case "references": {
          let result: Location[] | null = null
          // 项目感知型服务器（如 rust-analyzer）刚启动时可能尚未索引完成，使用重试
          for (let attempt = 0; attempt <= REFERENCES_RETRY_COUNT; attempt++) {
            result = (await sendRequest(
              client,
              "textDocument/references",
              {
                textDocument: { uri },
                position,
                context: { includeDeclaration: true },
              },
              signal,
            )) as Location[] | null

            const locations = result ?? []
            // 非项目感知或已重试完成则直接退出
            if (!isProjectAwareLspServer(serverConfig) || attempt === REFERENCES_RETRY_COUNT) {
              break
            }
            // 结果非空且不只包含查询点自身的声明，认为索引可用
            if (locations.length > 0 && !isOnlyQueriedDeclaration(locations, uri, position)) {
              break
            }

            // 否则等待项目加载，并间隔一段时间后重试
            await waitForProjectLoaded(client, signal)
            throwIfAborted(signal)
            await untilAborted(signal, () => Bun.sleep(REFERENCES_RETRY_DELAY_MS))
          }

          if (!result || result.length === 0) {
            output = "No references found"
          } else {
            // 前 REFERENCE_CONTEXT_LIMIT 个引用附带上下文代码，其余仅显示位置
            const contextualReferences = result.slice(0, REFERENCE_CONTEXT_LIMIT)
            const plainReferences = result.slice(REFERENCE_CONTEXT_LIMIT)
            const contextualLines = await Promise.all(
              contextualReferences.map((location) => formatLocationWithContext(location, this.session.cwd)),
            )
            const plainLines = plainReferences.map((location) => `  ${formatLocation(location, this.session.cwd)}`)
            const lines = plainLines.length
              ? [
                  ...contextualLines,
                  `  ... ${plainLines.length} additional reference(s) shown without context`,
                  ...plainLines,
                ]
              : contextualLines
            output = `Found ${result.length} reference(s):\n${lines.join("\n")}`
          }
          break
        }

        // hover：获取符号的悬停信息（类型/文档）
        case "hover": {
          const result = (await sendRequest(
            client,
            "textDocument/hover",
            {
              textDocument: { uri },
              position,
            },
            signal,
          )) as Hover | null

          if (!result?.contents) {
            output = "No hover information"
          } else {
            // 提取 MarkedString/MarkupContent 等多种形式的文本
            output = extractHoverText(result.contents)
          }
          break
        }

        // code_actions：列出/应用代码操作（quickfix、refactor 等）
        case "code_actions": {
          // 携带当前 uri 的诊断信息，便于服务器返回与诊断关联的修复
          const diagnostics = client.diagnostics.get(uri)?.diagnostics ?? []
          const context: CodeActionContext = {
            diagnostics,
            // 仅在“仅列出 + 给定 query”时按 only 过滤；apply 时不过滤以便找到匹配项
            only: !apply && query ? [query] : undefined,
            triggerKind: 1,
          }

          const result = (await sendRequest(
            client,
            "textDocument/codeAction",
            {
              textDocument: { uri },
              range: { start: position, end: position },
              context,
            },
            signal,
          )) as (CodeAction | Command)[] | null

          if (!result || result.length === 0) {
            output = "No code actions available"
            break
          }

          // apply=true 时需要根据 query 选择并应用一个具体动作
          if (apply === true && query) {
            const normalizedQuery = query.trim()
            if (normalizedQuery.length === 0) {
              output = "Error: query parameter required when apply=true for code_actions"
              break
            }
            // 支持按索引（纯数字）或按标题子串匹配
            const parsedIndex = /^\d+$/.test(normalizedQuery) ? Number.parseInt(normalizedQuery, 10) : null
            const selectedAction = result.find(
              (actionItem, index) =>
                (parsedIndex !== null && index === parsedIndex) ||
                actionItem.title.toLowerCase().includes(normalizedQuery.toLowerCase()),
            )

            if (!selectedAction) {
              // 未匹配到则列出所有可用动作辅助调用方选择
              const actionLines = result.map((actionItem, index) => `  ${formatCodeAction(actionItem, index)}`)
              output = `No code action matches "${normalizedQuery}". Available actions:\n${actionLines.join("\n")}`
              break
            }

            // 应用选中的动作：可能涉及 resolve、workspace 编辑、执行命令
            const appliedAction = await applyCodeAction(selectedAction, {
              resolveCodeAction: async (actionItem) =>
                (await sendRequest(client, "codeAction/resolve", actionItem, signal)) as CodeAction,
              applyWorkspaceEdit: async (edit) => applyWorkspaceEdit(edit, this.session.cwd),
              executeCommand: async (commandItem) => {
                await sendRequest(
                  client,
                  "workspace/executeCommand",
                  {
                    command: commandItem.command,
                    arguments: commandItem.arguments ?? [],
                  },
                  signal,
                )
              },
            })

            if (!appliedAction) {
              output = `Action "${selectedAction.title}" has no workspace edit or command to apply`
              break
            }

            // 汇总应用了哪些工作区编辑、执行了哪些命令
            const summaryLines: string[] = []
            if (appliedAction.edits.length > 0) {
              summaryLines.push("  Workspace edit:")
              summaryLines.push(...appliedAction.edits.map((item) => `    ${item}`))
            }
            if (appliedAction.executedCommands.length > 0) {
              summaryLines.push("  Executed command(s):")
              summaryLines.push(...appliedAction.executedCommands.map((commandName) => `    ${commandName}`))
            }

            output = `Applied "${appliedAction.title}":\n${summaryLines.join("\n")}`
            break
          }

          // 否则仅列出可用动作
          const actionLines = result.map((actionItem, index) => `  ${formatCodeAction(actionItem, index)}`)
          output = `${result.length} code action(s):\n${actionLines.join("\n")}`
          break
        }
        // symbols（文档级）：列出当前文件中的符号
        case "symbols": {
          if (!targetFile) {
            output = "Error: file parameter required for document symbols"
            break
          }
          // File-based document symbols
          // 文件级文档符号查询
          const result = (await sendRequest(
            client,
            "textDocument/documentSymbol",
            {
              textDocument: { uri },
            },
            signal,
          )) as (DocumentSymbol | SymbolInformation)[] | null

          if (!result || result.length === 0) {
            output = "No symbols found"
          } else {
            const relPath = formatPathRelativeToCwd(targetFile, this.session.cwd)
            // 服务器可能返回新格式 DocumentSymbol（含 selectionRange，有层级结构）
            // 或旧格式 SymbolInformation（扁平列表）
            if ("selectionRange" in result[0]) {
              // 新格式：递归展开输出树形结构
              const lines = (result as DocumentSymbol[]).flatMap((s) => formatDocumentSymbol(s))
              output = `Symbols in ${relPath}:\n${lines.join("\n")}`
            } else {
              // 旧格式：每个符号一行，附带图标和行号
              const lines = (result as SymbolInformation[]).map((s) => {
                const line = s.location.range.start.line + 1
                const icon = symbolKindToIcon(s.kind)
                return `${icon} ${s.name} @ line ${line}`
              })
              output = `Symbols in ${relPath}:\n${lines.join("\n")}`
            }
          }
          break
        }

        // rename：基于 LSP 的符号重命名（跨文件改名）
        case "rename": {
          if (!new_name) {
            return {
              content: [{ type: "text", text: "Error: new_name parameter required for rename" }],
              details: { action, serverName, success: false },
            }
          }

          // 向服务器请求重命名编辑（不立即落盘）
          const result = (await sendRequest(
            client,
            "textDocument/rename",
            {
              textDocument: { uri },
              position,
              newName: new_name,
            },
            signal,
          )) as WorkspaceEdit | null

          if (!result) {
            output = "Rename returned no edits"
          } else {
            // apply 默认为 true，传 false 表示仅预览
            const shouldApply = apply !== false
            if (shouldApply) {
              // 应用工作区编辑（多个文件原子写入）
              const applied = await applyWorkspaceEdit(result, this.session.cwd)
              output = `Applied rename:\n${applied.map((a) => `  ${a}`).join("\n")}`
            } else {
              // 仅生成可读预览供调用方审阅
              const preview = formatWorkspaceEdit(result, this.session.cwd)
              output = `Rename preview:\n${preview.map((p) => `  ${p}`).join("\n")}`
            }
          }
          break
        }

        // reload（文件级）：重启 / 重新加载该文件对应的单个服务器
        case "reload": {
          output = await reloadServer(client, serverName, signal)
          break
        }

        default:
          // 未知动作：直接回显（理论上 schema 校验后不应到达）
          output = `Unknown action: ${action}`
      }

      // 统一封装成功响应
      return {
        content: [{ type: "text", text: output }],
        details: { serverName, action, success: true, request: params },
      }
    } catch (err) {
      // 取消触发时统一抛 ToolAbortError 由上层处理（清理状态/打断流）
      if (err instanceof ToolAbortError || signal?.aborted) {
        throw new ToolAbortError()
      }
      // 其它异常包装成可读 LSP 错误信息返回，避免冒泡破坏 Agent 流程
      const errorMessage = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: "text", text: `LSP error: ${errorMessage}` }],
        details: { serverName, action, success: false, request: params },
      }
    }
  }
}


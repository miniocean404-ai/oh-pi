/**
 * AgentSession — Agent 生命周期与会话管理的核心抽象。
 *
 * 交互、print、rpc 等运行模式共享此类，封装：Agent 状态访问、带自动持久化的事件订阅、
 * 模型与思维等级、手动/自动压缩、Bash/Python 执行、会话切换与分支等。
 * 各模式在此之上叠加各自的 I/O 层。
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { scheduler } from "node:timers/promises"
import {
  type AfterToolCallContext,
  type AfterToolCallResult,
  type Agent,
  AgentBusyError,
  type AgentEvent,
  type AgentMessage,
  type AgentState,
  type AgentTool,
  resolveTelemetry,
  ThinkingLevel,
} from "@oh-my-pi/pi-agent-core"
import {
  AUTO_HANDOFF_THRESHOLD_FOCUS,
  CompactionCancelledError,
  type CompactionPreparation,
  type CompactionResult,
  calculateContextTokens,
  calculatePromptTokens,
  collectEntriesForBranchSummary,
  compact,
  estimateTokens,
  generateBranchSummary,
  generateHandoff,
  prepareCompaction,
  type SummaryOptions,
  shouldCompact,
} from "@oh-my-pi/pi-agent-core/compaction"
import { DEFAULT_PRUNE_CONFIG, pruneToolOutputs } from "@oh-my-pi/pi-agent-core/compaction/pruning"
import type {
  AssistantMessage,
  Context,
  Effort,
  ImageContent,
  Message,
  MessageAttribution,
  Model,
  ProviderSessionState,
  ServiceTier,
  SimpleStreamOptions,
  TextContent,
  ToolCall,
  ToolChoice,
  Usage,
  UsageReport,
} from "@oh-my-pi/pi-ai"
import {
  calculateRateLimitBackoffMs,
  getSupportedEfforts,
  isContextOverflow,
  isUsageLimitError,
  modelsAreEqual,
  parseRateLimitReason,
  streamSimple,
} from "@oh-my-pi/pi-ai"
import { MacOSPowerAssertion } from "@oh-my-pi/pi-natives"
import { getAgentDbPath, isEnoent, isUnexpectedSocketCloseMessage, logger, prompt, Snowflake } from "@oh-my-pi/pi-utils"
import { type AsyncJob, type AsyncJobDeliveryState, AsyncJobManager } from "../async"
import { reset as resetCapabilities } from "../capability"
import type { Rule } from "../capability/rule"
import { MODEL_ROLE_IDS, type ModelRegistry } from "../config/model-registry"
import {
  extractExplicitThinkingSelector,
  formatModelSelectorValue,
  formatModelString,
  parseModelString,
  type ResolvedModelRoleValue,
  resolveModelRoleValue,
} from "../config/model-resolver"
import { expandPromptTemplate, type PromptTemplate } from "../config/prompt-templates"
import type { Settings, SkillsSettings } from "../config/settings"
import { RawSseDebugBuffer } from "../debug/raw-sse-buffer"
import { loadCapability } from "../discovery"
import { expandApplyPatchToEntries, normalizeDiff, normalizeToLF, ParseError, previewPatch, stripBom } from "../edit"
import {
  disposeKernelSessionsByOwner,
  executePython as executePythonCommand,
  type PythonResult,
} from "../eval/py/executor"
import { type BashResult, executeBash as executeBashCommand } from "../exec/bash-executor"
import { exportSessionToHtml } from "../export/html"
import type { TtsrManager, TtsrMatchContext } from "../export/ttsr"
import type { LoadedCustomCommand } from "../extensibility/custom-commands"
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types"
import { CustomToolAdapter } from "../extensibility/custom-tools/wrapper"
import type {
  ExtensionCommandContext,
  ExtensionRunner,
  ExtensionUIContext,
  MessageEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  SessionBeforeBranchResult,
  SessionBeforeCompactResult,
  SessionBeforeSwitchResult,
  SessionBeforeTreeResult,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
  TreePreparation,
  TurnEndEvent,
  TurnStartEvent,
} from "../extensibility/extensions"
import type { CompactOptions, ContextUsage } from "../extensibility/extensions/types"
import { ExtensionToolWrapper } from "../extensibility/extensions/wrapper"
import type { HookCommandContext } from "../extensibility/hooks/types"
import type { Skill, SkillWarning } from "../extensibility/skills"
import { expandSlashCommand, type FileSlashCommand } from "../extensibility/slash-commands"
import { GoalRuntime } from "../goals/runtime"
import type { Goal, GoalModeState } from "../goals/state"
import type { HindsightSessionState } from "../hindsight/state"
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls"
import {
  buildDiscoverableMCPSearchIndex,
  collectDiscoverableMCPTools,
  type DiscoverableMCPSearchIndex,
  type DiscoverableMCPTool,
  isMCPToolName,
  selectDiscoverableMCPToolNamesByServer,
} from "../mcp/discoverable-tool-metadata"
import { resolveMemoryBackend } from "../memory-backend"
import { getCurrentThemeName, theme } from "../modes/theme/theme"
import type { PlanModeState } from "../plan-mode/state"
import autoContinuePrompt from "../prompts/system/auto-continue.md" with { type: "text" }
import eagerTodoPrompt from "../prompts/system/eager-todo.md" with { type: "text" }
import ircIncomingTemplate from "../prompts/system/irc-incoming.md" with { type: "text" }
import planModeActivePrompt from "../prompts/system/plan-mode-active.md" with { type: "text" }
import planModeReferencePrompt from "../prompts/system/plan-mode-reference.md" with { type: "text" }
import planModeToolDecisionReminderPrompt from "../prompts/system/plan-mode-tool-decision-reminder.md" with { type: "text" }
import ttsrInterruptTemplate from "../prompts/system/ttsr-interrupt.md" with { type: "text" }
import ttsrToolReminderTemplate from "../prompts/system/ttsr-tool-reminder.md" with { type: "text" }
import { type AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry"
import { deobfuscateSessionContext, type SecretObfuscator } from "../secrets/obfuscator"
import { invalidateHostMetadata } from "../ssh/connection-manager"
import { resolveThinkingLevelForModel, toReasoningEffort } from "../thinking"
import {
  buildDiscoverableToolSearchIndex,
  collectDiscoverableTools,
  type DiscoverableTool,
  type DiscoverableToolSearchIndex,
} from "../tool-discovery/tool-index"
import { assertEditableFile } from "../tools/auto-generated-guard"
import type { CheckpointState } from "../tools/checkpoint"
import { outputMeta } from "../tools/output-meta"
import { normalizeLocalScheme, resolveToCwd } from "../tools/path-utils"
import { isAutoQaEnabled } from "../tools/report-tool-issue"
import { getLatestTodoPhasesFromEntries, type TodoItem, type TodoPhase } from "../tools/todo-write"
import { ToolAbortError, ToolError } from "../tools/tool-errors"
import { clampTimeout } from "../tools/tool-timeouts"
import { parseCommandArgs } from "../utils/command-args"
import { type EditMode, resolveEditMode } from "../utils/edit-mode"
import { resolveFileDisplayMode } from "../utils/file-display-mode"
import { extractFileMentions, generateFileMentionMessages } from "../utils/file-mentions"
import { buildNamedToolChoice } from "../utils/tool-choice"
import type { AuthStorage } from "./auth-storage"
import type { ClientBridge, ClientBridgePermissionOption, ClientBridgePermissionOutcome } from "./client-bridge"
import {
  type BashExecutionMessage,
  type CompactionSummaryMessage,
  type CustomMessage,
  convertToLlm,
  type FileMentionMessage,
  type PythonExecutionMessage,
  readPendingDisplayTag,
  SILENT_ABORT_MARKER,
} from "./messages"
import { formatSessionDumpText } from "./session-dump-format"
import type {
  BranchSummaryEntry,
  CompactionEntry,
  NewSessionOptions,
  SessionContext,
  SessionManager,
} from "./session-manager"
import { getLatestCompactionEntry } from "./session-manager"
import { ToolChoiceQueue } from "./tool-choice-queue"

/** 会话级事件类型，扩展核心 AgentEvent 联合类型 */
export type AgentSessionEvent =
  | AgentEvent
  | { type: "auto_compaction_start"; reason: "threshold" | "overflow" | "idle"; action: "context-full" | "handoff" }
  | {
      type: "auto_compaction_end"
      action: "context-full" | "handoff"
      result: CompactionResult | undefined
      aborted: boolean
      willRetry: boolean
      errorMessage?: string
      /** True when compaction was skipped for a benign reason (no model, no candidates, nothing to compact). */
      skipped?: boolean
    }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "retry_fallback_applied"; from: string; to: string; role: string }
  | { type: "retry_fallback_succeeded"; model: string; role: string }
  | { type: "ttsr_triggered"; rules: Rule[] }
  | { type: "todo_reminder"; todos: TodoItem[]; attempt: number; maxAttempts: number }
  | { type: "todo_auto_clear" }
  | { type: "irc_message"; message: CustomMessage }
  | { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
  | { type: "thinking_level_changed"; thinkingLevel: ThinkingLevel | undefined }
  | { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }

/** 会话事件监听器函数类型 */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void
/** 异步作业快照项（精简字段） */
export type AsyncJobSnapshotItem = Pick<AsyncJob, "id" | "type" | "status" | "label" | "startTime">

/** 异步作业快照，包含运行中、最近完成和交付状态 */
export interface AsyncJobSnapshot {
  /** 正在运行的作业列表 */
  running: AsyncJobSnapshotItem[]
  /** 最近完成的作业列表 */
  recent: AsyncJobSnapshotItem[]
  /** 作业交付状态 */
  delivery: AsyncJobDeliveryState
}

// ============================================================================
// Types
// ============================================================================

/** AgentSession 构造配置接口 */
export interface AgentSessionConfig {
  /** Agent 核心实例 */
  agent: Agent
  /** 会话管理器（负责持久化、分支、条目管理） */
  sessionManager: SessionManager
  /** 全局设置 */
  settings: Settings
  /** 可通过 Ctrl+P 循环切换的模型列表（来自 --models 标志） */
  scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>
  /** 初始会话思维选择器 */
  thinkingLevel?: ThinkingLevel
  /** 文件提示模板列表（用于展开 $template 引用） */
  promptTemplates?: PromptTemplate[]
  /** 文件斜杠命令列表（用于展开 /command 引用） */
  slashCommands?: FileSlashCommand[]
  /** 扩展运行器（在 main.ts 中创建，工具已包装） */
  extensionRunner?: ExtensionRunner
  /** 已加载技能（由 SDK 发现） */
  skills?: Skill[]
  /** 技能加载警告（由 SDK 捕获） */
  skillWarnings?: SkillWarning[]
  /** 自定义命令（TypeScript 斜杠命令） */
  customCommands?: LoadedCustomCommand[]
  /** 技能设置 */
  skillsSettings?: SkillsSettings
  /** 模型注册表（API Key 解析与模型发现） */
  modelRegistry: ModelRegistry
  /** 工具注册表（LSP 和设置用） */
  toolRegistry?: Map<string, AgentTool>
  /** 当前会话的预 LLM 消息转换管线 */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>
  /** 提供商请求体钩子（活跃会话请求路径使用） */
  onPayload?: SimpleStreamOptions["onPayload"]
  /** 提供商响应钩子（活跃会话请求路径使用） */
  onResponse?: SimpleStreamOptions["onResponse"]
  /** 原始 SSE 事件钩子（活跃会话请求路径使用） */
  onSseEvent?: SimpleStreamOptions["onSseEvent"]
  /** 每会话原始 SSE 诊断缓冲区 */
  rawSseDebugBuffer?: RawSseDebugBuffer
  /** 当前会话消息到 LLM 格式的转换管线 */
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>
  /** 系统提示构建器，可考虑工具可用性。返回有序的面向提供商的提示块。 */
  rebuildSystemPrompt?: (toolNames: string[], tools: Map<string, AgentTool>) => Promise<{ systemPrompt: string[] }>
  /** 从当前能力发现结果重建 SSH 工具 */
  reloadSshTool?: () => Promise<AgentTool | null>
  /** 请求的工具名集合（来自 --tools 标志） */
  requestedToolNames?: ReadonlySet<string>
  /** 活跃 MCP 服务器指令获取器，供 rebuildSystemPrompt 跳过优化检测服务端指令变更 */
  getMcpServerInstructions?: () => Map<string, string> | undefined
  /** 是否为此会话启用默认隐藏的 MCP 工具发现 */
  mcpDiscoveryEnabled?: boolean
  /** 启用发现模式时当前会话要激活的 MCP 工具名 */
  initialSelectedMCPToolNames?: string[]
  /** 构造函数提供的 MCP 默认值是否应立即持久化 */
  persistInitialMCPToolSelection?: boolean
  /** 当这些 MCP 服务器连接时，其工具应种入发现模式会话 */
  defaultSelectedMCPServerNames?: string[]
  /** 从此 AgentSession 创建的全新会话应种入的 MCP 工具名 */
  defaultSelectedMCPToolNames?: string[]
  /** TTSR 管理器（时间旅行流规则） */
  ttsrManager?: TtsrManager
  /** 密钥混淆器（用于流式编辑内容的去混淆） */
  obfuscator?: SecretObfuscator
  /** 此会话创建的保留 Python 内核的逻辑所有者 ID */
  evalKernelOwnerId?: string
  /** 本会话安装的进程级 AsyncJobManager（仅顶层会话）；子 Agent 不得自行 dispose */
  ownedAsyncJobManager?: AsyncJobManager
  /** Agent 身份标识（注册表 ID），用于 IRC 路由 */
  agentId?: string
  /** 共享 Agent 注册表（用于将 IRC 观察转发到主会话 UI） */
  agentRegistry?: AgentRegistry
  /** 覆盖提供商 API 请求使用的会话 ID；缺省时使用 sessionManager.getSessionId() */
  providerSessionId?: string
}

/** AgentSession.prompt() 的选项接口 */
export interface PromptOptions {
  /** 是否展开文件提示模板（默认 true） */
  expandPromptTemplates?: boolean
  /** 图片附件 */
  images?: ImageContent[]
  /** 流式传输时消息排队方式："steer" 或 "followUp" */
  streamingBehavior?: "steer" | "followUp"
  /** 下一次 LLM 调用的工具选择覆盖 */
  toolChoice?: ToolChoice
  /** 作为 developer/system 消息而非用户消息发送。支持该角色的提供商使用 developer 角色；其他回退为 user。 */
  synthetic?: boolean
  /** 显式的计费/发起者归属。默认用户提示为 `user`，合成提示为 `agent`。 */
  attribution?: MessageAttribution
  /** 跳过发送前的压缩检查（内部维护流程使用） */
  skipCompactionCheck?: boolean
}

/** Handoff 操作的结果 */
export interface HandoffResult {
  /** 生成的 Handoff 文档内容 */
  document: string
  /** 保存到磁盘的路径（仅自动触发时） */
  savedPath?: string
}

/** Handoff 会话选项 */
export interface SessionHandoffOptions {
  /** 是否由系统自动触发（而非用户手动） */
  autoTriggered?: boolean
  /** 中止信号 */
  signal?: AbortSignal
}

/** cycleModel() 的返回结果 */
export interface ModelCycleResult {
  /** 切换后的模型 */
  model: Model
  /** 切换后的思维等级 */
  thinkingLevel: ThinkingLevel | undefined
  /** 是否在限定模型列表中循环（来自 --models 标志），否则为全量可用模型 */
  isScoped: boolean
}

/** cycleRoleModels() 的返回结果 */
export interface RoleModelCycleResult {
  /** 切换后的模型 */
  model: Model
  /** 切换后的思维等级 */
  thinkingLevel: ThinkingLevel | undefined
  /** 切换到的角色名 */
  role: string
}

/** 会话统计信息（供 /session 命令使用） */
export interface SessionStats {
  /** 会话文件路径 */
  sessionFile: string | undefined
  /** 会话唯一标识符 */
  sessionId: string
  /** 用户消息总数 */
  userMessages: number
  /** 助手消息总数 */
  assistantMessages: number
  /** 工具调用总数 */
  toolCalls: number
  /** 工具返回结果总数 */
  toolResults: number
  /** 消息总数 */
  totalMessages: number
  tokens: {
    /** 输入 token 数 */
    input: number
    /** 输出 token 数 */
    output: number
    /** 缓存读取 token 数 */
    cacheRead: number
    /** 缓存写入 token 数 */
    cacheWrite: number
    /** token 总量 */
    total: number
  }
  /** 高级请求次数 */
  premiumRequests: number
  /** 会话总费用 */
  cost: number
}

/** Internal marker for hook messages queued through the agent loop */
// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */

/** 重试回退链配置：角色名 → 选择器数组 */
type RetryFallbackChains = Record<string, string[]>

/** 重试回退恢复策略：never = 永不恢复主模型；cooldown-expiry = 冷却期后恢复 */
type RetryFallbackRevertPolicy = "never" | "cooldown-expiry"

/** 重试回退选择器（解析后的模型+思维等级标识） */
interface RetryFallbackSelector {
  /** 原始字符串 */
  raw: string
  /** 提供商名 */
  provider: string
  /** 模型 ID */
  id: string
  /** 思维等级 */
  thinkingLevel: ThinkingLevel | undefined
}

/** 活跃重试回退状态（记录当前回退上下文） */
interface ActiveRetryFallbackState {
  /** 所属角色名 */
  role: string
  /** 原始选择器字符串 */
  originalSelector: string
  /** 回退前的思维等级 */
  originalThinkingLevel: ThinkingLevel | undefined
  /** 最近一次应用的回退思维等级 */
  lastAppliedFallbackThinkingLevel: ThinkingLevel | undefined
}

/** 解析重试回退选择器字符串为结构化对象。解析失败或为空则返回 undefined */
function parseRetryFallbackSelector(selector: string): RetryFallbackSelector | undefined {
  const trimmed = selector.trim()
  if (!trimmed) return undefined
  const parsed = parseModelString(trimmed)
  if (!parsed) return undefined
  return {
    raw: trimmed,
    provider: parsed.provider,
    id: parsed.id,
    thinkingLevel: parsed.thinkingLevel,
  }
}

/** 将模型和思维等级格式化为回退选择器字符串 */
function formatRetryFallbackSelector(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
  const selector = formatModelString(model)
  return thinkingLevel ? `${selector}:${thinkingLevel}` : selector
}

/** 格式化回退选择器的基础部分（provider/id，不含思维等级后缀） */
function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
  return `${selector.provider}/${selector.id}`
}

/** Todo 自动清除定时器的组合键，以阶段名 + 任务内容拼接，用 \0 分隔 */
function todoClearKey(phaseName: string, taskContent: string): string {
  return `${phaseName}\u0000${taskContent}`
}

/**
 * Build the per-request `metadata` payload for the Anthropic provider, shaped
 * like real Claude Code's `getAPIMetadata` output (`{ session_id, account_uuid,
 * device_id }`) so the backend buckets requests under one session and attributes
 * them to the authenticated OAuth account when available. Resolved at request
 * time so token refreshes and login/logout transitions don't strand a stale
 * account UUID in memory. `account_uuid` and `device_id` are omitted for
 * non-Anthropic providers to avoid leaking the user's Claude identity to
 * third-party APIs (including Anthropic-format-compatible proxies such as
 * cloudflare-ai-gateway or gitlab-duo).
 *
 * `provider` is the target provider string (e.g. `"anthropic"`) and gates the
 * `account_uuid` and `device_id` lookups — only `"anthropic"` requests carry them.
 *
 * `sessionId` is forwarded to the auth-storage session-sticky lookup so that
 * multi-credential setups attribute to the same OAuth account used for the
 * actual API request rather than always picking the first credential.
 *
 * `authStorage` is treated as optional so test fixtures that stub `modelRegistry`
 * without a real storage layer still work; the resolver simply skips the lookup
 * and emits `{ session_id }` alone, matching the no-OAuth-credential path.
 */
function buildSessionMetadata(
  sessionId: string,
  provider: string,
  authStorage: AuthStorage | undefined,
): Record<string, unknown> {
  const userId: Record<string, string> = { session_id: sessionId }
  // Only look up account_uuid when the request is going to Anthropic. Injecting
  // a Claude OAuth account_uuid into requests bound for other providers (including
  // Anthropic-format-compatible proxies like cloudflare-ai-gateway or gitlab-duo)
  // would leak the user's Anthropic identity to unrelated third-party APIs.
  if (provider === "anthropic") {
    const accountUuid = authStorage?.getOAuthAccountId("anthropic", sessionId)
    if (typeof accountUuid === "string" && accountUuid.length > 0) {
      userId.account_uuid = accountUuid
      // Derive device_id from account_uuid so the payload matches the real CC
      // getAPIMetadata shape without hardware fingerprinting. A SHA-256 of a
      // namespaced account UUID produces a stable 64-hex value that is
      // indistinguishable from a randomly generated device ID on the wire, is
      // deterministic per account (survives reinstalls), and is auditable: it
      // is derived solely from the OAuth UUID the user already consented to
      // share with Anthropic. Omitted when no OAuth credential is available
      // (API-key callers) to avoid sending a hash of an empty string.
      userId.device_id = crypto.createHash("sha256").update(`omp-device-id-v1:${accountUuid}`).digest("hex")
    }
  }
  return { user_id: JSON.stringify(userId) }
}

/** 空操作 UI 上下文，所有交互均为 no-op，用于无 UI 模式（如 RPC/SDK 调用） */
const noOpUIContext: ExtensionUIContext = {
  select: async (_title, _options, _dialogOptions) => undefined,
  confirm: async (_title, _message, _dialogOptions) => false,
  input: async (_title, _placeholder, _dialogOptions) => undefined,
  notify: () => {},
  onTerminalInput: () => () => {},
  setStatus: () => {},
  setWorkingMessage: () => {},
  setWidget: () => {},
  setTitle: () => {},
  custom: async () => undefined as never,
  setEditorText: () => {},
  pasteToEditor: () => {},
  getEditorText: () => "",
  editor: async () => undefined,
  get theme() {
    return theme
  },
  getAllThemes: () => Promise.resolve([]),
  getTheme: () => Promise.resolve(undefined),
  setTheme: (_theme) => Promise.resolve({ success: false, error: "UI not available" }),
  setFooter: () => {},
  setHeader: () => {},
  setEditorComponent: () => {},
  getToolsExpanded: () => false,
  setToolsExpanded: () => {},
}

/** 将 Handoff 文档包装为 XML 上下文标签，附带续接引导语 */
function createHandoffContext(document: string): string {
  return `<handoff-context>\n${document}\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.`
}

/** 生成带时间戳的 Handoff 文件名 */
function createHandoffFileName(date = new Date()): string {
  const fileTimestamp = date.toISOString().replace(/[:.]/g, "-")
  return `handoff-${fileTimestamp}.md`
}

// ============================================================================
// ACP Permission Gate
// ============================================================================

/** ACP 客户端连接时执行前需要用户授权的受保护工具集 */
const PERMISSION_REQUIRED_TOOLS = new Set(["bash", "edit", "delete", "move"])

/** 每次受保护工具调用时展示给客户端的权限选项 */
const PERMISSION_OPTIONS: ClientBridgePermissionOption[] = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
  { optionId: "reject_always", name: "Always reject", kind: "reject_always" },
]

/** 按选项 ID 索引的权限选项映射 */
const PERMISSION_OPTIONS_BY_ID = new Map(PERMISSION_OPTIONS.map((option) => [option.optionId, option]))

/** 安全获取对象的字符串属性 */
function getStringProperty(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key]
  return typeof candidate === "string" ? candidate : undefined
}

/** 从值中收集字符串路径数组，若非数组则返回空数组 */
function collectStringPaths(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/** 从编辑工具参数中提取破坏性意图（delete/move），返回操作类型与路径列表 */
function getEditDestructiveIntent(args: unknown): { kind: "delete" | "move"; paths: string[] } | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined
  const a = args as Record<string, unknown>

  const edits = Array.isArray(a.edits) ? a.edits : undefined
  if (edits) {
    const path = getStringProperty(a, "path")
    if (path) {
      for (const edit of edits) {
        if (!edit || typeof edit !== "object" || Array.isArray(edit)) continue
        const op = getStringProperty(edit as Record<string, unknown>, "op")
        if (op === "delete") return { kind: "delete", paths: [path] }
      }
    }
    for (const edit of edits) {
      if (!edit || typeof edit !== "object" || Array.isArray(edit)) continue
      const entry = edit as Record<string, unknown>
      const op = getStringProperty(entry, "op")
      const rename = getStringProperty(entry, "rename")
      if (op !== "create" && rename) return { kind: "move", paths: path ? [path, rename] : [rename] }
    }
  }

  const input = getStringProperty(a, "input")
  if (input) {
    try {
      const entries = expandApplyPatchToEntries({ input })
      const deleteEntry = entries.find((entry) => entry.op === "delete")
      if (deleteEntry) return { kind: "delete", paths: [deleteEntry.path] }
      const moveEntry = entries.find((entry) => entry.rename)
      if (moveEntry?.rename) return { kind: "move", paths: [moveEntry.path, moveEntry.rename] }
    } catch {
      // If the edit input is not an apply_patch envelope, it is not a delete/move operation.
    }
  }

  return undefined
}

/** 从工具名和参数推断权限意图（标题、路径、缓存键），用于向 ACP 客户端发起权限请求 */
function getPermissionIntent(
  toolName: string,
  args: unknown,
): { toolName: string; title: string; paths?: string[]; cacheKey: string } | undefined {
  const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
  if (toolName === "bash") {
    const cmd = getStringProperty(a, "command")?.slice(0, 80)
    return { toolName, title: cmd || toolName, cacheKey: toolName }
  }
  if (toolName === "delete") {
    const p = getStringProperty(a, "path")
    return { toolName, title: p ? `Delete ${p}` : toolName, paths: p ? [p] : undefined, cacheKey: toolName }
  }
  if (toolName === "move") {
    const from = getStringProperty(a, "oldPath") ?? getStringProperty(a, "path") ?? getStringProperty(a, "from")
    const to = getStringProperty(a, "newPath") ?? getStringProperty(a, "to") ?? getStringProperty(a, "destination")
    if (from && to) return { toolName, title: `Move ${from} to ${to}`, paths: [from, to], cacheKey: toolName }
    return {
      toolName,
      title: from ? `Move ${from}` : toolName,
      paths: from ? [from] : undefined,
      cacheKey: toolName,
    }
  }
  if (toolName === "edit") {
    const intent = getEditDestructiveIntent(args)
    if (!intent) return undefined
    if (intent.kind === "delete") {
      return {
        toolName,
        title: `Delete ${intent.paths[0] ?? "edit target"}`,
        paths: intent.paths,
        cacheKey: "edit:delete",
      }
    }
    const from = intent.paths[0]
    const to = intent.paths[1]
    return {
      toolName,
      title: from && to ? `Move ${from} to ${to}` : `Move ${from ?? to ?? "edit target"}`,
      paths: intent.paths,
      cacheKey: "edit:move",
    }
  }
  return undefined
}

/** 从工具参数中提取权限位置信息（绝对路径列表），供 ACP 编辑器宿主定位文件 */
function extractPermissionLocations(
  args: unknown,
  cwd: string,
  explicitPaths?: string[],
): { path: string; line?: number }[] {
  if (!args || typeof args !== "object") return []
  const a = args as Record<string, unknown>
  const out: { path: string; line?: number }[] = []
  const pushPath = (value: unknown) => {
    if (typeof value !== "string" || value.length === 0) return
    // ACP locations carry file paths that the editor host will open or focus;
    // they must be absolute or the client cannot resolve them. Resolve raw
    // tool args (often cwd-relative) against the session cwd before sending.
    let resolved: string
    try {
      resolved = resolveToCwd(value, cwd)
    } catch {
      return
    }
    if (out.some((location) => location.path === resolved)) return
    out.push({ path: resolved })
  }
  if (explicitPaths) {
    for (const p of explicitPaths) {
      pushPath(p)
    }
    return out
  }
  pushPath(a.path)
  pushPath(a.file)
  for (const p of collectStringPaths(a.paths)) {
    pushPath(p)
  }
  pushPath(a.oldPath)
  pushPath(a.newPath)
  pushPath(a.from)
  pushPath(a.to)
  pushPath(a.source)
  pushPath(a.destination)
  return out
}

// ============================================================================
// AgentSession Class
// ============================================================================

/** 排队显示条目。`tag` 仅由 `enqueueCustomMessageDisplay` 设置（用于流式期间的技能提示自定义消息），
 *  普通用户消息入队时 tag 为 undefined，依赖文本相等性匹配出队。 */
type QueuedDisplayEntry = { text: string; tag?: string }

export class AgentSession {
  /** Agent 核心实例（工具调用、状态管理） */
  readonly agent: Agent
  /** 会话管理器（NDJSON 持久化、分支、条目管理） */
  readonly sessionManager: SessionManager
  /** 全局设置（三层合并：全局 → 项目级 → 运行时覆盖） */
  readonly settings: Settings

  /** macOS 电源断言实例，防止系统在长时间运行时休眠 */
  #powerAssertion: MacOSPowerAssertion | undefined

  /** 配置警告列表，构造时收集，供 UI 展示 */
  readonly configWarnings: string[] = []

  /** 可通过 Ctrl+P 循环切换的限定模型列表 */
  #scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>
  /** 当前思维等级 */
  #thinkingLevel: ThinkingLevel | undefined
  /** 文件提示模板列表 */
  #promptTemplates: PromptTemplate[]
  /** 文件斜杠命令列表 */
  #slashCommands: FileSlashCommand[]

  // Event subscription state
  /** Agent 核心事件退订函数 */
  #unsubscribeAgent?: () => void
  /** 外部事件监听器列表 */
  #eventListeners: AgentSessionEventListener[] = []

  /** 待 UI 展示的转向消息队列；送达后移除。普通 steer 用 `{ text }` 按文本出队；
   *  流式期间排队的自定义消息（技能）带 `{ text, tag }`，按 tag 出队以免重复参数碰撞。 */
  #steeringMessages: QueuedDisplayEntry[] = []
  /** 待 UI 展示的追加消息队列；送达后移除。条目形状同 `#steeringMessages`。 */
  #followUpMessages: QueuedDisplayEntry[] = []
  /** 下一轮注入的上下文消息（作为 aside 附加到用户提示中） */
  #pendingNextTurnMessages: CustomMessage[] = []
  /** 已调度的隐藏下一轮消息的提示代数，防止重复调度 */
  #scheduledHiddenNextTurnGeneration: number | undefined = undefined
  /** Plan 模式状态 */
  #planModeState: PlanModeState | undefined
  /** Goal 模式状态 */
  #goalModeState: GoalModeState | undefined
  /** Goal 运行时（管理目标进度、token 预算） */
  #goalRuntime: GoalRuntime
  /** Goal 回合计数器 */
  #goalTurnCounter = 0
  /** 计划引用消息是否已发送 */
  #planReferenceSent = false
  /** 计划引用路径 */
  #planReferencePath = "local://PLAN.md"
  /** ACP 客户端桥接 */
  #clientBridge: ClientBridge | undefined
  /** 是否允许 ACP Agent 发起回合 */
  #allowAcpAgentInitiatedTurns = false
  /** 每会话的 allow_always / reject_always 权限决策缓存 */
  #acpPermissionDecisions: Map<string, "allow_always" | "reject_always"> = new Map()

  // Compaction state
  /** 手动压缩中止控制器 */
  #compactionAbortController: AbortController | undefined = undefined
  /** 自动压缩中止控制器 */
  #autoCompactionAbortController: AbortController | undefined = undefined

  // Branch summarization state
  /** 分支摘要生成中止控制器 */
  #branchSummaryAbortController: AbortController | undefined = undefined

  // Handoff state
  /** Handoff 生成中止控制器 */
  #handoffAbortController: AbortController | undefined = undefined
  /** 跳过后回合维护的助手消息时间戳 */
  #skipPostTurnMaintenanceAssistantTimestamp: number | undefined = undefined

  // Retry state
  /** 重试中止控制器 */
  #retryAbortController: AbortController | undefined = undefined
  /** 当前重试次数 */
  #retryAttempt = 0
  /** 重试等待 Promise，resolve 后立即重试 */
  #retryPromise: Promise<void> | undefined = undefined
  /** 重试 Promise 解析器 */
  #retryResolve: (() => void) | undefined = undefined
  /** 活跃重试回退状态 */
  #activeRetryFallback: ActiveRetryFallbackState | undefined = undefined
  // Todo completion reminder state
  /** Todo 提醒已发送次数 */
  #todoReminderCount = 0
  /** 当前 Todo 阶段列表 */
  #todoPhases: TodoPhase[] = []
  /** Todo 自动清除定时器，键为 todoClearKey() */
  #todoClearTimers = new Map<string, Timer>()
  /** 工具选择队列，控制下一次 LLM 调用强制使用的工具 */
  #toolChoiceQueue = new ToolChoiceQueue()

  // Bash execution state
  /** Bash 命令中止控制器集合 */
  #bashAbortControllers = new Set<AbortController>()
  /** 流式传输期间待刷出的 Bash 执行消息 */
  #pendingBashMessages: BashExecutionMessage[] = []

  // Python execution state
  /** Python 执行中止控制器集合 */
  #evalAbortControllers = new Set<AbortController>()
  /** Python 内核逻辑所有者 ID */
  #evalKernelOwnerId: string
  /** 本会话拥有的 AsyncJobManager（仅顶层会话）；子 Agent 不得 dispose 全局实例 */
  readonly #ownedAsyncJobManager: AsyncJobManager | undefined
  /** 流式传输期间待刷出的 Python 执行消息 */
  #pendingPythonMessages: PythonExecutionMessage[] = []
  /** 活跃 Python 执行集合，dispose 时等待其全部结束 */
  #activeEvalExecutions = new Set<Promise<unknown>>()
  /** Python 执行是否正在销毁中 */
  #evalExecutionDisposing = false

  // Background-channel IRC exchanges queued while the recipient was streaming.
  // Drained into history (via emitExternalEvent) once the recipient becomes idle.
  /** 待注入的后台 IRC 交换批次 */
  #pendingBackgroundExchanges: CustomMessage[][] = []
  /** 后台交换刷出是否已调度 */
  #scheduledBackgroundExchangeFlush = false
  // Agent identity + registry for IRC relay forwarding to the main session UI.
  /** Agent 身份标识（用于 IRC 路由） */
  #agentId: string | undefined
  /** 共享 Agent 注册表，用于将 IRC 观察转发到主会话 UI */
  #agentRegistry: AgentRegistry | undefined
  /** 覆盖的提供商会话 ID */
  #providerSessionId: string | undefined
  /** 会话是否已销毁 */
  #isDisposed = false
  // Extension system
  /** 扩展运行器，封装了扩展 Hook 调用和 UI 上下文 */
  #extensionRunner: ExtensionRunner | undefined = undefined
  /** 当前回合索引 */
  #turnIndex = 0

  /** 已加载技能列表 */
  #skills: Skill[]
  /** 技能加载警告列表 */
  #skillWarnings: SkillWarning[]

  // Custom commands (TypeScript slash commands)
  /** 自定义命令列表（TypeScript 斜杠命令） */
  #customCommands: LoadedCustomCommand[] = []
  /** MCP 提示命令列表（提示加载时动态更新） */
  #mcpPromptCommands: LoadedCustomCommand[] = []

  /** 技能设置 */
  #skillsSettings: SkillsSettings | undefined

  // Model registry for API key resolution
  /** 模型注册表，用于 API Key 解析与模型发现 */
  #modelRegistry: ModelRegistry

  // Tool registry and prompt builder for extensions
  /** 工具注册表，用于 LSP 和设置集成 */
  #toolRegistry: Map<string, AgentTool>
  /** 当前会话的预 LLM 消息转换管线 */
  #transformContext: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>
  /** 提供商请求体钩子（活跃会话请求路径使用） */
  #onPayload: SimpleStreamOptions["onPayload"] | undefined
  /** 提供商响应钩子（活跃会话请求路径使用） */
  #onResponse: SimpleStreamOptions["onResponse"] | undefined
  /** 原始 SSE 事件钩子（活跃会话请求路径使用） */
  #onSseEvent: SimpleStreamOptions["onSseEvent"] | undefined
  /** 当前会话消息到 LLM 格式的转换管线 */
  #convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>
  /** 系统提示构建器，可考虑工具可用性。返回有序的面向提供商的提示块。 */
  #rebuildSystemPrompt:
    | ((toolNames: string[], tools: Map<string, AgentTool>) => Promise<{ systemPrompt: string[] }>)
    | undefined
  /** 活跃 MCP 服务器指令获取器，用于 rebuildSystemPrompt 跳过优化 */
  #getMcpServerInstructions: (() => Map<string, string> | undefined) | undefined
  /** 从当前能力发现结果重建 SSH 工具 */
  #reloadSshTool: (() => Promise<AgentTool | null>) | undefined
  /** 请求的工具名集合（来自 --tools 标志） */
  #requestedToolNames: ReadonlySet<string> | undefined
  /** 当前基础系统提示块 */
  #baseSystemPrompt: string[]
  /** 最近一次成功 `rebuildSystemPrompt` 的活跃工具签名，用于 MCP 重连时跳过冗余重建 */
  #lastAppliedToolSignature: string | undefined
  /** 是否启用 MCP 工具发现模式 */
  #mcpDiscoveryEnabled = false
  /** 可发现 MCP 工具映射（工具名 → 描述） */
  #discoverableMCPTools = new Map<string, DiscoverableMCPTool>()
  /** 可发现 MCP 工具搜索索引 */
  #discoverableMCPSearchIndex: DiscoverableMCPSearchIndex | null = null
  /** 已选中的 MCP 工具名集合 */
  #selectedMCPToolNames = new Set<string>()
  // Generic tool discovery (covers built-in + MCP + extension when tools.discoveryMode === "all")
  /** 通用工具发现搜索索引 */
  #discoverableToolSearchIndex: DiscoverableToolSearchIndex | null = null
  /** 已选中的可发现工具名集合 */
  #selectedDiscoveredToolNames = new Set<string>()
  /** RPC 宿主工具名集合 */
  #rpcHostToolNames = new Set<string>()
  /** 默认选中的 MCP 服务器名集合 */
  #defaultSelectedMCPServerNames = new Set<string>()
  /** 默认选中的 MCP 工具名集合 */
  #defaultSelectedMCPToolNames = new Set<string>()
  /** 每个子会话默认选中的 MCP 工具名 */
  #sessionDefaultSelectedMCPToolNames = new Map<string, string[]>()

  // TTSR manager for time-traveling stream rules
  /** TTSR 管理器（时间旅行流规则） */
  #ttsrManager: TtsrManager | undefined = undefined
  /** 待注入的 TTSR 规则列表 */
  #pendingTtsrInjections: Rule[] = []
  /** 按工具调用 ID 分桶的 TTSR 规则（interruptMode 为 never 时折叠进 toolResult，不另开回合） */
  #perToolTtsrInjections = new Map<string, Rule[]>()
  /** TTSR 中止是否待处理 */
  #ttsrAbortPending = false
  /** TTSR 重试令牌 */
  #ttsrRetryToken = 0
  /** TTSR 恢复门 Promise */
  #ttsrResumePromise: Promise<void> | undefined = undefined
  /** TTSR 恢复门解析器 */
  #ttsrResumeResolve: (() => void) | undefined = undefined

  /** Plan 批准并先压缩时的一次性标志；在匹配的 aborted message_end 中消费，finally 中清除 */
  #planCompactAbortPending = false

  /** `enqueueCustomMessageDisplay` 标签单调计数器，与 Date.now() 组合保证同 tick 内唯一 */
  #customDisplayTagCounter = 0
  /** 后置任务集合 */
  #postPromptTasks = new Set<Promise<void>>()
  /** 后置任务完成聚合 Promise */
  #postPromptTasksPromise: Promise<void> | undefined = undefined
  /** 后置任务完成解析器 */
  #postPromptTasksResolve: (() => void) | undefined = undefined
  /** 后置任务中止控制器 */
  #postPromptTasksAbortController = new AbortController()

  /** 流式编辑中止是否已触发 */
  #streamingEditAbortTriggered = false
  /** 流式编辑已检查的行数缓存（路径 → 行数） */
  #streamingEditCheckedLineCounts = new Map<string, number>()

  /** 已预检过的流式编辑工具调用 ID 集合 */
  #streamingEditPrecheckedToolCallIds = new Set<string>()

  /** 流式编辑目标文件内容缓存 */
  #streamingEditFileCache = new Map<string, string>()
  /** 当前正在 InFlight 的 prompt 数量 */
  #promptInFlightCount = 0
  // Wire-level agent_end emission deferred until #promptInFlightCount drops to 0.
  // Internal extension hooks and post-emit work (auto-retry, auto-compaction, todo
  // checks in #handleAgentEvent) still fire on the original schedule — only the
  // `#emit(event)` that reaches external subscribers (rpc-mode stdout, ACP bridge,
  // Cursor exec, TUI listeners) is held back. Without this, a client that resumes
  // on `agent_end` can fire its next `prompt` before #promptWithMessage's finally
  // has decremented #promptInFlightCount, hitting AgentBusyError. Flushed from
  // both #endInFlight (normal) and #resetInFlight (abort).
  /** 延迟的 agent_end 事件（等待 InFlight 归零后才向外部订阅者分发） */
  #pendingAgentEndEmit: AgentSessionEvent | undefined
  /** 密钥混淆器（用于流式编辑内容的去混淆） */
  #obfuscator: SecretObfuscator | undefined
  /** 检查点状态 */
  #checkpointState: CheckpointState | undefined = undefined
  /** 待处理的 rewind 报告 */
  #pendingRewindReport: string | undefined = undefined
  /** 最近一次成功 yield 的工具调用 ID */
  #lastSuccessfulYieldToolCallId: string | undefined = undefined
  /** 当前提示代数（每次 prompt 调用递增） */
  #promptGeneration = 0
  /** 提供商作用域的可变状态存储 */
  #providerSessionState = new Map<string, ProviderSessionState>()
  /** Hindsight 会话状态 */
  #hindsightSessionState: HindsightSessionState | undefined = undefined
  /** 每会话原始 SSE 诊断缓冲区 */
  readonly rawSseDebugBuffer: RawSseDebugBuffer

  /** 获取 macOS 电源断言，根据设置决定阻止哪种休眠类型 */
  #acquirePowerAssertion(): void {
    if (process.platform !== "darwin") return
    if (this.#powerAssertion) return
    const idle = this.settings.get("power.preventIdleSleep")
    const system = this.settings.get("power.preventSystemSleep")
    const user = this.settings.get("power.declareUserActive")
    const display = this.settings.get("power.preventDisplaySleep")
    // All four off → user opted out; do nothing.
    if (!idle && !system && !user && !display) return
    try {
      this.#powerAssertion = MacOSPowerAssertion.start({
        reason: "Oh My Pi agent session",
        idle,
        system,
        user,
        display,
      })
    } catch (error) {
      logger.warn("Failed to acquire macOS power assertion", { error: String(error) })
    }
  }

  /** 释放 macOS 电源断言 */
  #releasePowerAssertion(): void {
    const assertion = this.#powerAssertion
    this.#powerAssertion = undefined
    if (!assertion) return
    try {
      assertion.stop()
    } catch (error) {
      logger.warn("Failed to release macOS power assertion", { error: String(error) })
    }
  }

  /** 递增 InFlight 计数，首次增至 1 时获取电源断言 */
  #beginInFlight(): void {
    this.#promptInFlightCount++
    if (this.#promptInFlightCount === 1) {
      this.#acquirePowerAssertion()
    }
  }

  /** 递减 InFlight 计数，归零时释放电源断言并刷出延迟的 agent_end 事件 */
  #endInFlight(): void {
    this.#promptInFlightCount = Math.max(0, this.#promptInFlightCount - 1)
    if (this.#promptInFlightCount === 0) {
      this.#releasePowerAssertion()
      this.#flushPendingAgentEnd()
    }
  }

  /** 重置 InFlight 计数为零，释放电源断言并刷出延迟的 agent_end 事件 */
  #resetInFlight(): void {
    this.#promptInFlightCount = 0
    this.#releasePowerAssertion()
    this.#flushPendingAgentEnd()
  }

  /** 刷出延迟的 agent_end 事件（InFlight 归零后调用） */
  #flushPendingAgentEnd(): void {
    const pending = this.#pendingAgentEndEmit
    if (!pending) return
    this.#pendingAgentEndEmit = undefined
    this.#emit(pending)
  }

  /** 构造函数：初始化所有子系统状态，订阅 Agent 核心事件 */
  constructor(config: AgentSessionConfig) {
    this.agent = config.agent
    this.sessionManager = config.sessionManager
    this.settings = config.settings
    // Power assertions are taken per turn (see #beginInFlight); nothing acquired here.
    this.#evalKernelOwnerId = config.evalKernelOwnerId ?? `agent-session:${Snowflake.next()}`
    this.#ownedAsyncJobManager = config.ownedAsyncJobManager
    this.#scopedModels = config.scopedModels ?? []
    this.#thinkingLevel = config.thinkingLevel
    this.#promptTemplates = config.promptTemplates ?? []
    this.#slashCommands = config.slashCommands ?? []
    this.#extensionRunner = config.extensionRunner
    this.#skills = config.skills ?? []
    this.#skillWarnings = config.skillWarnings ?? []
    this.#customCommands = config.customCommands ?? []
    this.#skillsSettings = config.skillsSettings
    this.#modelRegistry = config.modelRegistry
    this.#validateRetryFallbackChains()
    this.#toolRegistry = config.toolRegistry ?? new Map()
    this.#requestedToolNames = config.requestedToolNames
    this.#transformContext = config.transformContext ?? ((messages) => messages)
    this.#onPayload = config.onPayload
    this.rawSseDebugBuffer = config.rawSseDebugBuffer ?? new RawSseDebugBuffer()
    // Avoid wrapping in an `async` closure when no user callback is configured: the
    // outer await on `#onResponse` (provider-response.ts) tolerates a sync void return,
    // and skipping the wrapper drops a per-event `newPromiseCapability` allocation that
    // shows up as ~3.5% self time in streaming profiles.
    const configuredOnResponse = config.onResponse
    this.#onResponse = configuredOnResponse
      ? async (response, model) => {
          this.rawSseDebugBuffer.recordResponse(response, model)
          await configuredOnResponse(response, model)
        }
      : (response, model) => {
          this.rawSseDebugBuffer.recordResponse(response, model)
        }
    const configuredOnSseEvent = config.onSseEvent
    this.#onSseEvent = configuredOnSseEvent
      ? (event, model) => {
          this.rawSseDebugBuffer.recordEvent(event, model)
          configuredOnSseEvent(event, model)
        }
      : (event, model) => {
          this.rawSseDebugBuffer.recordEvent(event, model)
        }
    this.agent.setProviderResponseInterceptor(this.#onResponse)
    this.agent.setRawSseEventInterceptor(this.#onSseEvent)
    this.#convertToLlm = config.convertToLlm ?? convertToLlm
    this.#rebuildSystemPrompt = config.rebuildSystemPrompt
    this.#getMcpServerInstructions = config.getMcpServerInstructions
    this.#reloadSshTool = config.reloadSshTool
    this.#baseSystemPrompt = this.agent.state.systemPrompt
    this.#mcpDiscoveryEnabled = config.mcpDiscoveryEnabled ?? false
    this.#setDiscoverableMCPTools(this.#collectDiscoverableMCPToolsFromRegistry())
    this.#selectedMCPToolNames = new Set(config.initialSelectedMCPToolNames ?? [])
    this.#defaultSelectedMCPServerNames = new Set(config.defaultSelectedMCPServerNames ?? [])
    this.#defaultSelectedMCPToolNames = new Set(config.defaultSelectedMCPToolNames ?? [])
    this.#pruneSelectedMCPToolNames()
    const persistedSelectedMCPToolNames = this.buildDisplaySessionContext().selectedMCPToolNames
    const currentSelectedMCPToolNames = this.getSelectedMCPToolNames()
    const persistInitialMCPToolSelection =
      config.persistInitialMCPToolSelection ?? this.sessionManager.getBranch().length === 0
    if (
      this.#mcpDiscoveryEnabled &&
      persistInitialMCPToolSelection &&
      !this.#selectedMCPToolNamesMatch(persistedSelectedMCPToolNames, currentSelectedMCPToolNames)
    ) {
      this.sessionManager.appendMCPToolSelection(currentSelectedMCPToolNames)
    }
    this.#rememberSessionDefaultSelectedMCPToolNames(
      this.sessionManager.getSessionFile(),
      this.#getConfiguredDefaultSelectedMCPToolNames(),
    )
    this.#ttsrManager = config.ttsrManager
    this.#obfuscator = config.obfuscator
    this.#agentId = config.agentId
    this.#agentRegistry = config.agentRegistry
    this.#providerSessionId = config.providerSessionId
    this.agent.setAssistantMessageEventInterceptor((message, assistantMessageEvent) => {
      const event: AgentEvent = {
        type: "message_update",
        message,
        assistantMessageEvent,
      }
      this.#preCacheStreamingEditFile(event)
      this.#maybeAbortStreamingEdit(event)
    })
    // Per-tool TTSR reminders are folded into the matched tool's result via this hook.
    this.agent.afterToolCall = (ctx) => this.#ttsrAfterToolCall(ctx)
    this.agent.providerSessionState = this.#providerSessionState
    this.#syncAgentSessionId()
    this.#syncTodoPhasesFromBranch()
    this.#goalRuntime = new GoalRuntime({
      getState: () => this.#goalModeState,
      setState: (state) => {
        this.#goalModeState = state
      },
      getCurrentUsage: () => {
        const usage = this.getSessionStats().tokens
        return {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
        }
      },
      emit: (event) => {
        if (event.type === "goal_updated") {
          return this.#emitSessionEvent({ type: "goal_updated", goal: event.goal, state: event.state })
        }
      },
      persist: (mode, state) => {
        if (mode === "none") {
          this.sessionManager.appendModeChange("none")
        } else if (state) {
          this.sessionManager.appendModeChange(mode, { goal: state.goal })
        }
      },
      sendHiddenMessage: async (message) => {
        await this.sendCustomMessage(
          {
            customType: message.customType,
            content: message.content,
            display: false,
            attribution: "agent",
          },
          { deliverAs: message.deliverAs },
        )
      },
    })

    // Always subscribe to agent events for internal handling
    // (session persistence, hooks, auto-compaction, retry logic)
    this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent)
  }

  /** 模型注册表，用于 API Key 解析与模型发现 */
  get modelRegistry(): ModelRegistry {
    return this.#modelRegistry
  }

  /** 推进工具选择队列，返回下次 LLM 调用的工具选择指令 */
  nextToolChoice(): ToolChoice | undefined {
    return this.#toolChoiceQueue.nextToolChoice()
  }

  /** 强制下一次模型调用指定工具，随后以 "none" 终止 Agent 循环 */
  setForcedToolChoice(toolName: string): void {
    if (!this.getActiveToolNames().includes(toolName)) {
      throw new Error(`Tool "${toolName}" is not currently active.`)
    }

    const forced = buildNamedToolChoice(toolName, this.model)
    if (!forced || typeof forced === "string") {
      throw new Error("Current model does not support forcing a specific tool.")
    }

    this.#toolChoiceQueue.pushSequence([forced, "none"], {
      label: "user-force",
      onRejected: () => "requeue",
    })
  }

  /** 工具选择队列，携带强制工具指令和调用处理器 */
  get toolChoiceQueue(): ToolChoiceQueue {
    return this.#toolChoiceQueue
  }

  /** 查看当前正在执行的指令的调用处理器，供 resolve 工具使用 */
  peekQueueInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
    return this.#toolChoiceQueue.peekInFlightInvoker()
  }

  /** 常驻 resolve 处理器；无队列 invoker 时 `resolve` 工具回退到此（Plan 模式免每轮强制工具） */
  #standingResolveHandler: ((input: unknown) => Promise<unknown> | unknown) | undefined

  /** 查看常驻 resolve 处理器 */
  peekStandingResolveHandler(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
    return this.#standingResolveHandler
  }

  /** 设置常驻 resolve 处理器，Plan 模式下无需每轮强制工具选择 */
  setStandingResolveHandler(handler: ((input: unknown) => Promise<unknown> | unknown) | null): void {
    this.#standingResolveHandler = handler ?? undefined
  }

  /** 提供商作用域的可变状态存储，用于传输/会话缓存 */
  get providerSessionState(): Map<string, ProviderSessionState> {
    return this.#providerSessionState
  }

  /** 获取 Hindsight 会话状态 */
  getHindsightSessionState(): HindsightSessionState | undefined {
    return this.#hindsightSessionState
  }

  /** 设置 Hindsight 会话状态，返回先前的状态 */
  setHindsightSessionState(state: HindsightSessionState | undefined): HindsightSessionState | undefined {
    const previous = this.#hindsightSessionState
    this.#hindsightSessionState = state
    return previous
  }

  /** TTSR 管理器（时间旅行流式规则） */
  get ttsrManager(): TtsrManager | undefined {
    return this.#ttsrManager
  }

  /** TTSR 中止是否待处理（流已中断以注入规则） */
  get isTtsrAbortPending(): boolean {
    return this.#ttsrAbortPending
  }

  /** Plan 压缩静默中止是否待处理 */
  get isPlanCompactAbortPending(): boolean {
    return this.#planCompactAbortPending
  }

  /** 标记 Plan 压缩静默中止待处理，调用方 MUST 在 finally 中调用 clearPlanCompactAbortPending() */
  markPlanCompactAbortPending(): void {
    this.#planCompactAbortPending = true
  }

  /** 无条件清除静默中止标志（幂等） */
  clearPlanCompactAbortPending(): void {
    this.#planCompactAbortPending = false
  }

  /** 为自定义消息注册简洁展示文本，返回标签以便消费时移除显示条目 */
  enqueueCustomMessageDisplay(text: string, mode: "steer" | "followUp"): string {
    const tag = `omp-cmd-${Date.now()}-${++this.#customDisplayTagCounter}`
    const displayText = text.trim()
    if (!displayText) return tag
    const entry: QueuedDisplayEntry = { text: displayText, tag }
    if (mode === "steer") {
      this.#steeringMessages.push(entry)
    } else {
      this.#followUpMessages.push(entry)
    }
    return tag
  }

  /** 获取异步作业快照（运行中、最近完成、交付状态） */
  getAsyncJobSnapshot(options?: { recentLimit?: number }): AsyncJobSnapshot | null {
    const manager = AsyncJobManager.instance()
    if (!manager) return null
    const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined
    const running = manager.getRunningJobs(ownerFilter).map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      label: job.label,
      startTime: job.startTime,
    }))
    const recent = manager.getRecentJobs(options?.recentLimit ?? 5, ownerFilter).map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      label: job.label,
      startTime: job.startTime,
    }))
    const delivery = manager.getDeliveryState(ownerFilter)
    return { running, recent, delivery }
  }

  /** 取消本 Agent 注册的所有异步作业，用于生命周期转换时的清理 */
  #cancelOwnAsyncJobs(): void {
    if (!this.#agentId) return
    AsyncJobManager.instance()?.cancelAll({ ownerId: this.#agentId })
  }

  // =========================================================================
  // Event Subscription
  // =========================================================================

  /** 向所有监听器广播事件，同步调用 */
  #emit(event: AgentSessionEvent): void {
    // Copy array before iteration to avoid mutation during iteration
    const listeners = [...this.#eventListeners]
    for (const l of listeners) {
      l(event)
    }
  }

  /** 发出 UI 通知（不写入 agent state，不发送给 LLM） */
  emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void {
    this.#emit({ type: "notice", level, message, source })
  }

  /** 扩展事件串行化队列，保证 hook 按序执行 */
  #queuedExtensionEvents: Promise<void> = Promise.resolve()

  /** 将扩展事件入队串行化处理，防止并发扩展 hook 乱序 */
  #queueExtensionEvent(event: AgentSessionEvent): Promise<void> {
    const emit = async () => {
      await this.#emitExtensionEvent(event)
    }
    const queued = this.#queuedExtensionEvents.then(emit, emit)
    this.#queuedExtensionEvents = queued.catch(() => {})
    return queued
  }

  /** 发射会话事件：持久化到 session 文件，并分发到扩展 Hook 和外部订阅者 */
  async #emitSessionEvent(event: AgentSessionEvent): Promise<void> {
    if (event.type === "message_update") {
      this.#emit(event)
      void this.#queueExtensionEvent(event)
      return
    }
    await this.#emitExtensionEvent(event)
    // Hold the wire-level agent_end until in-flight prompts unwind. Subscribers
    // (rpc-mode, ACP, Cursor) treat agent_end as the "session is idle" signal;
    // emitting while #promptInFlightCount > 0 lets a client fire its next
    // `prompt` into a session that still reports isStreaming === true. Flush
    // happens in #endInFlight / #resetInFlight. A later agent_end (e.g. from
    // an auto-compaction turn that starts before the original prompt unwinds)
    // supersedes the pending one, which is what subscribers want — they only
    // care about the final settle.
    if (event.type === "agent_end" && this.#promptInFlightCount > 0) {
      this.#pendingAgentEndEmit = event
      return
    }
    this.#emit(event)
  }

  /** 上一条助手消息，供自动压缩阈值检测使用 */
  #lastAssistantMessage: AssistantMessage | undefined = undefined

  /** Agent 核心事件的内部处理器，驱动重试、压缩、TTSR、Todo 等子系统 */
  #handleAgentEvent = async (event: AgentEvent): Promise<void> => {
    // When a user message starts, check if it's from either queue and remove it BEFORE emitting
    // This ensures the UI sees the updated queue state
    if (event.type === "message_start" && event.message.role === "user") {
      const messageText = this.#getUserMessageText(event.message)
      if (messageText) {
        // Check steering queue first (match by .text on tagged records)
        const steeringIndex = this.#steeringMessages.findIndex((e) => e.text === messageText)
        if (steeringIndex !== -1) {
          this.#steeringMessages.splice(steeringIndex, 1)
        } else {
          // Check follow-up queue
          const followUpIndex = this.#followUpMessages.findIndex((e) => e.text === messageText)
          if (followUpIndex !== -1) {
            this.#followUpMessages.splice(followUpIndex, 1)
          }
        }
      }
    }

    // Tag-based dequeue for custom messages (skills queued via promptCustomMessage).
    // The InputController attached a stable tag via CustomMessage.details when it
    // registered the display chip; pull it back here to remove the matching entry
    // from the pending bar atomically with the agent's queue consumption. Match by
    // tag (not text) — two queued skills with identical args cannot collide.
    if (event.type === "message_start" && event.message.role === "custom") {
      const tag = readPendingDisplayTag(event.message.details)
      if (tag) {
        const steerIdx = this.#steeringMessages.findIndex((e) => e.tag === tag)
        if (steerIdx !== -1) {
          this.#steeringMessages.splice(steerIdx, 1)
        } else {
          const followUpIdx = this.#followUpMessages.findIndex((e) => e.tag === tag)
          if (followUpIdx !== -1) {
            this.#followUpMessages.splice(followUpIdx, 1)
          }
        }
      }
    }

    // Plan-mode → compaction transition: stamp `SILENT_ABORT_MARKER` on the
    // persisted message BEFORE the obfuscator's display-side copy below.
    // Invariant (must hold across refactors): this branch precedes the
    // `let displayEvent = event; ... displayEvent = { ...event, message: { ...message, content: deobfuscated } }`
    // block. After stamping, both `displayEvent.message` (via the spread)
    // and `event.message` (in-place mutation, used by SessionManager
    // persistence) carry the marker, guaranteeing streaming render and
    // history replay branch identically. The one-shot flag is consumed
    // here, scoped strictly to this aborted message_end; the caller's
    // `finally` (in `InteractiveMode.#approvePlan`) clears it again on
    // every terminal compaction outcome (`ok` / `cancelled` / `failed` /
    // throw) so a leaked flag cannot silence a later unrelated abort.
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason === "aborted" &&
      this.#planCompactAbortPending
    ) {
      ;(event.message as AssistantMessage).errorMessage = SILENT_ABORT_MARKER
      this.#planCompactAbortPending = false
    }

    // Deobfuscate assistant message content for display emission — the LLM echoes back
    // obfuscated placeholders, but listeners (TUI, extensions, exporters) must see real
    // values. The original event.message stays obfuscated so the persistence path below
    // writes `#HASH#` tokens to the session file; convertToLlm re-obfuscates outbound
    // traffic on the next turn. Walks text, thinking, and toolCall arguments/intent.
    let displayEvent: AgentEvent = event
    const obfuscator = this.#obfuscator
    if (obfuscator && event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message
      const deobfuscatedContent = obfuscator.deobfuscateObject(message.content)
      if (deobfuscatedContent !== message.content) {
        displayEvent = { ...event, message: { ...message, content: deobfuscatedContent } }
      }
    }

    if (event.type === "turn_start") {
      const usage = this.getSessionStats().tokens
      this.#goalRuntime.onTurnStart(`turn-${++this.#goalTurnCounter}`, {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
      })
    }

    await this.#emitSessionEvent(displayEvent)

    if (event.type === "turn_start") {
      this.#resetStreamingEditState()
      // TTSR: Reset buffer on turn start
      this.#ttsrManager?.resetBuffer()
    }

    // TTSR: Increment message count on turn end (for repeat-after-gap tracking)
    if (event.type === "turn_end" && this.#ttsrManager) {
      this.#ttsrManager.incrementMessageCount()
    }
    // Finalize the tool-choice queue's in-flight yield after tools have executed.
    // This must happen at turn_end (not message_end) because onInvoked handlers
    // run during tool execution, which happens between message_end and turn_end.
    if (event.type === "turn_end" && this.#toolChoiceQueue.hasInFlight) {
      const msg = event.message as AssistantMessage
      if (msg.stopReason === "aborted" || msg.stopReason === "error") {
        this.#toolChoiceQueue.reject(msg.stopReason === "error" ? "error" : "aborted")
      } else {
        this.#toolChoiceQueue.resolve()
      }
    }
    if (event.type === "tool_execution_end") {
      if (event.toolName === "goal") {
        await this.#goalRuntime.onGoalToolCompleted()
      } else {
        await this.#goalRuntime.onToolCompleted(event.toolName)
      }
    }
    if (event.type === "tool_execution_end" && event.toolName === "yield" && !event.isError) {
      this.#lastSuccessfulYieldToolCallId = event.toolCallId
    }
    if (event.type === "turn_end" && this.#pendingRewindReport) {
      const report = this.#pendingRewindReport
      this.#pendingRewindReport = undefined
      await this.#applyRewind(report)
    }

    // TTSR: Check for pattern matches on assistant text/thinking and tool argument deltas
    if (event.type === "message_update" && this.#ttsrManager?.hasRules()) {
      const assistantEvent = event.assistantMessageEvent
      let matchContext: TtsrMatchContext | undefined

      if (assistantEvent.type === "text_delta") {
        matchContext = { source: "text" }
      } else if (assistantEvent.type === "thinking_delta") {
        matchContext = { source: "thinking" }
      } else if (assistantEvent.type === "toolcall_delta") {
        matchContext = this.#getTtsrToolMatchContext(event.message, assistantEvent.contentIndex)
      }

      if (matchContext && "delta" in assistantEvent) {
        const matches = this.#ttsrManager.checkDelta(assistantEvent.delta, matchContext)
        if (matches.length > 0) {
          // Decide first: a non-interrupting tool-source match attaches to the
          // specific tool call's result instead of driving a loop-wide follow-up.
          const shouldInterrupt = this.#shouldInterruptForTtsrMatch(matches, matchContext)
          const perToolId = shouldInterrupt ? undefined : this.#extractTtsrToolCallId(matchContext)
          if (perToolId) {
            this.#addPerToolTtsrInjections(perToolId, matches)
            this.#emitSessionEvent({ type: "ttsr_triggered", rules: matches }).catch(() => {})
          } else {
            // Queue rules for injection; mark as injected only after successful enqueue.
            this.#addPendingTtsrInjections(matches)

            if (shouldInterrupt) {
              // Abort the stream immediately — do not gate on extension callbacks
              this.#ttsrAbortPending = true
              this.#ensureTtsrResumePromise()
              this.agent.abort()
              // Notify extensions (fire-and-forget, does not block abort)
              this.#emitSessionEvent({ type: "ttsr_triggered", rules: matches }).catch(() => {})
              // Schedule retry after a short delay
              const retryToken = ++this.#ttsrRetryToken
              const generation = this.#promptGeneration
              const targetMessageTimestamp = event.message.role === "assistant" ? event.message.timestamp : undefined
              this.#schedulePostPromptTask(
                async () => {
                  if (this.#ttsrRetryToken !== retryToken) {
                    this.#resolveTtsrResume()
                    return
                  }

                  const targetAssistantIndex = this.#findTtsrAssistantIndex(targetMessageTimestamp)
                  if (!this.#ttsrAbortPending || this.#promptGeneration !== generation || targetAssistantIndex === -1) {
                    this.#ttsrAbortPending = false
                    this.#pendingTtsrInjections = []
                    this.#perToolTtsrInjections.clear()
                    this.#resolveTtsrResume()
                    return
                  }
                  this.#ttsrAbortPending = false
                  this.#perToolTtsrInjections.clear()
                  const ttsrSettings = this.#ttsrManager?.getSettings()
                  if (ttsrSettings?.contextMode === "discard") {
                    // Remove the partial/aborted assistant turn from agent state
                    this.agent.replaceMessages(this.agent.state.messages.slice(0, targetAssistantIndex))
                  }
                  // Inject TTSR rules as system reminder before retry
                  const injection = this.#getTtsrInjectionContent()
                  if (injection) {
                    const details = { rules: injection.rules.map((rule) => rule.name) }
                    this.agent.appendMessage({
                      role: "custom",
                      customType: "ttsr-injection",
                      content: injection.content,
                      display: false,
                      details,
                      attribution: "agent",
                      timestamp: Date.now(),
                    })
                    this.sessionManager.appendCustomMessageEntry(
                      "ttsr-injection",
                      injection.content,
                      false,
                      details,
                      "agent",
                    )
                    this.#markTtsrInjected(details.rules)
                  }
                  try {
                    await this.agent.continue()
                  } catch {
                    this.#resolveTtsrResume()
                  }
                },
                { delayMs: 50 },
              )
              return
            }
          }
        }
      }
    }

    if (
      event.type === "message_update" &&
      (event.assistantMessageEvent.type === "toolcall_start" ||
        event.assistantMessageEvent.type === "toolcall_delta" ||
        event.assistantMessageEvent.type === "toolcall_end")
    ) {
      void this.#preCacheStreamingEditFile(event)
    }

    if (
      event.type === "message_update" &&
      (event.assistantMessageEvent.type === "toolcall_end" || event.assistantMessageEvent.type === "toolcall_delta")
    ) {
      this.#maybeAbortStreamingEdit(event)
    }

    // Handle session persistence
    if (event.type === "message_end") {
      // Check if this is a hook/custom message
      if (event.message.role === "hookMessage" || event.message.role === "custom") {
        // Persist as CustomMessageEntry
        this.sessionManager.appendCustomMessageEntry(
          event.message.customType,
          event.message.content,
          event.message.display,
          event.message.details,
          event.message.attribution ?? "agent",
        )
        if (event.message.role === "custom" && event.message.customType === "ttsr-injection") {
          this.#markTtsrInjected(this.#extractTtsrRuleNames(event.message.details))
        }
      } else if (
        event.message.role === "user" ||
        event.message.role === "developer" ||
        event.message.role === "assistant" ||
        event.message.role === "toolResult" ||
        event.message.role === "fileMention"
      ) {
        // Regular LLM message - persist as SessionMessageEntry
        this.sessionManager.appendMessage(event.message)
      }
      // Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

      // Track assistant message for auto-compaction (checked on agent_end)
      if (event.message.role === "assistant") {
        this.#lastAssistantMessage = event.message
        const assistantMsg = event.message as AssistantMessage
        // Resolve TTSR resume gate before checking for new deferred injections.
        // Gate on #ttsrAbortPending, not stopReason: a non-TTSR abort (e.g. streaming
        // edit) also produces stopReason === "aborted" but has no continuation coming.
        // Only skip when #ttsrAbortPending is true (TTSR continuation is imminent).
        if (!this.#ttsrAbortPending) {
          this.#resolveTtsrResume()
        }
        this.#queueDeferredTtsrInjectionIfNeeded(assistantMsg)
        if (this.#handoffAbortController) {
          this.#skipPostTurnMaintenanceAssistantTimestamp = assistantMsg.timestamp
        }
        if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted" && this.#retryAttempt > 0) {
          if (this.#activeRetryFallback && this.model) {
            await this.#emitSessionEvent({
              type: "retry_fallback_succeeded",
              model: formatRetryFallbackSelector(this.model, this.thinkingLevel),
              role: this.#activeRetryFallback.role,
            })
          }
          await this.#emitSessionEvent({
            type: "auto_retry_end",
            success: true,
            attempt: this.#retryAttempt,
          })
          this.#retryAttempt = 0
        }
      }

      if (event.message.role === "toolResult") {
        const { toolName, details, isError, content } = event.message as {
          toolName?: string
          details?: { path?: string; phases?: TodoPhase[]; report?: string; startedAt?: string }
          isError?: boolean
          content?: Array<TextContent | ImageContent>
        }
        // Invalidate streaming edit cache when edit tool completes to prevent stale data
        if (toolName === "edit" && details?.path) {
          this.#invalidateFileCacheForPath(details.path)
        }
        if (toolName === "todo_write" && !isError && Array.isArray(details?.phases)) {
          this.setTodoPhases(details.phases)
        }
        if (toolName === "todo_write" && isError) {
          const errorText = content?.find((part) => part.type === "text")?.text
          const reminderText = [
            "<system-reminder>",
            "todo_write failed, so todo progress is not visible to the user.",
            errorText ? `Failure: ${errorText}` : "Failure: todo_write returned an error.",
            "Fix the todo payload and call todo_write again before continuing.",
            "</system-reminder>",
          ].join("\n")
          await this.sendCustomMessage(
            {
              customType: "todo-write-error-reminder",
              content: reminderText,
              display: false,
              details: { toolName, errorText },
            },
            { deliverAs: "nextTurn" },
          )
        }
        if (toolName === "checkpoint" && !isError) {
          const checkpointEntryId = this.sessionManager.getEntries().at(-1)?.id ?? null
          this.#checkpointState = {
            checkpointMessageCount: this.agent.state.messages.length,
            checkpointEntryId,
            startedAt: details?.startedAt ?? new Date().toISOString(),
          }
          this.#pendingRewindReport = undefined
        }
        if (toolName === "rewind" && !isError && this.#checkpointState) {
          const detailReport = typeof details?.report === "string" ? details.report.trim() : ""
          const textReport = content?.find((part) => part.type === "text")?.text?.trim() ?? ""
          const report = detailReport || textReport
          if (report.length > 0) {
            this.#pendingRewindReport = report
          }
        }
      }
    }

    // Check auto-retry and auto-compaction after agent completes
    if (event.type === "agent_end") {
      const usage = this.getSessionStats().tokens
      await this.#goalRuntime.onAgentEnd({
        currentUsage: {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
        },
      })
      const fallbackAssistant = [...event.messages]
        .reverse()
        .find((message): message is AssistantMessage => message.role === "assistant")
      const msg = this.#lastAssistantMessage ?? fallbackAssistant
      this.#lastAssistantMessage = undefined
      if (!msg) {
        this.#lastSuccessfulYieldToolCallId = undefined
        return
      }

      // Invalidate GitHub Copilot credentials on auth failure so stale tokens
      // aren't reused on the next request
      if (
        msg.stopReason === "error" &&
        msg.provider === "github-copilot" &&
        msg.errorMessage?.includes("GitHub Copilot authentication failed")
      ) {
        await this.#modelRegistry.authStorage.remove("github-copilot")
      }

      if (this.#skipPostTurnMaintenanceAssistantTimestamp === msg.timestamp) {
        this.#skipPostTurnMaintenanceAssistantTimestamp = undefined
        this.#lastSuccessfulYieldToolCallId = undefined
        return
      }

      if (this.#assistantEndedWithSuccessfulYield(msg)) {
        this.#lastSuccessfulYieldToolCallId = undefined
        return
      }
      this.#lastSuccessfulYieldToolCallId = undefined

      // Check for retryable errors first (overloaded, rate limit, server errors)
      if (this.#isRetryableError(msg)) {
        const didRetry = await this.#handleRetryableError(msg)
        if (didRetry) return // Retry was initiated, don't proceed to compaction
      }
      this.#resolveRetry()

      if (msg.stopReason === "aborted" && this.#checkpointState) {
        this.#checkpointState = undefined
        this.#pendingRewindReport = undefined
      }
      const compactionTask = this.#checkCompaction(msg)
      this.#trackPostPromptTask(compactionTask)
      await compactionTask
      // Check for incomplete todos only after a final assistant stop, not intermediate tool-use turns.
      const hasToolCalls = msg.content.some((content) => content.type === "toolCall")
      if (hasToolCalls) {
        return
      }
      if (msg.stopReason !== "error" && msg.stopReason !== "aborted") {
        if (this.#enforceRewindBeforeYield()) {
          return
        }
        await this.#checkTodoCompletion()
      }
    }
  }

  /** 解析待处理的重试 Promise，触发下一次重试立即执行 */
  #resolveRetry(): void {
    if (this.#retryResolve) {
      this.#retryResolve()
      this.#retryResolve = undefined
      this.#retryPromise = undefined
    }
  }

  /** 创建 TTSR 恢复门 Promise（若已存在则跳过） */
  #ensureTtsrResumePromise(): void {
    if (this.#ttsrResumePromise) return
    const { promise, resolve } = Promise.withResolvers<void>()
    this.#ttsrResumePromise = promise
    this.#ttsrResumeResolve = resolve
  }

  /** 解析并清除 TTSR 恢复门 */
  #resolveTtsrResume(): void {
    if (!this.#ttsrResumeResolve) return
    this.#ttsrResumeResolve()
    this.#ttsrResumeResolve = undefined
    this.#ttsrResumePromise = undefined
  }

  /** 确保后置任务完成 Promise 存在 */
  #ensurePostPromptTasksPromise(): void {
    if (this.#postPromptTasksPromise) return
    const { promise, resolve } = Promise.withResolvers<void>()
    this.#postPromptTasksPromise = promise
    this.#postPromptTasksResolve = resolve
  }

  /** 解析后置任务 Promise，所有任务完成后调用 */
  #resolvePostPromptTasks(): void {
    if (!this.#postPromptTasksResolve) return
    this.#postPromptTasksResolve()
    this.#postPromptTasksResolve = undefined
    this.#postPromptTasksPromise = undefined
  }

  /** 追踪后置任务，全部完成后解析聚合 Promise */
  #trackPostPromptTask(task: Promise<void>): void {
    this.#postPromptTasks.add(task)
    this.#ensurePostPromptTasksPromise()
    void task
      .catch(() => {})
      .finally(() => {
        this.#postPromptTasks.delete(task)
        if (this.#postPromptTasks.size === 0) {
          this.#resolvePostPromptTasks()
        }
      })
  }

  /** 调度延迟后置任务（支持 delay、prompt 代数与 onSkip） */
  #schedulePostPromptTask(
    task: (signal: AbortSignal) => Promise<void>,
    options?: { delayMs?: number; generation?: number; onSkip?: () => void },
  ): void {
    const delayMs = options?.delayMs ?? 0
    const signal = this.#postPromptTasksAbortController.signal
    const scheduled = (async () => {
      if (delayMs > 0) {
        try {
          await scheduler.wait(delayMs, { signal })
        } catch {
          return
        }
      }
      if (signal.aborted) {
        options?.onSkip?.()
        return
      }
      if (options?.generation !== undefined && this.#promptGeneration !== options.generation) {
        options.onSkip?.()
        return
      }
      await task(signal)
    })()
    this.#trackPostPromptTask(scheduled)
  }

  /** 调度 Agent 继续执行（agent.continue），可附带延迟与 shouldContinue 门控 */
  #scheduleAgentContinue(options?: {
    delayMs?: number
    generation?: number
    shouldContinue?: () => boolean
    onSkip?: () => void
    onError?: () => void
  }): void {
    this.#schedulePostPromptTask(
      async () => {
        if (options?.shouldContinue && !options.shouldContinue()) {
          options.onSkip?.()
          return
        }
        try {
          await this.#maybeRestoreRetryFallbackPrimary()
          await this.agent.continue()
        } catch (error) {
          logger.warn("agent.continue failed after scheduling", {
            error: error instanceof Error ? error.message : String(error),
          })
          options?.onError?.()
        }
      },
      {
        delayMs: options?.delayMs,
        generation: options?.generation,
        onSkip: options?.onSkip,
      },
    )
  }

  /** 调度自动继续提示（developer 合成消息，绑定 prompt 代数） */
  #scheduleAutoContinuePrompt(generation: number): void {
    const continuePrompt = async () => {
      await this.#promptWithMessage(
        {
          role: "developer",
          content: [{ type: "text", text: autoContinuePrompt }],
          attribution: "agent",
          timestamp: Date.now(),
        },
        autoContinuePrompt,
        { skipPostPromptRecoveryWait: true },
      )
    }
    this.#schedulePostPromptTask(
      async (signal) => {
        await Promise.resolve()
        if (signal.aborted) return
        await continuePrompt()
      },
      { generation },
    )
  }

  /** 取消所有后置任务并重置中止控制器 */
  async #cancelPostPromptTasks(): Promise<void> {
    this.#postPromptTasksAbortController.abort()
    this.#postPromptTasksAbortController = new AbortController()
    this.#resolveTtsrResume()

    const pendingTasks = Array.from(this.#postPromptTasks)
    if (pendingTasks.length === 0) {
      this.#resolvePostPromptTasks()
      return
    }

    await Promise.allSettled(pendingTasks)
    if (this.#postPromptTasks.size === 0) {
      this.#resolvePostPromptTasks()
    }
  }
  /** 等待重试、TTSR 恢复门与后台 continue 全部 settle（可循环，因二者可能互相触发） */
  async #waitForPostPromptRecovery(): Promise<void> {
    while (true) {
      if (this.#retryPromise) {
        await this.#retryPromise
        continue
      }
      if (this.#ttsrResumePromise) {
        await this.#ttsrResumePromise
        continue
      }
      if (this.#postPromptTasksPromise) {
        await this.#postPromptTasksPromise
        continue
      }
      // Tracked post-prompt tasks cover deferred continuations scheduled from
      // event handlers. Keep the streaming fallback for direct agent activity
      // outside the scheduler.
      if (this.agent.state.isStreaming) {
        await this.agent.waitForIdle()
        continue
      }
      break
    }
  }

  /** 获取 TTSR 注入负载并清空待注入规则列表 */
  #getTtsrInjectionContent(): { content: string; rules: Rule[] } | undefined {
    if (this.#pendingTtsrInjections.length === 0) return undefined
    const rules = this.#pendingTtsrInjections
    const content = rules
      .map((r) => prompt.render(ttsrInterruptTemplate, { name: r.name, path: r.path, content: r.content }))
      .join("\n\n")
    this.#pendingTtsrInjections = []
    return { content, rules }
  }

  /** 添加待注入的 TTSR 规则（按规则名去重） */
  #addPendingTtsrInjections(rules: Rule[]): void {
    const seen = new Set(this.#pendingTtsrInjections.map((rule) => rule.name))
    for (const rule of rules) {
      if (seen.has(rule.name)) continue
      this.#pendingTtsrInjections.push(rule)
      seen.add(rule.name)
    }
  }

  /** 从匹配上下文中提取触发 TTSR 匹配的工具调用 ID */
  #extractTtsrToolCallId(matchContext: TtsrMatchContext): string | undefined {
    if (matchContext.source !== "tool") return undefined
    const key = matchContext.streamKey
    if (typeof key !== "string" || !key.startsWith("toolcall:")) return undefined
    const id = key.slice("toolcall:".length)
    return id.length > 0 ? id : undefined
  }

  /** 将 TTSR 规则按工具调用 ID 分桶存储，并在管理器中声明已占用 */
  #addPerToolTtsrInjections(toolCallId: string, rules: Rule[]): void {
    const bucket = this.#perToolTtsrInjections.get(toolCallId) ?? []
    const seen = new Set(bucket.map((rule) => rule.name))
    // Dedupe against rules already bucketed for other tool calls in this
    // same assistant message so one rule attaches to exactly one tool call.
    const claimedElsewhere = new Set<string>()
    for (const [otherId, otherBucket] of this.#perToolTtsrInjections) {
      if (otherId === toolCallId) continue
      for (const rule of otherBucket) claimedElsewhere.add(rule.name)
    }
    const newlyAdded: string[] = []
    for (const rule of rules) {
      if (seen.has(rule.name) || claimedElsewhere.has(rule.name)) continue
      bucket.push(rule)
      seen.add(rule.name)
      newlyAdded.push(rule.name)
    }
    if (bucket.length === 0) return
    this.#perToolTtsrInjections.set(toolCallId, bucket)
    // Claim the rules in the TTSR manager so subsequent deltas in this same
    // turn (e.g. a sibling tool call's argument stream) don't re-match them.
    // Persistence still happens in #ttsrAfterToolCall when the tool actually
    // produces a result we can fold the reminder into.
    if (newlyAdded.length > 0) {
      this.#ttsrManager?.markInjectedByNames(newlyAdded)
    }
  }

  /** afterToolCall 钩子：将 per-tool TTSR 提醒折叠进工具结果内容 */
  #ttsrAfterToolCall(ctx: AfterToolCallContext): AfterToolCallResult | undefined {
    const rules = this.#perToolTtsrInjections.get(ctx.toolCall.id)
    if (!rules || rules.length === 0) return undefined
    this.#perToolTtsrInjections.delete(ctx.toolCall.id)
    const reminder = rules
      .map((r) => prompt.render(ttsrToolReminderTemplate, { name: r.name, path: r.path, content: r.content }))
      .join("\n\n")
    // The TTSR manager was already claimed at bucket time; only persistence remains.
    const ruleNames = rules.map((r) => r.name.trim()).filter((n) => n.length > 0)
    if (ruleNames.length > 0) {
      this.sessionManager.appendTtsrInjection(ruleNames)
    }
    return {
      content: [{ type: "text", text: reminder }, ...ctx.result.content],
    }
  }

  /** 从事件 details 中提取 TTSR 规则名列表 */
  #extractTtsrRuleNames(details: unknown): string[] {
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return []
    }
    const rules = (details as { rules?: unknown }).rules
    if (!Array.isArray(rules)) {
      return []
    }
    return rules.filter((ruleName): ruleName is string => typeof ruleName === "string")
  }

  /** 标记 TTSR 规则已注入（管理器 + 会话持久化） */
  #markTtsrInjected(ruleNames: string[]): void {
    const uniqueRuleNames = Array.from(
      new Set(ruleNames.map((ruleName) => ruleName.trim()).filter((ruleName) => ruleName.length > 0)),
    )
    if (uniqueRuleNames.length === 0) {
      return
    }
    this.#ttsrManager?.markInjectedByNames(uniqueRuleNames)
    this.sessionManager.appendTtsrInjection(uniqueRuleNames)
  }

  /** 在 Agent 消息中查找目标时间戳的助手消息索引 */
  #findTtsrAssistantIndex(targetTimestamp: number | undefined): number {
    const messages = this.agent.state.messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role !== "assistant") {
        continue
      }
      if (targetTimestamp === undefined || message.timestamp === targetTimestamp) {
        return i
      }
    }
    return -1
  }

  /** 判断 TTSR 匹配是否应中断当前流（按 interruptMode / 全局设置） */
  #shouldInterruptForTtsrMatch(matches: Rule[], matchContext: TtsrMatchContext): boolean {
    const globalMode = this.#ttsrManager?.getSettings().interruptMode ?? "always"
    for (const rule of matches) {
      const mode = rule.interruptMode ?? globalMode
      if (mode === "never") continue
      if (mode === "prose-only" && (matchContext.source === "text" || matchContext.source === "thinking")) return true
      if (mode === "tool-only" && matchContext.source === "tool") return true
      if (mode === "always") return true
    }
    return false
  }

  /** 助手消息结束后按需排队延迟 TTSR 注入并调度 continue */
  #queueDeferredTtsrInjectionIfNeeded(assistantMsg: AssistantMessage): void {
    if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") {
      // Tools that hadn't started by abort/error will never produce results to
      // fold injections into — drop their stale per-tool entries.
      this.#perToolTtsrInjections.clear()
    }
    if (this.#ttsrAbortPending || this.#pendingTtsrInjections.length === 0) {
      return
    }
    if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") {
      this.#pendingTtsrInjections = []
      return
    }

    const injection = this.#getTtsrInjectionContent()
    if (!injection) {
      return
    }
    this.agent.followUp({
      role: "custom",
      customType: "ttsr-injection",
      content: injection.content,
      display: false,
      details: { rules: injection.rules.map((rule) => rule.name) },
      attribution: "agent",
      timestamp: Date.now(),
    })
    this.#ensureTtsrResumePromise()
    // Mark as injected after this custom message is delivered and persisted (handled in message_end).
    // followUp() only enqueues; resume on the next tick once streaming settles.
    this.#scheduleAgentContinue({
      delayMs: 1,
      generation: this.#promptGeneration,
      onSkip: () => {
        this.#resolveTtsrResume()
      },
      shouldContinue: () => {
        if (this.agent.state.isStreaming || !this.agent.hasQueuedMessages()) {
          this.#resolveTtsrResume()
          return false
        }
        return true
      },
      onError: () => {
        this.#resolveTtsrResume()
      },
    })
  }

  /** Build TTSR match context for tool call argument deltas. */
  /** 为工具调用参数增量构建 TTSR 匹配上下文，供 glob 路径匹配和流规则触发 */
  #getTtsrToolMatchContext(message: AgentMessage, contentIndex: number): TtsrMatchContext {
    const context: TtsrMatchContext = { source: "tool" }
    if (message.role !== "assistant") {
      return context
    }

    const content = message.content
    if (!Array.isArray(content) || contentIndex < 0 || contentIndex >= content.length) {
      return context
    }

    const block = content[contentIndex]
    if (!block || typeof block !== "object" || block.type !== "toolCall") {
      return context
    }

    const toolCall = block as ToolCall
    context.toolName = toolCall.name
    context.streamKey = toolCall.id ? `toolcall:${toolCall.id}` : `tool:${toolCall.name}:${contentIndex}`
    context.filePaths = this.#extractTtsrFilePathsFromArgs(toolCall.arguments)
    return context
  }

  /** Extract path-like arguments from tool call payload for TTSR glob matching. */
  /** 从工具调用参数中提取路径类参数，用于 TTSR glob 匹配 */
  #extractTtsrFilePathsFromArgs(args: unknown): string[] | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined
    }

    const rawPaths: string[] = []
    for (const [key, value] of Object.entries(args)) {
      const normalizedKey = key.toLowerCase()
      if (typeof value === "string" && (normalizedKey === "path" || normalizedKey.endsWith("path"))) {
        rawPaths.push(value)
        continue
      }
      if (Array.isArray(value) && (normalizedKey === "paths" || normalizedKey.endsWith("paths"))) {
        for (const candidate of value) {
          if (typeof candidate === "string") {
            rawPaths.push(candidate)
          }
        }
      }
    }

    const normalizedPaths = rawPaths.flatMap((pathValue) => this.#normalizeTtsrPathCandidates(pathValue))
    if (normalizedPaths.length === 0) {
      return undefined
    }

    return Array.from(new Set(normalizedPaths))
  }

  /** Convert a path argument into stable relative/absolute candidates for glob checks. */
  /** 将路径参数转换为稳定的相对/绝对候选路径，用于 TTSR glob 规则匹配 */
  #normalizeTtsrPathCandidates(rawPath: string): string[] {
    const trimmed = rawPath.trim()
    if (trimmed.length === 0) {
      return []
    }

    const normalizedInput = trimmed.replaceAll("\\", "/")
    const candidates = new Set<string>([normalizedInput])
    if (normalizedInput.startsWith("./")) {
      candidates.add(normalizedInput.slice(2))
    }

    const cwd = this.sessionManager.getCwd()
    const absolutePath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed)
    candidates.add(absolutePath.replaceAll("\\", "/"))

    const relativePath = path.relative(cwd, absolutePath).replaceAll("\\", "/")
    if (relativePath && relativePath !== "." && !relativePath.startsWith("../") && relativePath !== "..") {
      candidates.add(relativePath)
    }

    return Array.from(candidates)
  }
  /** Extract text content from a message */
  /** 从消息中提取文本内容，图片消息返回 "[Image]" 占位符 */
  #getUserMessageText(message: Message): string {
    if (message.role !== "user") return ""
    const content = message.content
    if (typeof content === "string") return content
    const textBlocks = content.filter((c) => c.type === "text")
    const text = textBlocks.map((c) => (c as TextContent).text).join("")
    if (text.length > 0) return text
    const hasImages = content.some((c) => c.type === "image")
    return hasImages ? "[Image]" : ""
  }

  /** Find the last assistant message in agent state (including aborted ones) */
  /** 在 Agent 状态中查找最后一条助手消息（含中断消息） */
  #findLastAssistantMessage(): AssistantMessage | undefined {
    const messages = this.agent.state.messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === "assistant") {
        return msg as AssistantMessage
      }
    }
    return undefined
  }

  /** 重置流式编辑状态（每回合开始时清空） */
  #resetStreamingEditState(): void {
    this.#streamingEditAbortTriggered = false
    this.#streamingEditCheckedLineCounts.clear()
    this.#streamingEditPrecheckedToolCallIds.clear()
    this.#streamingEditFileCache.clear()
  }

  /** 从 Agent 事件中提取编辑工具调用的详细信息，包括路径和 diff */
  #getStreamingEditToolCall(event: AgentEvent):
    | {
        toolCall: ToolCall
        path: string
        resolvedPath: string
        diff?: string
        op?: string
        rename?: string
      }
    | undefined {
    if (event.type !== "message_update") return undefined
    if (event.message.role !== "assistant") return undefined

    const contentIndex = event.assistantMessageEvent.contentIndex ?? 0
    const messageContent = event.message.content
    if (!Array.isArray(messageContent) || contentIndex < 0 || contentIndex >= messageContent.length) {
      return undefined
    }

    const toolCall = messageContent[contentIndex] as ToolCall
    if (toolCall.name !== "edit") return undefined

    const args = toolCall.arguments
    if (!args || typeof args !== "object" || Array.isArray(args)) return undefined
    if ("old_text" in args || "new_text" in args) return undefined

    const path = typeof args.path === "string" ? args.path : undefined
    if (!path) return undefined

    // `local://` URLs (e.g. local://PLAN.md for plan-mode) resolve to a real
    // on-disk artifacts path; pre-caching works as long as we ask the
    // local-protocol handler. Other internal-scheme URLs (agent://, skill://,
    // rule://, mcp://, artifact://) have no stable filesystem representation;
    // skip pre-cache entirely for those — the edit tool itself will reject
    // them through its normal dispatch path.
    const resolvedPath = this.#resolveSessionFsPath(path)
    if (resolvedPath === undefined) return undefined

    return {
      toolCall,
      path,
      resolvedPath,
      diff: typeof args.diff === "string" ? args.diff : undefined,
      op: typeof args.op === "string" ? args.op : undefined,
      rename: typeof args.rename === "string" ? args.rename : undefined,
    }
  }

  /** 最近一次流式编辑工具调用 ID（自动生文件守卫去重） */
  #lastStreamingEditToolCallId: string | undefined
  /** 检测自动生成文件并在检测到时中止流式编辑 */
  #abortStreamingEditForAutoGeneratedPath(toolCall: ToolCall, path: string, resolvedPath: string): void {
    if (this.#lastStreamingEditToolCallId === toolCall.id) return
    this.#lastStreamingEditToolCallId = toolCall.id
    void assertEditableFile(resolvedPath, path).catch((err) => {
      // peekFile and other I/O can reject with ENOENT, etc. Only ToolError means
      // auto-generated detection; other failures are left for the edit tool.
      if (!(err instanceof ToolError)) return
      if (this.#lastStreamingEditToolCallId !== toolCall.id) return

      if (!this.#streamingEditAbortTriggered) {
        this.#streamingEditAbortTriggered = true
        logger.warn("Streaming edit aborted due to auto-generated file guard", {
          toolCallId: toolCall.id,
          path,
        })
        this.agent.abort()
      }
    })
  }

  /** 预缓存流式编辑的目标文件内容，以便后续删除行检查 */
  #preCacheStreamingEditFile(event: AgentEvent): void {
    if (this.#streamingEditAbortTriggered) return
    if (event.type !== "message_update") return

    const assistantEvent = event.assistantMessageEvent
    if (
      assistantEvent.type !== "toolcall_start" &&
      assistantEvent.type !== "toolcall_delta" &&
      assistantEvent.type !== "toolcall_end"
    ) {
      return
    }

    const streamingEdit = this.#getStreamingEditToolCall(event)
    if (!streamingEdit) return

    // The auto-generated guard runs unconditionally: editing a generated file
    // is never the user's intent, and the cost of a false-positive abort is one
    // wasted turn vs. silently corrupting a regenerated source.
    const shouldCheckAutoGenerated =
      !streamingEdit.toolCall.id || !this.#streamingEditPrecheckedToolCallIds.has(streamingEdit.toolCall.id)
    if (shouldCheckAutoGenerated) {
      if (streamingEdit.toolCall.id) {
        this.#streamingEditPrecheckedToolCallIds.add(streamingEdit.toolCall.id)
      }
      this.#abortStreamingEditForAutoGeneratedPath(
        streamingEdit.toolCall,
        streamingEdit.path,
        streamingEdit.resolvedPath,
      )
    }

    // File-cache priming feeds #maybeAbortStreamingEdit's removed-lines check,
    // which is the optional patch-preview verification gated by
    // edit.streamingAbort. Skip the read when the setting is off.
    if (this.settings.get("edit.streamingAbort")) {
      this.#ensureFileCache(streamingEdit.resolvedPath)
    }
  }

  /** 确保文件内容已缓存（如已缓存则跳过读取） */
  #ensureFileCache(resolvedPath: string): void {
    if (this.#streamingEditFileCache.has(resolvedPath)) return

    try {
      const rawText = fs.readFileSync(resolvedPath, "utf-8")
      const { text } = stripBom(rawText)
      this.#streamingEditFileCache.set(resolvedPath, normalizeToLF(text))
    } catch {
      // Don't cache on read errors (including ENOENT) - let the edit tool handle them
    }
  }

  /** Invalidate cache for a file after an edit completes to prevent stale data */
  /** 编辑完成后使文件缓存失效，防止下次流式检查读到脏数据 */
  #invalidateFileCacheForPath(filePath: string): void {
    const resolvedPath = this.#resolveSessionFsPath(filePath)
    if (resolvedPath === undefined) return
    this.#streamingEditFileCache.delete(resolvedPath)
  }

  /**
   * Resolve a path supplied to a tool to a real filesystem path.
   *
   * - `local://` URLs route through the local-protocol handler so they map
   *   onto the session's on-disk artifacts directory; pre-caching, ENOENT
   *   handling, and post-edit invalidation all work normally.
   * - Other internal-scheme URLs (agent://, skill://, rule://, mcp://,
   *   artifact://) have no stable filesystem path; this returns `undefined`
   *   so callers skip filesystem-only operations.
   * - Cwd-relative and absolute paths resolve via `resolveToCwd`.
   */
  /** 将工具路径解析为真实文件系统路径，local:// 路由到 artifacts 目录，其他内部协议返回 undefined */
  #resolveSessionFsPath(filePath: string): string | undefined {
    const normalized = normalizeLocalScheme(filePath)
    if (normalized.startsWith("local:")) {
      return resolveLocalUrlToPath(normalized, this.#localProtocolOptions())
    }
    if (
      normalized.startsWith("agent://") ||
      normalized.startsWith("skill://") ||
      normalized.startsWith("rule://") ||
      normalized.startsWith("mcp://") ||
      normalized.startsWith("artifact://")
    ) {
      return undefined
    }
    return resolveToCwd(normalized, this.sessionManager.getCwd())
  }

  /** 获取本地协议选项（artifacts 目录和会话 ID） */
  #localProtocolOptions(): LocalProtocolOptions {
    return {
      getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
      getSessionId: () => this.sessionManager.getSessionId(),
    }
  }

  /** 检查流式编辑的 diff 内容，若验证失败则中止（受 edit.streamingAbort 设置控制） */
  #maybeAbortStreamingEdit(event: AgentEvent): void {
    if (!this.settings.get("edit.streamingAbort")) return
    if (this.#streamingEditAbortTriggered) return
    if (event.type !== "message_update") return

    const assistantEvent = event.assistantMessageEvent
    if (assistantEvent.type !== "toolcall_end" && assistantEvent.type !== "toolcall_delta") return

    const streamingEdit = this.#getStreamingEditToolCall(event)
    if (!streamingEdit?.toolCall.id) return

    const { toolCall, path, resolvedPath, diff, op, rename } = streamingEdit
    if (!diff) return
    if (op && op !== "update") return

    if (!diff.includes("\n")) return
    const lastNewlineIndex = diff.lastIndexOf("\n")
    if (lastNewlineIndex < 0) return
    const diffForCheck = diff.endsWith("\n") ? diff : diff.slice(0, lastNewlineIndex + 1)
    if (diffForCheck.trim().length === 0) return

    let normalizedDiff = normalizeDiff(diffForCheck.replace(/\r/g, ""))
    if (!normalizedDiff) return
    // Deobfuscate the diff so removed lines match real file content
    if (this.#obfuscator) normalizedDiff = this.#obfuscator.deobfuscate(normalizedDiff)
    if (!normalizedDiff) return
    const lines = normalizedDiff.split("\n")
    const hasChangeLine = lines.some((line) => line.startsWith("+") || line.startsWith("-"))
    if (!hasChangeLine) return

    const lineCount = lines.length
    const lastChecked = this.#streamingEditCheckedLineCounts.get(toolCall.id)
    if (lastChecked !== undefined && lineCount <= lastChecked) return
    this.#streamingEditCheckedLineCounts.set(toolCall.id, lineCount)

    const removedLines = lines
      .filter((line) => line.startsWith("-") && !line.startsWith("--- "))
      .map((line) => line.slice(1))
    if (removedLines.length > 0) {
      let cachedContent = this.#streamingEditFileCache.get(resolvedPath)
      if (cachedContent === undefined) {
        this.#ensureFileCache(resolvedPath)
        cachedContent = this.#streamingEditFileCache.get(resolvedPath)
      }
      if (cachedContent !== undefined) {
        const missing = removedLines.find((line) => !cachedContent.includes(normalizeToLF(line)))
        if (missing) {
          this.#streamingEditAbortTriggered = true
          logger.warn("Streaming edit aborted due to patch preview failure", {
            toolCallId: toolCall.id,
            path,
            error: `Failed to find expected lines in ${path}:\n${missing}`,
          })
          this.agent.abort()
        }
        return
      }
      if (assistantEvent.type === "toolcall_delta") return
      void this.#checkRemovedLinesAsync(toolCall.id, path, resolvedPath, removedLines)
      return
    }

    if (assistantEvent.type === "toolcall_delta") return
    void this.#checkPreviewPatchAsync(toolCall.id, path, rename, normalizedDiff)
  }

  /** 异步检查已删除行是否存在于目标文件中，缺失则中止流式编辑 */
  async #checkRemovedLinesAsync(
    toolCallId: string,
    path: string,
    resolvedPath: string,
    removedLines: string[],
  ): Promise<void> {
    if (this.#streamingEditAbortTriggered) return
    try {
      const { text } = stripBom(await Bun.file(resolvedPath).text())
      const normalizedContent = normalizeToLF(text)
      const missing = removedLines.find((line) => !normalizedContent.includes(normalizeToLF(line)))
      if (missing) {
        this.#streamingEditAbortTriggered = true
        logger.warn("Streaming edit aborted due to patch preview failure", {
          toolCallId,
          path,
          error: `Failed to find expected lines in ${path}:\n${missing}`,
        })
        this.agent.abort()
      }
    } catch (err) {
      // Ignore ENOENT (file not found) - let the edit tool handle missing files
      // Also ignore other errors during async fallback
      if (!isEnoent(err)) {
        // Log unexpected errors but don't abort
      }
    }
  }

  /** 异步执行补丁预览验证，失败则中止流式编辑 */
  async #checkPreviewPatchAsync(
    toolCallId: string,
    path: string,
    rename: string | undefined,
    normalizedDiff: string,
  ): Promise<void> {
    if (this.#streamingEditAbortTriggered) return
    try {
      await previewPatch(
        { path, op: "update", rename, diff: normalizedDiff },
        {
          cwd: this.sessionManager.getCwd(),
          allowFuzzy: this.settings.get("edit.fuzzyMatch"),
          fuzzyThreshold: this.settings.get("edit.fuzzyThreshold"),
        },
      )
    } catch (error) {
      if (error instanceof ParseError) return
      this.#streamingEditAbortTriggered = true
      logger.warn("Streaming edit aborted due to patch preview failure", {
        toolCallId,
        path,
        error: error instanceof Error ? error.message : String(error),
      })
      this.agent.abort()
    }
  }

  /** 将会话事件转换并分发到扩展运行器 */
  async #emitExtensionEvent(event: AgentSessionEvent): Promise<void> {
    if (!this.#extensionRunner) return
    if (event.type === "agent_start") {
      this.#turnIndex = 0
      await this.#extensionRunner.emit({ type: "agent_start" })
    } else if (event.type === "agent_end") {
      await this.#extensionRunner.emit({ type: "agent_end", messages: event.messages })
    } else if (event.type === "turn_start") {
      const hookEvent: TurnStartEvent = {
        type: "turn_start",
        turnIndex: this.#turnIndex,
        timestamp: Date.now(),
      }
      await this.#extensionRunner.emit(hookEvent)
    } else if (event.type === "turn_end") {
      const hookEvent: TurnEndEvent = {
        type: "turn_end",
        turnIndex: this.#turnIndex,
        message: event.message,
        toolResults: event.toolResults,
      }
      await this.#extensionRunner.emit(hookEvent)
      this.#turnIndex++
    } else if (event.type === "message_start") {
      const extensionEvent: MessageStartEvent = {
        type: "message_start",
        message: event.message,
      }
      await this.#extensionRunner.emit(extensionEvent)
    } else if (event.type === "message_update") {
      const extensionEvent: MessageUpdateEvent = {
        type: "message_update",
        message: event.message,
        assistantMessageEvent: event.assistantMessageEvent,
      }
      await this.#extensionRunner.emit(extensionEvent)
    } else if (event.type === "message_end") {
      const extensionEvent: MessageEndEvent = {
        type: "message_end",
        message: event.message,
      }
      await this.#extensionRunner.emit(extensionEvent)
    } else if (event.type === "tool_execution_start") {
      const extensionEvent: ToolExecutionStartEvent = {
        type: "tool_execution_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        intent: event.intent,
      }
      await this.#extensionRunner.emit(extensionEvent)
    } else if (event.type === "tool_execution_update") {
      const extensionEvent: ToolExecutionUpdateEvent = {
        type: "tool_execution_update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        partialResult: event.partialResult,
      }
      await this.#extensionRunner.emit(extensionEvent)
    } else if (event.type === "tool_execution_end") {
      const extensionEvent: ToolExecutionEndEvent = {
        type: "tool_execution_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError ?? false,
      }
      await this.#extensionRunner.emit(extensionEvent)
    } else if (event.type === "auto_compaction_start") {
      await this.#extensionRunner.emit({
        type: "auto_compaction_start",
        reason: event.reason,
        action: event.action,
      })
    } else if (event.type === "auto_compaction_end") {
      await this.#extensionRunner.emit({
        type: "auto_compaction_end",
        action: event.action,
        result: event.result,
        aborted: event.aborted,
        willRetry: event.willRetry,
        errorMessage: event.errorMessage,
        skipped: event.skipped,
      })
    } else if (event.type === "auto_retry_start") {
      await this.#extensionRunner.emit({
        type: "auto_retry_start",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage,
      })
    } else if (event.type === "auto_retry_end") {
      await this.#extensionRunner.emit({
        type: "auto_retry_end",
        success: event.success,
        attempt: event.attempt,
        finalError: event.finalError,
      })
    } else if (event.type === "ttsr_triggered") {
      await this.#extensionRunner.emit({ type: "ttsr_triggered", rules: event.rules })
    } else if (event.type === "todo_reminder") {
      await this.#extensionRunner.emit({
        type: "todo_reminder",
        todos: event.todos,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
      })
    } else if (event.type === "goal_updated") {
      await this.#extensionRunner.emit({
        type: "goal_updated",
        goal: event.goal,
        state: event.state,
      })
    }
  }

  /**
   * Subscribe to agent events.
   * Session persistence is handled internally (saves messages on message_end).
   * Multiple listeners can be added. Returns unsubscribe function for this listener.
   */
  /** 订阅会话事件，返回退订函数；会话持久化由内部处理，支持多监听器 */
  subscribe(listener: AgentSessionEventListener): () => void {
    this.#eventListeners.push(listener)

    // Return unsubscribe function for this specific listener
    return () => {
      const index = this.#eventListeners.indexOf(listener)
      if (index !== -1) {
        this.#eventListeners.splice(index, 1)
      }
    }
  }

  /**
   * Temporarily disconnect from agent events.
   * User listeners are preserved and will receive events again after resubscribe().
   * Used internally during operations that need to pause event processing.
   */
  /** 暂时断开 Agent 核心事件连接，用户监听器保留，操作完成后可重连 */
  #disconnectFromAgent(): void {
    if (this.#unsubscribeAgent) {
      this.#unsubscribeAgent()
      this.#unsubscribeAgent = undefined
    }
  }

  /**
   * Reconnect to agent events after _disconnectFromAgent().
   * Preserves all existing listeners.
   */
  /** 重新连接到 Agent 核心事件，保留所有现有监听器 */
  #reconnectToAgent(): void {
    if (this.#unsubscribeAgent) return // Already connected
    this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent)
  }

  /**
   * Set agent.sessionId from the session manager and install a dynamic
   * metadata resolver so every API request carries `metadata.user_id` shaped
   * like real Claude Code's `getAPIMetadata` output: `{ session_id,
   * account_uuid }` (the latter only when an Anthropic OAuth credential with
   * a known account UUID is loaded). Resolving live keeps the value in sync
   * with auth-state changes (login/logout, token refresh that surfaces a new
   * account uuid) without needing to re-call `#syncAgentSessionId()` on every
   * such event.
   */
  /** 同步 Agent 会话 ID 并安装动态元数据解析器，使每个 API 请求携带正确的会话归属信息 */
  #syncAgentSessionId(sessionId?: string): void {
    const sid = this.#providerSessionId ?? sessionId ?? this.sessionManager.getSessionId()
    this.agent.sessionId = sid
    this.agent.setMetadataResolver((provider: string) =>
      buildSessionMetadata(sid, provider, this.#modelRegistry.authStorage),
    )
  }

  /** 为当前会话 ID 重新映射 Hindsight 记忆键 */
  #rekeyHindsightMemoryForCurrentSessionId(): void {
    if (resolveMemoryBackend(this.settings).id !== "hindsight") return
    const sid = this.agent.sessionId
    if (!sid) return
    this.getHindsightSessionState()?.setSessionId(sid)
  }

  /** New session file: reset auto-recall / retain-threshold counters for the new transcript. */
  /** 新会话文件：重置 Hindsight 的自动召回/保留阈值计数器 */
  #resetHindsightConversationTrackingIfHindsight(): void {
    if (resolveMemoryBackend(this.settings).id !== "hindsight") return
    const state = this.getHindsightSessionState()
    if (!state || state.aliasOf) return
    state.resetConversationTracking()
  }

  /**
   * Remove all listeners, flush pending writes, and disconnect from agent.
   * Call this when completely done with the session.
   */
  /** 彻底销毁会话：清理监听器、刷出待写入数据、断开 Agent 连接并释放所有资源 */
  async dispose(): Promise<void> {
    this.#isDisposed = true
    this.#pendingBackgroundExchanges = []
    this.#evalExecutionDisposing = true
    try {
      if (this.#extensionRunner?.hasHandlers("session_shutdown")) {
        await this.#extensionRunner.emit({ type: "session_shutdown" })
      }
    } catch (error) {
      logger.warn("Failed to emit session_shutdown event", { error: String(error) })
    }
    await this.#cancelPostPromptTasks()
    this.#clearTodoClearTimers()
    // Cancel jobs this agent registered so a subagent's teardown doesn't
    // leak its background bash/task work into the parent's manager. Only
    // the session that owns the manager goes on to dispose it (which itself
    // nukes any leftover jobs and pending deliveries).
    this.#cancelOwnAsyncJobs()
    const ownedAsyncManager = this.#ownedAsyncJobManager
    if (ownedAsyncManager) {
      const drained = await ownedAsyncManager.dispose({ timeoutMs: 3_000 })
      const deliveryState = ownedAsyncManager.getDeliveryState()
      if (drained === false && deliveryState) {
        logger.warn("Async job completion deliveries still pending during dispose", { ...deliveryState })
      }
      if (AsyncJobManager.instance() === ownedAsyncManager) {
        AsyncJobManager.setInstance(undefined)
      }
    }
    const pythonExecutionsSettled = await this.#prepareEvalExecutionsForDispose()
    if (!pythonExecutionsSettled) {
      logger.warn("Detaching retained Python kernel ownership during dispose while Python execution is still active")
    }
    await disposeKernelSessionsByOwner(this.#evalKernelOwnerId)
    this.#releasePowerAssertion()
    await this.sessionManager.close()
    this.#closeAllProviderSessions("dispose")
    const hindsightState = this.setHindsightSessionState(undefined)
    await hindsightState?.flushRetainQueue()
    hindsightState?.dispose()
    this.#disconnectFromAgent()
    this.#eventListeners = []
  }

  /** 关闭所有提供商会话状态并清空 Map */
  #closeAllProviderSessions(reason: string): void {
    for (const [providerKey, state] of this.#providerSessionState) {
      try {
        state.close()
      } catch (error) {
        logger.warn("Failed to close provider session state", {
          providerKey,
          reason,
          error: String(error),
        })
      }
    }

    this.#providerSessionState.clear()
  }

  // =========================================================================
  // Read-only State Access
  // =========================================================================

  /** 完整的 Agent 状态（消息、工具、流式标志等） */
  get state(): AgentState {
    return this.agent.state
  }

  /** 当前模型（尚未选择时为 undefined） */
  get model(): Model | undefined {
    return this.agent.state.model
  }

  /** 当前思维等级 */
  get thinkingLevel(): ThinkingLevel | undefined {
    return this.#thinkingLevel
  }

  /** 当前服务层级（如 fast/standard） */
  get serviceTier(): ServiceTier | undefined {
    return this.agent.serviceTier
  }

  /** Agent 是否正在流式传输响应（含 InFlight prompt） */
  get isStreaming(): boolean {
    return this.agent.state.isStreaming || this.#promptInFlightCount > 0
  }

  /** 等待流式传输和所有延迟恢复工作完全结束 */
  async waitForIdle(): Promise<void> {
    await this.agent.waitForIdle()
    await this.#waitForPostPromptRecovery()
  }

  /** 为 ACP 排空异步作业交付队列，临时允许 Agent 发起回合 */
  async drainAsyncJobDeliveriesForAcp(options?: { timeoutMs?: number }): Promise<boolean> {
    const manager = AsyncJobManager.instance()
    if (!manager) return false
    const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined
    const before = manager.getDeliveryState(ownerFilter)
    if (before.queued === 0 && !before.delivering) return false
    const previousAllowAcpAgentInitiatedTurns = this.#allowAcpAgentInitiatedTurns
    this.#allowAcpAgentInitiatedTurns = true
    try {
      const drained = await manager.drainDeliveries({ timeoutMs: options?.timeoutMs, filter: ownerFilter })
      const after = manager.getDeliveryState(ownerFilter)
      return drained && (before.queued !== after.queued || before.delivering !== after.delivering)
    } finally {
      this.#allowAcpAgentInitiatedTurns = previousAllowAcpAgentInitiatedTurns
    }
  }

  /** 获取 Agent 状态中最近的助手消息 */
  getLastAssistantMessage(): AssistantMessage | undefined {
    return this.#findLastAssistantMessage()
  }
  /** 当前有效的系统提示块（含每回合扩展修改） */
  get systemPrompt(): string[] {
    return this.agent.state.systemPrompt
  }

  /** 当前重试次数（未重试时为 0） */
  get retryAttempt(): number {
    return this.#retryAttempt
  }

  /** 从工具注册表收集可发现的 MCP 工具 */
  #collectDiscoverableMCPToolsFromRegistry(): Map<string, DiscoverableMCPTool> {
    return new Map(collectDiscoverableMCPTools(this.#toolRegistry.values()).map((tool) => [tool.name, tool] as const))
  }

  /** 设置可发现 MCP 工具并使发现缓存失效 */
  #setDiscoverableMCPTools(discoverableMCPTools: Map<string, DiscoverableMCPTool>): void {
    this.#discoverableMCPTools = discoverableMCPTools
    this.#invalidateDiscoveryCaches()
  }

  /** 统一发现缓存失效入口，任何影响可发现工具集的变更后均应调用 */
  #invalidateDiscoveryCaches(): void {
    this.#discoverableMCPSearchIndex = null
    this.#discoverableToolSearchIndex = null
  }

  /** 过滤可选择的 MCP 工具名（同时在可发现工具集和注册表中存在） */
  #filterSelectableMCPToolNames(toolNames: Iterable<string>): string[] {
    return Array.from(toolNames).filter((name) => this.#discoverableMCPTools.has(name) && this.#toolRegistry.has(name))
  }

  /** 获取配置中默认选中的 MCP 工具名列表 */
  #getConfiguredDefaultSelectedMCPToolNames(): string[] {
    return this.#filterSelectableMCPToolNames([
      ...this.#defaultSelectedMCPToolNames,
      ...selectDiscoverableMCPToolNamesByServer(
        this.#discoverableMCPTools.values(),
        this.#defaultSelectedMCPServerNames,
      ),
    ])
  }

  /** 裁剪已选中的 MCP 工具名，移除不再可选的工具 */
  #pruneSelectedMCPToolNames(): void {
    this.#selectedMCPToolNames = new Set(this.#filterSelectableMCPToolNames(this.#selectedMCPToolNames))
  }

  /** 比较两组已选中的 MCP 工具名是否完全一致 */
  #selectedMCPToolNamesMatch(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((name, index) => name === right[index])
  }

  /** 记录指定会话文件的默认选中 MCP 工具名，用于跨会话恢复 */
  #rememberSessionDefaultSelectedMCPToolNames(
    sessionFile: string | null | undefined,
    toolNames: Iterable<string>,
  ): void {
    if (!sessionFile) return
    this.#sessionDefaultSelectedMCPToolNames.set(
      path.resolve(sessionFile),
      this.#filterSelectableMCPToolNames(toolNames),
    )
  }

  /** 获取指定会话文件的默认选中 MCP 工具名 */
  #getSessionDefaultSelectedMCPToolNames(sessionFile: string | null | undefined): string[] {
    if (!sessionFile) return []
    return this.#sessionDefaultSelectedMCPToolNames.get(path.resolve(sessionFile)) ?? []
  }

  /** 若已选中的 MCP 工具名发生变化则持久化到会话文件 */
  #persistSelectedMCPToolNamesIfChanged(previousSelectedMCPToolNames: string[]): void {
    if (!this.#mcpDiscoveryEnabled) return
    const nextSelectedMCPToolNames = this.getSelectedMCPToolNames()
    if (this.#selectedMCPToolNamesMatch(previousSelectedMCPToolNames, nextSelectedMCPToolNames)) {
      return
    }
    this.sessionManager.appendMCPToolSelection(nextSelectedMCPToolNames)
  }

  /** 获取当前活跃的非 MCP 工具名列表 */
  #getActiveNonMCPToolNames(): string[] {
    return this.getActiveToolNames().filter((name) => !isMCPToolName(name) && this.#toolRegistry.has(name))
  }

  /**
   * Get the names of currently active tools.
   * Returns the names of tools currently set on the agent.
   */
  /** 获取当前活跃工具集的名称列表 */
  getActiveToolNames(): string[] {
    return this.agent.state.tools.map((t) => t.name)
  }

  /** Whether the edit tool is registered in this session. */
  /** 判断当前会话是否注册了 edit 工具 */
  get hasEditTool(): boolean {
    return this.#toolRegistry.has("edit")
  }

  /**
   * Get a tool by name from the registry.
   */
  /** 从工具注册表按名称获取工具 */
  getToolByName(name: string): AgentTool | undefined {
    return this.#toolRegistry.get(name)
  }

  /**
   * Get all configured tool names (built-in via --tools or default, plus custom tools).
   */
  /** 获取所有已配置的工具名（内置、--tools 标志、自定义） */
  getAllToolNames(): string[] {
    return Array.from(this.#toolRegistry.keys())
  }

  /** 获取用于 edit 模式决策的会话上下文（模型字符串 + 设置） */
  #getEditModeSession() {
    return {
      settings: this.settings,
      getActiveModelString: () => (this.model ? formatModelString(this.model) : undefined),
    } as const
  }

  /** 解析当前活跃的编辑模式 */
  #resolveActiveEditMode(): EditMode {
    return resolveEditMode(this.#getEditModeSession())
  }

  /** 模型切换后同步 edit 工具模式，若模式变更则刷新基础系统提示 */
  async #syncEditToolModeAfterModelChange(previousEditMode: EditMode): Promise<void> {
    const currentEditMode = this.#resolveActiveEditMode()
    if (previousEditMode !== currentEditMode && this.getActiveToolNames().includes("edit")) {
      await this.refreshBaseSystemPrompt()
    }
  }

  /** 是否启用 MCP 工具发现模式 */
  isMCPDiscoveryEnabled(): boolean {
    return this.#mcpDiscoveryEnabled
  }

  /** 获取可发现 MCP 工具列表（遗留 description 形状，请改用 getDiscoverableTools） */
  /** @deprecated Use {@link getDiscoverableTools} with `{ source: "mcp" }` instead.
   *  Preserves the legacy `description`-bearing MCP shape for back-compat callers. */
  getDiscoverableMCPTools(): DiscoverableMCPTool[] {
    return Array.from(this.#discoverableMCPTools.values()).map((t) => ({
      name: t.name,
      label: t.label,
      description: t.description,
      serverName: t.serverName,
      mcpToolName: t.mcpToolName,
      schemaKeys: t.schemaKeys,
    }))
  }

  /** 获取可发现 MCP 搜索索引（遗留索引，请改用 getDiscoverableToolSearchIndex） */
  /** @deprecated Use {@link getDiscoverableToolSearchIndex} instead.
   *  Returns the legacy MCP search index whose documents expose `tool.description`. */
  getDiscoverableMCPSearchIndex(): DiscoverableMCPSearchIndex {
    if (!this.#discoverableMCPSearchIndex) {
      this.#discoverableMCPSearchIndex = buildDiscoverableMCPSearchIndex(this.#discoverableMCPTools.values())
    }
    return this.#discoverableMCPSearchIndex
  }

  /** 获取已选中的 MCP 工具名列表 */
  getSelectedMCPToolNames(): string[] {
    if (!this.#mcpDiscoveryEnabled) {
      return this.getActiveToolNames().filter((name) => isMCPToolName(name) && this.#toolRegistry.has(name))
    }
    return this.#filterSelectableMCPToolNames(this.#selectedMCPToolNames)
  }

  /** 激活发现的 MCP 工具并更新活跃工具集 */
  async activateDiscoveredMCPTools(toolNames: string[]): Promise<string[]> {
    const nextSelectedMCPToolNames = new Set(this.#selectedMCPToolNames)
    const activated: string[] = []
    for (const name of toolNames) {
      if (!isMCPToolName(name) || !this.#discoverableMCPTools.has(name) || !this.#toolRegistry.has(name)) {
        continue
      }
      nextSelectedMCPToolNames.add(name)
      activated.push(name)
    }
    if (activated.length === 0) {
      return []
    }
    const nextActive = [
      ...this.#getActiveNonMCPToolNames(),
      ...this.#filterSelectableMCPToolNames(nextSelectedMCPToolNames),
    ]
    await this.setActiveToolsByName(nextActive)
    return [...new Set(activated)]
  }

  // ── Generic tool discovery (covers built-in + MCP + extension) ────────────

  /** Resolve effective discovery mode: tools.discoveryMode wins; mcp.discoveryMode is back-compat alias. */
  /** 解析有效的工具发现模式（tools.discoveryMode 优先，mcp.discoveryMode 为向后兼容别名） */
  #resolveEffectiveDiscoveryMode(): "off" | "mcp-only" | "all" {
    const toolsMode = this.settings.get("tools.discoveryMode")
    if (toolsMode !== "off") return toolsMode as "off" | "mcp-only" | "all"
    if (this.settings.get("mcp.discoveryMode")) return "mcp-only"
    return "off"
  }

  /** 判断是否启用了工具发现（非 "off" 模式） */
  isToolDiscoveryEnabled(): boolean {
    return this.#resolveEffectiveDiscoveryMode() !== "off"
  }

  /** 获取可发现的工具列表，支持按来源过滤（mcp / builtin） */
  getDiscoverableTools(filter?: { source?: DiscoverableTool["source"] }): DiscoverableTool[] {
    // For "all" mode we combine built-in registry entries + MCP tools.
    // For "mcp-only" mode we only return MCP tools.
    const mode = this.#resolveEffectiveDiscoveryMode()
    const activeNames = new Set(this.getActiveToolNames())
    const mcpTools: DiscoverableTool[] = Array.from(this.#discoverableMCPTools.values())
      .filter((t) => !activeNames.has(t.name))
      .map((t) => ({
        name: t.name,
        label: t.label,
        summary: t.description,
        source: "mcp" as const,
        serverName: t.serverName,
        mcpToolName: t.mcpToolName,
        schemaKeys: t.schemaKeys,
      }))
    const builtinTools: DiscoverableTool[] = mode === "all" ? this.#collectDiscoverableBuiltinTools() : []
    const allTools = [...builtinTools, ...mcpTools]
    return filter?.source ? allTools.filter((t) => t.source === filter.source) : allTools
  }

  /** Collect built-in tools the model can discover via search_tool_bm25. Restricted to tool
   *  definitions whose `loadMode === "discoverable"`. This keeps hidden/internal tools
   *  (resolve, yield, report_finding, report_tool_issue) out of the index
   *  and avoids mislabeling extension/custom default-inactive tools as built-ins. */
  /** 收集可供模型发现的内置工具（仅 loadMode === "discoverable"），隐藏内部工具不纳入索引 */
  #collectDiscoverableBuiltinTools(): DiscoverableTool[] {
    const activeNames = new Set(this.getActiveToolNames())
    const result: DiscoverableTool[] = []
    for (const tool of this.#toolRegistry.values()) {
      if (tool.loadMode !== "discoverable") continue
      if (activeNames.has(tool.name)) continue
      const collected = collectDiscoverableTools([tool], { source: "builtin" })
      result.push(...collected)
    }
    return result
  }

  /** 获取通用工具发现搜索索引（延迟构建，缓存复用） */
  getDiscoverableToolSearchIndex(): DiscoverableToolSearchIndex {
    if (!this.#discoverableToolSearchIndex) {
      this.#discoverableToolSearchIndex = buildDiscoverableToolSearchIndex(this.getDiscoverableTools())
    }
    return this.#discoverableToolSearchIndex
  }

  /** Invalidate the generic search index cache (call after tool set changes).
   *  Delegates to {@link #invalidateDiscoveryCaches} so all discovery-related caches stay in sync. */
  /** 使通用工具发现搜索索引缓存失效，委托给 #invalidateDiscoveryCaches */
  #invalidateDiscoverableToolSearchIndex(): void {
    this.#invalidateDiscoveryCaches()
  }

  /** 获取已选中的可发现工具名集合（MCP 选中 + 非 MCP 当前活跃选中的并集） */
  getSelectedDiscoveredToolNames(): string[] {
    // Union of MCP-selected and generic non-MCP selected. Non-MCP selections are only
    // selected while they are still active; otherwise BM25 must be able to rediscover them.
    const activeNames = new Set(this.getActiveToolNames())
    const mcpSelected = this.getSelectedMCPToolNames()
    const nonMcpSelected = Array.from(this.#selectedDiscoveredToolNames).filter(
      (name) => activeNames.has(name) && this.#toolRegistry.has(name) && !isMCPToolName(name),
    )
    return [...new Set([...mcpSelected, ...nonMcpSelected])]
  }

  /** 激活发现的工具（MCP + 非 MCP），更新活跃工具集并刷新搜索索引 */
  async activateDiscoveredTools(toolNames: string[]): Promise<string[]> {
    const mcpNames = toolNames.filter(isMCPToolName)
    const nonMcpNames = toolNames.filter((name) => !isMCPToolName(name))
    const activated: string[] = []

    // Activate MCP tools via existing path
    if (mcpNames.length > 0) {
      const activatedMcp = await this.activateDiscoveredMCPTools(mcpNames)
      activated.push(...activatedMcp)
    }

    // Activate non-MCP tools (built-ins that are in the registry but not currently active)
    if (nonMcpNames.length > 0) {
      const currentActiveNames = new Set(this.getActiveToolNames())
      const newlyAdded: string[] = []
      for (const name of nonMcpNames) {
        if (this.#toolRegistry.has(name) && !currentActiveNames.has(name)) {
          newlyAdded.push(name)
          this.#selectedDiscoveredToolNames.add(name)
          activated.push(name)
        }
      }
      if (newlyAdded.length > 0) {
        const nextActive = [...this.getActiveToolNames(), ...newlyAdded]
        await this.setActiveToolsByName(nextActive)
        this.#invalidateDiscoverableToolSearchIndex()
      }
    }

    return [...new Set(activated)]
  }

  /**
   * Wrap a tool with a permission-gate proxy when an ACP client is connected.
   * Only wraps tools whose name is in PERMISSION_REQUIRED_TOOLS and only when
   * the bridge exposes `requestPermission`. No-ops for all other cases.
   */
  /** 为 ACP 客户端连接时的受保护工具包装权限拦截代理 */
  #wrapToolForAcpPermission<T extends AgentTool>(tool: T): T {
    const bridge = this.#clientBridge
    // Match the capability+method gating pattern used by read/write/bash.
    if (!bridge?.capabilities.requestPermission || !bridge.requestPermission) return tool
    if (!PERMISSION_REQUIRED_TOOLS.has(tool.name)) return tool
    return new Proxy(tool, {
      get: (target, prop) => {
        if (prop !== "execute") return Reflect.get(target, prop, target)
        return async (
          toolCallId: string,
          args: unknown,
          signal: AbortSignal | undefined,
          onUpdate: never,
          ctx: never,
        ) => {
          const permissionIntent = getPermissionIntent(target.name, args)
          if (!permissionIntent) {
            return await target.execute(toolCallId, args as never, signal, onUpdate, ctx)
          }
          // Short-circuit on persisted decisions.
          const persisted = this.#acpPermissionDecisions.get(permissionIntent.cacheKey)
          if (persisted === "allow_always") {
            return await target.execute(toolCallId, args as never, signal, onUpdate, ctx)
          }
          if (persisted === "reject_always") {
            throw new ToolError(`Tool call rejected by user (preference)`)
          }
          if (signal?.aborted) {
            throw new ToolAbortError("Permission request cancelled")
          }
          type PermissionRaceResult =
            | { kind: "permission"; outcome: ClientBridgePermissionOutcome }
            | { kind: "aborted" }
          const { promise: abortPromise, resolve: resolveAbort } = Promise.withResolvers<PermissionRaceResult>()
          const onAbort = () => resolveAbort({ kind: "aborted" })
          signal?.addEventListener("abort", onAbort, { once: true })
          let raced: PermissionRaceResult
          try {
            const permissionPromise = bridge.requestPermission!(
              {
                toolCallId,
                toolName: target.name,
                title: permissionIntent.title,
                status: "pending",
                rawInput: args,
                locations: extractPermissionLocations(args, this.sessionManager.getCwd(), permissionIntent.paths),
              },
              PERMISSION_OPTIONS,
              signal,
            ).then((outcome) => ({ kind: "permission" as const, outcome }))
            raced = await Promise.race([permissionPromise, abortPromise])
          } finally {
            signal?.removeEventListener("abort", onAbort)
          }
          if (raced.kind === "aborted" || signal?.aborted) {
            throw new ToolAbortError("Permission request cancelled")
          }
          const outcome = raced.outcome
          if (outcome.outcome === "cancelled") {
            throw new ToolAbortError("Permission request cancelled")
          }
          const selectedOption = PERMISSION_OPTIONS_BY_ID.get(outcome.optionId)
          if (!selectedOption) {
            throw new ToolError(`Tool permission response used unknown option ID: ${outcome.optionId}`)
          }
          if (selectedOption.kind === "allow_always") {
            this.#acpPermissionDecisions.set(permissionIntent.cacheKey, "allow_always")
          } else if (selectedOption.kind === "reject_always") {
            this.#acpPermissionDecisions.set(permissionIntent.cacheKey, "reject_always")
          }
          if (selectedOption.kind === "reject_once" || selectedOption.kind === "reject_always") {
            throw new ToolError(`Tool call rejected by user (${target.name})`)
          }
          return await target.execute(toolCallId, args as never, signal, onUpdate, ctx)
        }
      },
    }) as T
  }

  /** 核心工具集应用：验证并去重工具名，设置 Agent 工具集，失效发现缓存，重建系统提示 */
  async #applyActiveToolsByName(
    toolNames: string[],
    options?: { persistMCPSelection?: boolean; previousSelectedMCPToolNames?: string[] },
  ): Promise<void> {
    toolNames = [...new Set(toolNames.map((name) => name.toLowerCase()))]
    const previousSelectedMCPToolNames = options?.previousSelectedMCPToolNames ?? this.getSelectedMCPToolNames()
    const tools: AgentTool[] = []
    const validToolNames: string[] = []
    for (const name of toolNames) {
      const tool = this.#toolRegistry.get(name)
      if (tool) {
        tools.push(this.#wrapToolForAcpPermission(tool))
        validToolNames.push(name)
      }
    }
    // Auto-QA tool must survive any runtime tool-set mutation.
    if (isAutoQaEnabled(this.settings) && !validToolNames.includes("report_tool_issue")) {
      const qaTool = this.#toolRegistry.get("report_tool_issue")
      if (qaTool) {
        tools.push(this.#wrapToolForAcpPermission(qaTool))
        validToolNames.push("report_tool_issue")
      }
    }
    if (this.#mcpDiscoveryEnabled) {
      this.#selectedMCPToolNames = new Set(
        validToolNames.filter(
          (name) => isMCPToolName(name) && this.#discoverableMCPTools.has(name) && this.#toolRegistry.has(name),
        ),
      )
    }
    const activeNameSet = new Set(validToolNames)
    for (const name of Array.from(this.#selectedDiscoveredToolNames)) {
      if (!activeNameSet.has(name) || isMCPToolName(name) || !this.#toolRegistry.has(name)) {
        this.#selectedDiscoveredToolNames.delete(name)
      }
    }
    this.agent.setTools(tools)

    // Active tool set changed → discoverable tool list (which excludes already-active tools)
    // is now stale. Invalidate before any prompt-template hook reads the discovery list.
    this.#invalidateDiscoveryCaches()

    // Rebuild base system prompt with new tool set, but only when the tool set
    // actually changed. MCP servers can reconnect at arbitrary times and call
    // `refreshMCPTools` -> `#applyActiveToolsByName` even though the resulting
    // tool list is byte-identical. Skipping the rebuild keeps the system prompt
    // stable, which is required for Anthropic prompt caching to keep hitting.
    if (this.#rebuildSystemPrompt) {
      const signature = this.#computeAppliedToolSignature(validToolNames, tools)
      if (signature !== this.#lastAppliedToolSignature) {
        const built = await this.#rebuildSystemPrompt(validToolNames, this.#toolRegistry)
        this.#baseSystemPrompt = built.systemPrompt
        this.agent.setSystemPrompt(this.#baseSystemPrompt)
        this.#lastAppliedToolSignature = signature
      }
    }
    if (options?.persistMCPSelection !== false) {
      this.#persistSelectedMCPToolNamesIfChanged(previousSelectedMCPToolNames)
    }
  }

  /**
   * Reload the SSH tool from disk-backed capability discovery and make the
   * refreshed definition visible to the next model call without restarting.
   */
  /** 重新加载 SSH 工具（来自磁盘能力发现），不重启即可让新定义生效 */
  async refreshSshTool(options?: { activateIfAvailable?: boolean }): Promise<void> {
    resetCapabilities()
    if (!this.#reloadSshTool) return
    const previousSshTool = this.#toolRegistry.get("ssh")
    const previousActiveToolNames = this.getActiveToolNames()
    const hadSshTool = previousSshTool !== undefined
    const wasActive = previousActiveToolNames.includes("ssh")
    const previousHostNames =
      previousSshTool && "hostNames" in previousSshTool && Array.isArray(previousSshTool.hostNames)
        ? [...previousSshTool.hostNames]
        : []
    const candidateHostNames = new Set(previousHostNames)
    const capability = await loadCapability<{ name: string }>("ssh", { cwd: this.sessionManager.getCwd() })
    for (const host of capability.items) {
      if (typeof host?.name === "string") {
        candidateHostNames.add(host.name)
      }
    }
    await invalidateHostMetadata(candidateHostNames)
    const sshAllowed = this.#requestedToolNames === undefined || this.#requestedToolNames.has("ssh")
    const refreshedTool = await this.#reloadSshTool()
    if (refreshedTool) {
      this.#toolRegistry.set(refreshedTool.name, refreshedTool)
    } else {
      this.#toolRegistry.delete("ssh")
      this.#selectedDiscoveredToolNames.delete("ssh")
    }

    const nextActive = previousActiveToolNames.filter((name) => name !== "ssh" && this.#toolRegistry.has(name))
    if (refreshedTool && sshAllowed && (wasActive || (options?.activateIfAvailable && !hadSshTool))) {
      nextActive.push(refreshedTool.name)
    }
    await this.#applyActiveToolsByName(nextActive)
  }

  /**
   * Set active tools by name.
   * Only tools in the registry can be enabled. Unknown tool names are ignored.
   * Also rebuilds the system prompt to reflect the new tool set.
   * Changes take effect before the next model call.
   */
  /** 按名称设置活跃工具集，未知工具名会被忽略，并同步重建系统提示 */
  async setActiveToolsByName(toolNames: string[]): Promise<void> {
    await this.#applyActiveToolsByName(toolNames)
  }

  /** 恢复会话上下文的 MCP 工具选择，优先使用会话持久化的选择，退回到默认配置 */
  async #restoreMCPSelectionsForSessionContext(
    sessionContext: SessionContext,
    options?: { fallbackSelectedMCPToolNames?: Iterable<string> },
  ): Promise<void> {
    if (!this.#mcpDiscoveryEnabled) return
    const nextActiveNonMCPToolNames = this.#getActiveNonMCPToolNames()
    const fallbackSelectedMCPToolNames =
      options?.fallbackSelectedMCPToolNames ?? this.#getConfiguredDefaultSelectedMCPToolNames()
    const restoredMCPToolNames = sessionContext.hasPersistedMCPToolSelection
      ? this.#filterSelectableMCPToolNames(sessionContext.selectedMCPToolNames)
      : this.#filterSelectableMCPToolNames(fallbackSelectedMCPToolNames)
    this.#rememberSessionDefaultSelectedMCPToolNames(this.sessionFile, this.#getConfiguredDefaultSelectedMCPToolNames())
    await this.#applyActiveToolsByName([...nextActiveNonMCPToolNames, ...restoredMCPToolNames], {
      persistMCPSelection: false,
    })
  }
  /** Rebuild the base system prompt using the current active tool set. */
  /** 使用当前活跃工具集重建基础系统提示 */
  async refreshBaseSystemPrompt(): Promise<void> {
    if (!this.#rebuildSystemPrompt) return
    const activeToolNames = this.getActiveToolNames()
    const built = await this.#rebuildSystemPrompt(activeToolNames, this.#toolRegistry)
    this.#baseSystemPrompt = built.systemPrompt
    this.agent.setSystemPrompt(this.#baseSystemPrompt)
    // Refresh the cached signature so a subsequent `#applyActiveToolsByName` with
    // the same tool set does not re-rebuild on top of the explicit refresh we
    // just performed (and conversely, a different set forces a fresh rebuild).
    const activeTools = activeToolNames
      .map((name) => this.#toolRegistry.get(name))
      .filter((tool): tool is AgentTool => tool != null)
    this.#lastAppliedToolSignature = this.#computeAppliedToolSignature(activeToolNames, activeTools)
  }

  /** Agent 启动前构建系统提示，集成记忆后端的 beforeAgentStartPrompt 注入 */
  async #buildSystemPromptForAgentStart(promptText: string): Promise<string[]> {
    const backend = resolveMemoryBackend(this.settings)
    if (!backend.beforeAgentStartPrompt) return this.#baseSystemPrompt

    try {
      const injected = await backend.beforeAgentStartPrompt(this, promptText)
      if (!injected) return this.#baseSystemPrompt
      return [...this.#baseSystemPrompt, injected]
    } catch (err) {
      logger.debug("Memory backend beforeAgentStartPrompt failed", {
        backend: backend.id,
        error: String(err),
      })
      return this.#baseSystemPrompt
    }
  }

  /**
   * 计算活跃工具签名，用于跳过重复的 rebuildSystemPrompt（签名相同则提示字节相同）。
   * @内部 计算活跃工具签名，用于跳过重复系统提示重建
   *
   * The signature covers:
   *   1. Active tool names in order (the prompt renders them in this order).
   *   2. Active tool labels, descriptions, and wire-visible names — all are
   *      rendered into the prompt body (see `system-prompt.md` `{{label}}: \`{{name}}\``
   *      and `toolPromptNames` in `buildSystemPrompt`). The wire name comes from
   *      `tool.customWireName` and overrides the internal name on the model wire
   *      (e.g. `edit` exposes itself as `apply_patch` to GPT-5 in apply_patch mode);
   *      a stale wire name would desync prompt guidance from actual tool routing.
   *   3. When MCP discovery is on, every registry tool's name+label+description+
   *      customWireName, since `rebuildSystemPrompt` summarizes discoverable MCP
   *      tools that are not in the active set.
   *   4. MCP server instructions text (per server), since `rebuildSystemPrompt`
   *      embeds these in the appended prompt under "## MCP Server Instructions".
   *      A server upgrade can change instructions while keeping tools identical.
   *
   * Settings-driven tool metadata is covered automatically: built-in tools that
   * depend on settings expose `description`/`label` via getters (see `TaskTool`,
   * `SearchToolBm25Tool`, `EditTool`), and the signature reads them live on every
   * call - so a settings flip that mutates the rendered string differs the signature
   * the next time `#applyActiveToolsByName` runs. Do not refactor `describeTool` to
   * cache per-tool strings without preserving this property.
   *
   * Inputs NOT covered: tool input schemas; memory instructions read from disk;
   * and SDK-init-time closure constants in `sdk.ts` (`repeatToolDescriptions`,
   * `eagerTasks`, `intentField`, `mcpDiscoveryEnabled`, `secretsEnabled`). The
   * closure-captured ones cannot change at runtime regardless of skip behavior.
   * For everything else, callers must explicitly call `refreshBaseSystemPrompt()`
   * after side-effecting changes; see e.g. the memory hooks and
   * `#syncEditToolModeAfterModelChange`.
   *
   * The current calendar date IS covered (appended as a segment) because
   * `buildSystemPrompt` injects it into the prompt body (`Today is '{{date}}'`).
   * Without this, a session spanning midnight with only tool-stable MCP
   * reconnects would keep yesterday's date indefinitely.
   */
  /** 计算活跃工具签名（工具元数据 + MCP 指令 + 日期），用于跳过重复 rebuildSystemPrompt */
  #computeAppliedToolSignature(toolNames: string[], tools: AgentTool[]): string {
    // Order-preserving join: any reorder must produce a different signature so
    // the rebuild fires and the new tool list reaches the API.
    const nameSegment = toolNames.join("\u0001")
    const describeTool = (tool: AgentTool): string =>
      `${tool.name}=${tool.label ?? ""}|${tool.description ?? ""}|${tool.customWireName ?? ""}`
    const descriptionSegment = tools.map(describeTool).join("\u0002")
    let registrySegment = ""
    if (this.#mcpDiscoveryEnabled) {
      // Registry iteration order is not load-bearing for the prompt content, so we
      // sort to keep the signature insensitive to incidental insertion order.
      const entries: string[] = []
      for (const tool of this.#toolRegistry.values()) {
        entries.push(describeTool(tool))
      }
      entries.sort()
      registrySegment = entries.join("\u0004")
    }
    let instructionsSegment = ""
    const serverInstructions = this.#getMcpServerInstructions?.()
    if (serverInstructions && serverInstructions.size > 0) {
      // Sort by server name so transport flap order does not perturb the signature.
      const entries: string[] = []
      for (const [server, instructions] of serverInstructions) {
        entries.push(`${server}=${instructions}`)
      }
      entries.sort()
      instructionsSegment = entries.join("\u0006")
    }
    const date = new Date().toISOString().slice(0, 10)
    return `${nameSegment}\u0003${descriptionSegment}\u0005${registrySegment}\u0007${instructionsSegment}|${date}`
  }

  /**
   * Replace MCP tools in the registry and recompute the visible MCP tool set immediately.
   * This allows /mcp add/remove/reauth to take effect without restarting the session.
   */
  /** 替换 MCP 工具注册表并立即刷新活跃工具集，无需重启会话 */
  async refreshMCPTools(mcpTools: CustomTool[]): Promise<void> {
    const previousSelectedMCPToolNames = this.getSelectedMCPToolNames()
    const existingNames = Array.from(this.#toolRegistry.keys())
    for (const name of existingNames) {
      if (isMCPToolName(name)) {
        this.#toolRegistry.delete(name)
      }
    }

    const getCustomToolContext = (): CustomToolContext => ({
      sessionManager: this.sessionManager,
      modelRegistry: this.#modelRegistry,
      model: this.model,
      isIdle: () => !this.isStreaming,
      hasQueuedMessages: () => this.queuedMessageCount > 0,
      abort: () => {
        this.agent.abort()
      },
    })

    for (const customTool of mcpTools) {
      const wrapped = CustomToolAdapter.wrap(customTool, getCustomToolContext) as AgentTool
      const finalTool = (
        this.#extensionRunner ? new ExtensionToolWrapper(wrapped, this.#extensionRunner) : wrapped
      ) as AgentTool
      this.#toolRegistry.set(finalTool.name, finalTool)
    }

    this.#setDiscoverableMCPTools(this.#collectDiscoverableMCPToolsFromRegistry())
    this.#pruneSelectedMCPToolNames()
    if (!this.buildDisplaySessionContext().hasPersistedMCPToolSelection) {
      this.#selectedMCPToolNames = new Set([
        ...this.#selectedMCPToolNames,
        ...this.#getConfiguredDefaultSelectedMCPToolNames(),
      ])
    }
    this.#rememberSessionDefaultSelectedMCPToolNames(this.sessionFile, this.#getConfiguredDefaultSelectedMCPToolNames())

    const nextActive = [...this.#getActiveNonMCPToolNames(), ...this.getSelectedMCPToolNames()]
    await this.#applyActiveToolsByName(nextActive, { previousSelectedMCPToolNames })
  }

  /**
   * Replace RPC host-owned tools and refresh the active tool set before the next model call.
   */
  /** 替换 RPC 宿主工具并刷新活跃工具集 */
  async refreshRpcHostTools(rpcTools: AgentTool[]): Promise<void> {
    const nextToolNames = rpcTools.map((tool) => tool.name)
    const uniqueToolNames = new Set(nextToolNames)
    if (uniqueToolNames.size !== nextToolNames.length) {
      throw new Error("RPC host tool names must be unique")
    }

    for (const name of uniqueToolNames) {
      if (this.#toolRegistry.has(name) && !this.#rpcHostToolNames.has(name)) {
        throw new Error(`RPC host tool "${name}" conflicts with an existing tool`)
      }
    }

    const previousRpcHostToolNames = new Set(this.#rpcHostToolNames)
    const previousActiveToolNames = this.getActiveToolNames()
    for (const name of previousRpcHostToolNames) {
      this.#toolRegistry.delete(name)
    }
    this.#rpcHostToolNames.clear()

    for (const tool of rpcTools) {
      const finalTool = (
        this.#extensionRunner ? new ExtensionToolWrapper(tool, this.#extensionRunner) : tool
      ) as AgentTool
      this.#toolRegistry.set(finalTool.name, finalTool)
      this.#rpcHostToolNames.add(finalTool.name)
    }

    // Registry contents changed — invalidate discovery caches so the next BM25 lookup sees
    // the new RPC-host tool set. (#applyActiveToolsByName below also invalidates, but doing
    // it here too keeps the contract local to "registry mutated".)
    this.#invalidateDiscoveryCaches()

    const activeNonRpcToolNames = previousActiveToolNames.filter((name) => !previousRpcHostToolNames.has(name))
    const preservedRpcToolNames = previousActiveToolNames.filter(
      (name) => previousRpcHostToolNames.has(name) && this.#rpcHostToolNames.has(name),
    )
    const autoActivatedRpcToolNames = rpcTools
      .filter((tool) => !tool.hidden && !previousRpcHostToolNames.has(tool.name))
      .map((tool) => tool.name)
    await this.#applyActiveToolsByName(
      Array.from(new Set([...activeNonRpcToolNames, ...preservedRpcToolNames, ...autoActivatedRpcToolNames])),
    )
  }

  /** Whether auto-compaction is currently running */
  /** 自动压缩是否正在运行 */
  get isCompacting(): boolean {
    return this.#autoCompactionAbortController !== undefined || this.#compactionAbortController !== undefined
  }

  /** All messages including custom types like BashExecutionMessage */
  /** 所有消息（含 BashExecutionMessage 等自定义类型） */
  get messages(): AgentMessage[] {
    return this.agent.state.messages
  }

  /** 构建用于显示的会话上下文（含去混淆处理） */
  buildDisplaySessionContext(): SessionContext {
    return deobfuscateSessionContext(this.sessionManager.buildSessionContext(), this.#obfuscator)
  }

  /** Convert session messages using the same pre-LLM pipeline as the active session. */
  /** 使用与活跃会话相同的预 LLM 管线转换会话消息为 LLM 格式 */
  async convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]> {
    const transformedMessages = await this.#transformContext(messages, signal)
    return await this.#convertToLlm(transformedMessages)
  }

  /** Apply session-level stream hooks to a direct side request. */
  /** 将会话级流钩子应用到直接侧信道请求（合并 payload/response/SSE 拦截器） */
  prepareSimpleStreamOptions(options: SimpleStreamOptions, provider = "anthropic"): SimpleStreamOptions {
    const sessionOnPayload = this.#onPayload
    const sessionOnResponse = this.#onResponse
    const sessionMetadata = this.agent.metadataForProvider(provider)
    const sessionOnSseEvent = this.#onSseEvent
    if (!sessionOnPayload && !sessionOnResponse && !sessionMetadata && !sessionOnSseEvent) return options

    const preparedOptions: SimpleStreamOptions = { ...options }

    // Stamp session metadata (e.g. user_id={session_id}) onto direct-call requests so
    // they share the same session bucket as Agent.prompt-routed requests on Anthropic
    // OAuth. Caller-provided metadata wins so explicit overrides are respected.
    if (sessionMetadata && !options.metadata) {
      preparedOptions.metadata = sessionMetadata
    }

    if (sessionOnPayload) {
      if (!options.onPayload) {
        preparedOptions.onPayload = sessionOnPayload
      } else {
        const requestOnPayload = options.onPayload
        preparedOptions.onPayload = async (payload, model) => {
          const sessionPayload = await sessionOnPayload(payload, model)
          const sessionResolvedPayload = sessionPayload ?? payload
          const requestPayload = await requestOnPayload(sessionResolvedPayload, model)
          return requestPayload ?? sessionResolvedPayload
        }
      }
    }

    if (sessionOnResponse) {
      if (!options.onResponse) {
        preparedOptions.onResponse = sessionOnResponse
      } else {
        const requestOnResponse = options.onResponse
        preparedOptions.onResponse = async (response, model) => {
          await sessionOnResponse(response, model)
          await requestOnResponse(response, model)
        }
      }
    }

    if (sessionOnSseEvent) {
      if (!options.onSseEvent) {
        preparedOptions.onSseEvent = sessionOnSseEvent
      } else {
        const requestOnSseEvent = options.onSseEvent
        preparedOptions.onSseEvent = (event, model) => {
          sessionOnSseEvent(event, model)
          requestOnSseEvent(event, model)
        }
      }
    }

    return preparedOptions
  }

  /** Current steering mode */
  /** 当前转向模式（"all" 或 "one-at-a-time"） */
  get steeringMode(): "all" | "one-at-a-time" {
    return this.agent.getSteeringMode()
  }

  /** Current follow-up mode */
  /** 当前追加模式（"all" 或 "one-at-a-time"） */
  get followUpMode(): "all" | "one-at-a-time" {
    return this.agent.getFollowUpMode()
  }

  /** Current interrupt mode */
  /** 当前中断模式（"immediate" 或 "wait"） */
  get interruptMode(): "immediate" | "wait" {
    return this.agent.getInterruptMode()
  }

  /** Current session file path, or undefined if sessions are disabled */
  /** 当前会话文件路径（会话禁用时为 undefined） */
  get sessionFile(): string | undefined {
    return this.sessionManager.getSessionFile()
  }

  /** Current session ID */
  /** 当前会话 ID */
  get sessionId(): string {
    return this.#providerSessionId ?? this.sessionManager.getSessionId()
  }

  /** Current session display name, if set */
  /** 当前会话显示名称（未设置时为 undefined） */
  get sessionName(): string | undefined {
    return this.sessionManager.getSessionName()
  }

  /** Scoped models for cycling (from --models flag) */
  /** 限定模型列表（来自 --models 标志，用于 Ctrl+P 循环切换） */
  get scopedModels(): ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }> {
    return this.#scopedModels
  }

  /** 获取 Plan 模式状态 */
  getPlanModeState(): PlanModeState | undefined {
    return this.#planModeState
  }

  /** 设置 Plan 模式状态，启用时重置引用发送标志和路径 */
  setPlanModeState(state: PlanModeState | undefined): void {
    this.#planModeState = state
    if (state?.enabled) {
      this.#planReferenceSent = false
      this.#planReferencePath = state.planFilePath
    }
  }

  /** 获取 Goal 模式状态 */
  getGoalModeState(): GoalModeState | undefined {
    return this.#goalModeState
  }

  /** 设置 Goal 模式状态 */
  setGoalModeState(state: GoalModeState | undefined): void {
    this.#goalModeState = state
  }

  /** Goal 运行时（管理目标进度和 token 预算） */
  get goalRuntime(): GoalRuntime {
    return this.#goalRuntime
  }

  /** 标记 Plan 引用消息已发送 */
  markPlanReferenceSent(): void {
    this.#planReferenceSent = true
  }

  /** 设置 Plan 引用路径 */
  setPlanReferencePath(path: string): void {
    this.#planReferencePath = path
  }

  /** ACP 客户端桥接实例 */
  get clientBridge(): ClientBridge | undefined {
    return this.#clientBridge
  }

  /** 设置 ACP 客户端桥接，清空权限决策缓存并重新包装工具 */
  setClientBridge(bridge: ClientBridge | undefined): void {
    this.#clientBridge = bridge
    this.#acpPermissionDecisions.clear()
    const activeToolNames = this.getActiveToolNames()
    const activeTools = activeToolNames
      .map((name) => this.#toolRegistry.get(name))
      .filter((tool): tool is AgentTool => tool !== undefined)
      .map((tool) => this.#wrapToolForAcpPermission(tool))
    this.agent.setTools(activeTools)
  }

  /** 获取检查点状态 */
  getCheckpointState(): CheckpointState | undefined {
    return this.#checkpointState
  }

  /** 设置检查点状态，清除时同时清除待处理的 rewind 报告 */
  setCheckpointState(state: CheckpointState | undefined): void {
    this.#checkpointState = state
    if (!state) {
      this.#pendingRewindReport = undefined
    }
  }

  /**
   * Inject the plan mode context message into the conversation history.
   */
  /** 注入 Plan 模式上下文消息到对话历史 */
  async sendPlanModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
    const message = await this.#buildPlanModeMessage()
    if (!message) return
    await this.sendCustomMessage(
      {
        customType: message.customType,
        content: message.content,
        display: message.display,
        details: message.details,
      },
      options ? { deliverAs: options.deliverAs } : undefined,
    )
  }

  /** 注入 Goal 模式上下文消息到对话历史 */
  async sendGoalModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
    const message = this.#buildGoalModeMessage()
    if (!message) return
    await this.sendCustomMessage(
      {
        customType: message.customType,
        content: message.content,
        display: message.display,
        details: message.details,
        attribution: message.attribution,
      },
      options ? { deliverAs: options.deliverAs } : undefined,
    )
  }

  /** 解析角色对应的模型 */
  resolveRoleModel(role: string): Model | undefined {
    return this.#resolveRoleModelFull(role, this.#modelRegistry.getAvailable(), this.model).model
  }

  /**
   * Resolve a role to its model AND thinking level.
   * Unlike resolveRoleModel(), this preserves the thinking level suffix
   * from role configuration (e.g., "anthropic/claude-sonnet-4-5:xhigh").
   */
  /** 解析角色的模型及思维等级（保留角色配置中的思维等级后缀） */
  resolveRoleModelWithThinking(role: string): ResolvedModelRoleValue {
    return this.#resolveRoleModelFull(role, this.#modelRegistry.getAvailable(), this.model)
  }

  /** 文件提示模板列表 */
  get promptTemplates(): ReadonlyArray<PromptTemplate> {
    return this.#promptTemplates
  }

  /** Replace file-based slash commands used for prompt expansion. */
  /** 替换用于提示模板展开的文件斜杠命令列表 */
  setSlashCommands(slashCommands: FileSlashCommand[]): void {
    this.#slashCommands = [...slashCommands]
  }

  /** Custom commands (TypeScript slash commands and MCP prompts) */
  /** 自定义命令列表（TypeScript 斜杠命令 + MCP 提示命令） */
  get customCommands(): ReadonlyArray<LoadedCustomCommand> {
    if (this.#mcpPromptCommands.length === 0) return this.#customCommands
    return [...this.#customCommands, ...this.#mcpPromptCommands]
  }

  /** Update the MCP prompt commands list. Called when server prompts are (re)loaded. */
  /** 更新 MCP 提示命令列表，在服务器提示重新加载时调用 */
  setMCPPromptCommands(commands: LoadedCustomCommand[]): void {
    this.#mcpPromptCommands = commands
  }

  // =========================================================================
  // Prompting
  // =========================================================================

  /**
   * Build a plan mode message.
   * Returns null if plan mode is not enabled.
   * @returns The plan mode message, or null if plan mode is not enabled.
   */
  /** 构建 Plan 引用消息（读取 PLAN 文件并渲染模板） */
  async #buildPlanReferenceMessage(): Promise<CustomMessage | null> {
    if (this.#planModeState?.enabled) return null
    if (this.#planReferenceSent) return null

    const planFilePath = this.#planReferencePath
    const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, this.#localProtocolOptions())
    let planContent: string
    try {
      planContent = await Bun.file(resolvedPlanPath).text()
    } catch (error) {
      if (isEnoent(error)) {
        return null
      }
      throw error
    }

    const content = prompt.render(planModeReferencePrompt, {
      planFilePath,
      planContent,
    })

    this.#planReferenceSent = true

    return {
      role: "custom",
      customType: "plan-mode-reference",
      content,
      display: false,
      attribution: "agent",
      timestamp: Date.now(),
    }
  }

  /** 构建 Plan 模式激活上下文消息 */
  async #buildPlanModeMessage(): Promise<CustomMessage | null> {
    const state = this.#planModeState
    if (!state?.enabled) return null
    const sessionPlanUrl = "local://PLAN.md"
    const resolvedPlanPath = state.planFilePath.startsWith("local:")
      ? resolveLocalUrlToPath(normalizeLocalScheme(state.planFilePath), this.#localProtocolOptions())
      : resolveToCwd(state.planFilePath, this.sessionManager.getCwd())
    const resolvedSessionPlan = resolveLocalUrlToPath(sessionPlanUrl, this.#localProtocolOptions())
    const displayPlanPath =
      state.planFilePath.startsWith("local:") || resolvedPlanPath !== resolvedSessionPlan
        ? state.planFilePath
        : sessionPlanUrl

    const planExists = fs.existsSync(resolvedPlanPath)
    const content = prompt.render(planModeActivePrompt, {
      planFilePath: displayPlanPath,
      planExists,
      askToolName: "ask",
      writeToolName: "write",
      editToolName: "edit",
      reentry: state.reentry ?? false,
      iterative: state.workflow === "iterative",
    })

    return {
      role: "custom",
      customType: "plan-mode-context",
      content,
      display: false,
      attribution: "agent",
      timestamp: Date.now(),
    }
  }

  /** 构建 Goal 模式上下文消息 */
  #buildGoalModeMessage(): CustomMessage | null {
    const content = this.#goalRuntime.buildActivePrompt()
    if (!content) return null
    return {
      role: "custom",
      customType: "goal-mode-context",
      content,
      display: false,
      attribution: "agent",
      timestamp: Date.now(),
    }
  }

  /**
   * Send a prompt to the agent.
   * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
   * - Expands file-based prompt templates by default
   * - During streaming, queues via steer() or followUp() based on streamingBehavior option
   * - Validates model and API key before sending (when not streaming)
   * @throws Error if streaming and no streamingBehavior specified
   * @throws Error if no model selected or no API key available (when not streaming)
   */
  /** 发送提示到 Agent：展开模板、处理斜杠命令，流式时通过 steer/followUp 排队 */
  async prompt(text: string, options?: PromptOptions): Promise<void> {
    const expandPromptTemplates = options?.expandPromptTemplates ?? true

    // Handle extension commands first (execute immediately, even during streaming)
    if (expandPromptTemplates && text.startsWith("/")) {
      const handled = await this.#tryExecuteExtensionCommand(text)
      if (handled) {
        return
      }

      // Try custom commands (TypeScript slash commands)
      const customResult = await this.#tryExecuteCustomCommand(text)
      if (customResult !== null) {
        if (customResult === "") {
          return
        }
        text = customResult
      }

      // Try file-based slash commands (markdown files from commands/ directories)
      // Only if text still starts with "/" (wasn't transformed by custom command)
      if (text.startsWith("/")) {
        text = expandSlashCommand(text, this.#slashCommands)
      }
    }

    // Expand file-based prompt templates if requested
    const expandedText = expandPromptTemplates ? expandPromptTemplate(text, [...this.#promptTemplates]) : text

    // If streaming, queue via steer() or followUp() based on option
    if (this.isStreaming) {
      if (!options?.streamingBehavior) {
        throw new AgentBusyError()
      }
      if (options.streamingBehavior === "followUp") {
        await this.#queueFollowUp(expandedText, options?.images)
      } else {
        await this.#queueSteer(expandedText, options?.images)
      }
      return
    }

    // Skip eager todo prelude when the user has already queued a directive
    const hasPendingUserDirective = this.#toolChoiceQueue.inspect().includes("user-force")
    const eagerTodoPrelude =
      !options?.synthetic && !hasPendingUserDirective ? this.#createEagerTodoPrelude(expandedText) : undefined

    const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }]
    if (options?.images) {
      userContent.push(...options.images)
    }

    const promptAttribution = options?.attribution ?? (options?.synthetic ? "agent" : "user")
    const message = options?.synthetic
      ? { role: "developer" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() }
      : { role: "user" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() }

    if (eagerTodoPrelude) {
      this.#toolChoiceQueue.pushOnce(eagerTodoPrelude.toolChoice, {
        label: "eager-todo",
      })
    }

    try {
      await this.#promptWithMessage(message, expandedText, {
        ...options,
        prependMessages: eagerTodoPrelude ? [eagerTodoPrelude.message] : undefined,
      })
    } finally {
      // Clean up residual eager-todo directive if the prompt never consumed it
      // (e.g., compaction aborted, validation failed).
      this.#toolChoiceQueue.removeByLabel("eager-todo")
    }
    if (!options?.synthetic) {
      await this.#enforcePlanModeToolDecision()
    }
  }

  /** 将自定义消息作为提示发送到 Agent，流式时可按 streamingBehavior 排队 */
  async promptCustomMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
    options?: Pick<PromptOptions, "streamingBehavior" | "toolChoice">,
  ): Promise<void> {
    const textContent =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((content): content is TextContent => content.type === "text")
            .map((content) => content.text)
            .join("")

    if (this.isStreaming) {
      if (!options?.streamingBehavior) {
        throw new AgentBusyError()
      }
      await this.sendCustomMessage(message, { deliverAs: options.streamingBehavior })
      return
    }

    const customMessage: CustomMessage<T> = {
      role: "custom",
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
      attribution: message.attribution ?? "agent",
      timestamp: Date.now(),
    }

    await this.#promptWithMessage(customMessage, textContent, options)
  }

  /** 核心提示管线：校验模型/API Key、压缩检查、注入计划/目标上下文后启动 Agent */
  async #promptWithMessage(
    message: AgentMessage,
    expandedText: string,
    options?: Pick<PromptOptions, "toolChoice" | "images" | "skipCompactionCheck"> & {
      prependMessages?: AgentMessage[]
      skipPostPromptRecoveryWait?: boolean
    },
  ): Promise<void> {
    this.#beginInFlight()
    const generation = this.#promptGeneration
    try {
      // Flush any pending bash messages before the new prompt
      this.#flushPendingBashMessages()
      this.#flushPendingPythonMessages()
      this.#flushPendingBackgroundExchanges()

      // Reset todo reminder count on new user prompt
      this.#todoReminderCount = 0

      await this.#maybeRestoreRetryFallbackPrimary()

      // Validate model
      if (!this.model) {
        throw new Error(
          "No model selected.\n\n" +
            `Use /login, set an API key environment variable, or create ${getAgentDbPath()}\n\n` +
            "Then use /model to select a model.",
        )
      }

      // Validate API key
      const apiKey = await this.#modelRegistry.getApiKey(this.model, this.sessionId)
      if (!apiKey) {
        throw new Error(
          `No API key found for ${this.model.provider}.\n\n` +
            `Use /login, set an API key environment variable, or create ${getAgentDbPath()}`,
        )
      }

      // Check if we need to compact before sending (catches aborted responses)
      const lastAssistant = this.#findLastAssistantMessage()
      if (lastAssistant && !options?.skipCompactionCheck) {
        await this.#checkCompaction(lastAssistant, false)
      }

      // Build messages array (session context, eager todo prelude, then active prompt message)
      const messages: AgentMessage[] = []
      const planReferenceMessage = await this.#buildPlanReferenceMessage?.()
      if (planReferenceMessage) {
        messages.push(planReferenceMessage)
      }
      const planModeMessage = await this.#buildPlanModeMessage()
      if (planModeMessage) {
        messages.push(planModeMessage)
      }
      const goalModeMessage = this.#buildGoalModeMessage()
      if (goalModeMessage) {
        messages.push(goalModeMessage)
      }
      if (options?.prependMessages) {
        messages.push(...options.prependMessages)
      }

      messages.push(message)

      // Early bail-out: if a newer abort/prompt cycle started during setup,
      // return before mutating shared state (nextTurn messages, system prompt).
      if (this.#promptGeneration !== generation) {
        return
      }

      // Inject any pending "nextTurn" messages as context alongside the user message
      for (const msg of this.#pendingNextTurnMessages) {
        messages.push(msg)
      }
      this.#pendingNextTurnMessages = []

      // Auto-read @filepath mentions
      const fileMentions = extractFileMentions(expandedText)
      if (fileMentions.length > 0) {
        const fileMentionMessages = await generateFileMentionMessages(fileMentions, this.sessionManager.getCwd(), {
          autoResizeImages: this.settings.get("images.autoResize"),
          useHashLines: resolveFileDisplayMode(this).hashLines,
        })
        messages.push(...fileMentionMessages)
      }

      const beforeAgentStartSystemPrompt = await this.#buildSystemPromptForAgentStart(expandedText)

      // Emit before_agent_start extension event
      if (this.#extensionRunner) {
        const result = await this.#extensionRunner.emitBeforeAgentStart(
          expandedText,
          options?.images,
          beforeAgentStartSystemPrompt,
        )
        if (result?.messages) {
          const promptAttribution: "user" | "agent" | undefined =
            "attribution" in message ? message.attribution : undefined
          for (const msg of result.messages) {
            messages.push({
              role: "custom",
              customType: msg.customType,
              content: msg.content,
              display: msg.display,
              details: msg.details,
              attribution: msg.attribution ?? promptAttribution ?? (message.role === "user" ? "user" : "agent"),
              timestamp: Date.now(),
            })
          }
        }

        if (result?.systemPrompt !== undefined) {
          this.agent.setSystemPrompt(result.systemPrompt)
        } else {
          this.agent.setSystemPrompt(beforeAgentStartSystemPrompt)
        }
      } else {
        this.agent.setSystemPrompt(beforeAgentStartSystemPrompt)
      }

      // Bail out if a newer abort/prompt cycle has started since we began setup
      if (this.#promptGeneration !== generation) {
        return
      }

      const agentPromptOptions = options?.toolChoice ? { toolChoice: options.toolChoice } : undefined
      await this.#promptAgentWithIdleRetry(messages, agentPromptOptions)
      if (!options?.skipPostPromptRecoveryWait) {
        await this.#waitForPostPromptRecovery()
      }
    } finally {
      this.#endInFlight()
    }
  }

  /**
   * Try to execute an extension command. Returns true if command was found and executed.
   */
  /** 尝试执行扩展命令；找到并执行则返回 true */
  async #tryExecuteExtensionCommand(text: string): Promise<boolean> {
    if (!this.#extensionRunner) return false

    // Parse command name and args
    const spaceIndex = text.indexOf(" ")
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex)
    const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1)

    const command = this.#extensionRunner.getCommand(commandName)
    if (!command) return false

    // Get command context from extension runner (includes session control methods)
    const ctx = this.#extensionRunner.createCommandContext()

    try {
      await command.handler(args, ctx)
      return true
    } catch (err) {
      // Emit error via extension runner
      this.#extensionRunner.emitError({
        extensionPath: `command:${commandName}`,
        event: "command",
        error: err instanceof Error ? err.message : String(err),
      })
      return true
    }
  }

  /** 创建扩展命令执行上下文（无 extensionRunner 时使用 no-op UI） */
  #createCommandContext(): ExtensionCommandContext {
    if (this.#extensionRunner) {
      return this.#extensionRunner.createCommandContext()
    }

    return {
      ui: noOpUIContext,
      hasUI: false,
      cwd: this.sessionManager.getCwd(),
      sessionManager: this.sessionManager,
      modelRegistry: this.#modelRegistry,
      model: this.model ?? undefined,
      isIdle: () => !this.isStreaming,
      abort: () => {
        void this.abort()
      },
      hasPendingMessages: () => this.queuedMessageCount > 0,
      shutdown: () => {
        void this.dispose()
        process.exit(0)
      },
      hasQueuedMessages: () => this.queuedMessageCount > 0,
      getContextUsage: () => this.getContextUsage(),
      waitForIdle: () => this.waitForIdle(),
      newSession: async (options) => {
        const success = await this.newSession({ parentSession: options?.parentSession })
        if (!success) {
          return { cancelled: true }
        }
        if (options?.setup) {
          await options.setup(this.sessionManager)
        }
        return { cancelled: false }
      },
      branch: async (entryId) => {
        const result = await this.branch(entryId)
        return { cancelled: result.cancelled }
      },
      navigateTree: async (targetId, options) => {
        const result = await this.navigateTree(targetId, { summarize: options?.summarize })
        return { cancelled: result.cancelled }
      },
      compact: async (instructionsOrOptions) => {
        const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined
        const options =
          instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined
        await this.compact(instructions, options)
      },
      switchSession: async (sessionPath) => {
        const success = await this.switchSession(sessionPath)
        return { cancelled: !success }
      },
      reload: async () => {
        await this.reload()
      },
      getSystemPrompt: () => this.systemPrompt,
    }
  }

  /**
   * Try to execute a custom command. Returns the prompt string if found, null otherwise.
   * If the command returns void, returns empty string to indicate it was handled.
   */
  /** 尝试执行自定义斜杠命令；返回替换后的提示文本，void 表示已处理 */
  async #tryExecuteCustomCommand(text: string): Promise<string | null> {
    if (this.#customCommands.length === 0 && this.#mcpPromptCommands.length === 0) return null

    // Parse command name and args
    const spaceIndex = text.indexOf(" ")
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex)
    const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1)

    // Find matching command
    const loaded =
      this.#customCommands.find((c) => c.command.name === commandName) ??
      this.#mcpPromptCommands.find((c) => c.command.name === commandName)
    if (!loaded) return null

    // Get command context from extension runner (includes session control methods)
    const baseCtx = this.#createCommandContext()
    const ctx = {
      ...baseCtx,
      hasQueuedMessages: baseCtx.hasPendingMessages,
    } as unknown as HookCommandContext

    try {
      const args = parseCommandArgs(argsString)
      const result = await loaded.command.execute(args, ctx)
      // If result is a string, it's a prompt to send to LLM
      // If void/undefined, command handled everything
      return result ?? ""
    } catch (err) {
      // Emit error via extension runner
      if (this.#extensionRunner) {
        this.#extensionRunner.emitError({
          extensionPath: `custom-command:${commandName}`,
          event: "command",
          error: err instanceof Error ? err.message : String(err),
        })
      } else {
        const message = err instanceof Error ? err.message : String(err)
        logger.error("Custom command failed", { commandName, error: message })
      }
      return "" // Command was handled (with error)
    }
  }

  /**
   * Queue a steering message to interrupt the agent mid-run.
   */
  /** 排队转向消息以中断 Agent 当前运行 */
  async steer(text: string, images?: ImageContent[]): Promise<void> {
    if (text.startsWith("/")) {
      this.#throwIfExtensionCommand(text)
    }

    const expandedText = expandPromptTemplate(text, [...this.#promptTemplates])
    await this.#queueSteer(expandedText, images)
  }

  /**
   * Queue a follow-up message to process after the agent would otherwise stop.
   */
  /** 排队追加消息（Agent 停止后处理） */
  async followUp(text: string, images?: ImageContent[]): Promise<void> {
    if (text.startsWith("/")) {
      this.#throwIfExtensionCommand(text)
    }

    const expandedText = expandPromptTemplate(text, [...this.#promptTemplates])
    await this.#queueFollowUp(expandedText, images)
  }

  /**
   * Internal: Queue a steering message (already expanded, no extension command check).
   */
  /** 内部转向排队（已展开模板，不处理扩展命令） */
  async #queueSteer(text: string, images?: ImageContent[]): Promise<void> {
    const displayText = text || (images && images.length > 0 ? "[Image]" : "")
    this.#steeringMessages.push({ text: displayText })
    const content: (TextContent | ImageContent)[] = [{ type: "text", text }]
    if (images && images.length > 0) {
      content.push(...images)
    }
    this.agent.steer({
      role: "user",
      content,
      attribution: "user",
      timestamp: Date.now(),
    })
  }

  /**
   * Internal: Queue a follow-up message (already expanded, no extension command check).
   */
  /** 内部追加排队（已展开模板，空闲时可自动 continue 投递） */
  async #queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
    const displayText = text || (images && images.length > 0 ? "[Image]" : "")
    this.#followUpMessages.push({ text: displayText })
    const content: (TextContent | ImageContent)[] = [{ type: "text", text }]
    if (images && images.length > 0) {
      content.push(...images)
    }
    this.agent.followUp({
      role: "user",
      content,
      attribution: "user",
      timestamp: Date.now(),
    })
    // When fully idle AND the session is in a resumable assistant-ended state,
    // schedule an immediate continue so the queued follow-up is delivered
    // without waiting for the next user turn. We gate on isStreaming (model
    // actively producing), isRetrying (auto-retry backoff is sleeping between
    // attempts, #retryPromise set), and the last message being assistant —
    // agent.continue() only dequeues follow-ups from an assistant-ended state;
    // resuming from user/toolResult state runs an extra model call on the
    // stale prompt before draining the queue.
    if (this.#canAutoContinueForFollowUp()) {
      this.#scheduleAgentContinue({
        shouldContinue: () => this.#canAutoContinueForFollowUp() && this.agent.hasQueuedMessages(),
      })
    }
  }

  /**
   * Gate for idle-path follow-up auto-continue. See `#queueFollowUp` for rationale.
   */
  /** 判断是否可以为追加消息自动 continue（非流式、非重试、末条为助手消息） */
  #canAutoContinueForFollowUp(): boolean {
    if (this.isStreaming) return false
    if (this.isRetrying) return false
    const messages = this.agent.state.messages
    const last = messages[messages.length - 1]
    return last?.role === "assistant"
  }

  queueDeferredMessage(message: CustomMessage): void {
    this.#queueHiddenNextTurnMessage(message, true)
  }

  /** 入队隐藏的下回合自定义消息，可选触发新回合 */
  #queueHiddenNextTurnMessage(message: CustomMessage, triggerTurn: boolean): void {
    this.#pendingNextTurnMessages.push(message)
    if (!triggerTurn) return
    const generation = this.#promptGeneration
    if (this.#scheduledHiddenNextTurnGeneration === generation) {
      return
    }
    this.#scheduledHiddenNextTurnGeneration = generation
    this.#schedulePostPromptTask(
      async () => {
        if (this.#scheduledHiddenNextTurnGeneration === generation) {
          this.#scheduledHiddenNextTurnGeneration = undefined
        }
        if (this.#pendingNextTurnMessages.length === 0) {
          return
        }
        try {
          await this.#promptQueuedHiddenNextTurnMessages()
        } catch {
          // Leave the hidden next-turn messages queued for the next explicit prompt.
        }
      },
      {
        generation,
        onSkip: () => {
          if (this.#scheduledHiddenNextTurnGeneration === generation) {
            this.#scheduledHiddenNextTurnGeneration = undefined
          }
        },
      },
    )
  }

  /** 将排队的隐藏下一轮消息作为提示发送 */
  async #promptQueuedHiddenNextTurnMessages(): Promise<void> {
    if (this.#pendingNextTurnMessages.length === 0) {
      return
    }

    const queuedMessages = [...this.#pendingNextTurnMessages]
    this.#pendingNextTurnMessages = []
    const message = queuedMessages[queuedMessages.length - 1]
    if (!message) {
      return
    }

    const prependMessages = queuedMessages.slice(0, -1)
    const textContent = this.#getCustomMessageTextContent(message)
    try {
      await this.#promptWithMessage(message, textContent, {
        prependMessages,
        skipPostPromptRecoveryWait: true,
      })
    } catch (error) {
      this.#pendingNextTurnMessages = [...queuedMessages, ...this.#pendingNextTurnMessages]
      throw error
    }
  }

  /** 从自定义消息 content 提取纯文本（供 promptWithMessage 使用） */
  #getCustomMessageTextContent(message: Pick<CustomMessage, "content">): string {
    if (typeof message.content === "string") {
      return message.content
    }
    return message.content
      .filter((content): content is TextContent => content.type === "text")
      .map((content) => content.text)
      .join("")
  }

  /** 若文本为扩展命令则抛错（扩展命令不可 steer/followUp 排队） */
  #throwIfExtensionCommand(text: string): void {
    if (!this.#extensionRunner) return

    const spaceIndex = text.indexOf(" ")
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex)
    const command = this.#extensionRunner.getCommand(commandName)

    if (command) {
      throw new Error(
        `Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
      )
    }
  }

  /**
   * Send a custom message to the session. Creates a CustomMessageEntry.
   *
   * Handles three cases:
   * - Streaming: queue as steer/follow-up or store for next turn
   * - Not streaming + triggerTurn: appends to state/session, starts new turn unless the client cannot own it
   * - Not streaming + no trigger: appends to state/session, no turn
   */
  /** 发送自定义消息：流式时 steer/followUp/nextTurn 排队，空闲时可触发新回合 */
  async sendCustomMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): Promise<void> {
    const appMessage: CustomMessage<T> = {
      role: "custom",
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
      attribution: message.attribution ?? "agent",
      timestamp: Date.now(),
    }
    if (this.isStreaming) {
      if (options?.deliverAs === "nextTurn") {
        this.#queueHiddenNextTurnMessage(appMessage, options?.triggerTurn ?? false)
        return
      }

      if (options?.deliverAs === "followUp") {
        this.agent.followUp(appMessage)
      } else {
        this.agent.steer(appMessage)
      }
      return
    }

    if (options?.deliverAs === "nextTurn") {
      if (options?.triggerTurn) {
        if (this.#clientBridge?.deferAgentInitiatedTurns && !this.#allowAcpAgentInitiatedTurns) {
          this.#queueHiddenNextTurnMessage(appMessage, false)
          return
        }
        await this.agent.prompt(appMessage)
        return
      }
      this.agent.appendMessage(appMessage)
      this.sessionManager.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details,
        message.attribution ?? "agent",
      )
      return
    }

    if (options?.triggerTurn) {
      if (this.#clientBridge?.deferAgentInitiatedTurns && !this.#allowAcpAgentInitiatedTurns) {
        this.#queueHiddenNextTurnMessage(appMessage, false)
        return
      }
      await this.agent.prompt(appMessage)
      return
    }

    this.agent.appendMessage(appMessage)
    this.sessionManager.appendCustomMessageEntry(
      message.customType,
      message.content,
      message.display,
      message.details,
      message.attribution ?? "agent",
    )
  }

  /** 发送用户消息并始终触发回合；流式时用 deliverAs 指定 steer 或 followUp */
  async sendUserMessage(
    content: string | (TextContent | ImageContent)[],
    options?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void> {
    // Normalize content to text string + optional images
    let text: string
    let images: ImageContent[] | undefined

    if (typeof content === "string") {
      text = content
    } else {
      const textParts: string[] = []
      images = []
      for (const part of content) {
        if (part.type === "text") {
          textParts.push(part.text)
        } else {
          images.push(part)
        }
      }
      text = textParts.join("\n")
      if (images.length === 0) images = undefined
    }

    // Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
    await this.prompt(text, {
      expandPromptTemplates: false,
      streamingBehavior: options?.deliverAs,
      images,
    })
  }

  /** 清空排队消息并返回（供用户中止后恢复到编辑器） */
  clearQueue(): { steering: string[]; followUp: string[] } {
    const steering = this.#steeringMessages.map((e) => e.text)
    const followUp = this.#followUpMessages.map((e) => e.text)
    this.#steeringMessages = []
    this.#followUpMessages = []
    this.agent.clearAllQueues()
    return { steering, followUp }
  }

  /** 待处理消息数量（含 steer、follow-up 与 next-turn） */
  get queuedMessageCount(): number {
    return this.#steeringMessages.length + this.#followUpMessages.length + this.#pendingNextTurnMessages.length
  }

  /** 获取待处理消息只读视图（内部 tag 条目映射为纯 text） */
  getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[] } {
    return {
      steering: this.#steeringMessages.map((e) => e.text),
      followUp: this.#followUpMessages.map((e) => e.text),
    }
  }

  /** 弹出最后一条排队消息（先 steer 后 follow-up），供出队快捷键恢复到编辑器 */
  popLastQueuedMessage(): string | undefined {
    // Pop from steering first (LIFO)
    if (this.#steeringMessages.length > 0) {
      const entry = this.#steeringMessages.pop()
      this.agent.popLastSteer()
      return entry?.text
    }
    // Then from follow-up
    if (this.#followUpMessages.length > 0) {
      const entry = this.#followUpMessages.pop()
      this.agent.popLastFollowUp()
      return entry?.text
    }
    return undefined
  }

  /** 技能设置 */
  get skillsSettings(): SkillsSettings | undefined {
    return this.#skillsSettings
  }

  /** SDK 加载的技能列表（--no-skills 或 skills: [] 时为空） */
  get skills(): readonly Skill[] {
    return this.#skills
  }

  /** SDK 捕获的技能加载警告 */
  get skillWarnings(): readonly SkillWarning[] {
    return this.#skillWarnings
  }

  /** 获取当前 Todo 阶段列表（深克隆） */
  getTodoPhases(): TodoPhase[] {
    return this.#cloneTodoPhases(this.#todoPhases)
  }

  /** 设置 Todo 阶段列表并调度自动清除定时器 */
  setTodoPhases(phases: TodoPhase[]): void {
    this.#todoPhases = this.#cloneTodoPhases(phases)
    this.#scheduleTodoAutoClear(phases)
  }

  /** 从当前分支条目同步 Todo 阶段（剔除已完成/已放弃任务） */
  #syncTodoPhasesFromBranch(): void {
    const phases = getLatestTodoPhasesFromEntries(this.sessionManager.getBranch())
    // Strip completed/abandoned tasks — they were done in a previous run,
    // so the auto-clear grace period has already elapsed.
    for (const phase of phases) {
      phase.tasks = phase.tasks.filter((t) => t.status !== "completed" && t.status !== "abandoned")
    }
    this.setTodoPhases(phases.filter((p) => p.tasks.length > 0))
  }

  /** 深克隆 Todo 阶段结构 */
  #cloneTodoPhases(phases: TodoPhase[]): TodoPhase[] {
    return phases.map((phase) => ({
      name: phase.name,
      tasks: phase.tasks.map((task) => {
        const out: TodoItem = { content: task.content, status: task.status }
        if (task.notes && task.notes.length > 0) out.notes = [...task.notes]
        return out
      }),
    }))
  }

  /** 为已完成/已放弃任务调度延迟自动清除 */
  #scheduleTodoAutoClear(phases: TodoPhase[]): void {
    const delaySec = this.settings.get("tasks.todoClearDelay") ?? 60
    if (delaySec < 0) return // "Never" — no auto-clear
    const delayMs = delaySec * 1000
    const doneKeys = new Set<string>()
    for (const phase of phases) {
      for (const task of phase.tasks) {
        if (task.status === "completed" || task.status === "abandoned") {
          doneKeys.add(todoClearKey(phase.name, task.content))
        }
      }
    }

    // Cancel timers for tasks that are no longer done (e.g. status was reverted)
    for (const [key, timer] of this.#todoClearTimers) {
      if (!doneKeys.has(key)) {
        clearTimeout(timer)
        this.#todoClearTimers.delete(key)
      }
    }

    // Schedule new timers for newly-done tasks
    for (const key of doneKeys) {
      if (this.#todoClearTimers.has(key)) continue
      if (delayMs === 0) {
        // Instant — run synchronously on next microtask to batch removals
        const timer = setTimeout(() => this.#runTodoAutoClear(key), 0)
        this.#todoClearTimers.set(key, timer)
      } else {
        const timer = setTimeout(() => this.#runTodoAutoClear(key), delayMs)
        this.#todoClearTimers.set(key, timer)
      }
    }
  }

  /** 移除单个已完成任务并通知 UI */
  #runTodoAutoClear(key: string): void {
    this.#todoClearTimers.delete(key)
    let removed = false
    for (const phase of this.#todoPhases) {
      const idx = phase.tasks.findIndex((t) => todoClearKey(phase.name, t.content) === key)
      if (idx !== -1 && (phase.tasks[idx].status === "completed" || phase.tasks[idx].status === "abandoned")) {
        phase.tasks.splice(idx, 1)
        removed = true
        break
      }
    }
    if (!removed) return

    // Remove empty phases
    this.#todoPhases = this.#todoPhases.filter((p) => p.tasks.length > 0)
    this.#emit({ type: "todo_auto_clear" })
  }

  /** 清除所有 Todo 自动清除定时器 */
  #clearTodoClearTimers(): void {
    for (const timer of this.#todoClearTimers.values()) {
      clearTimeout(timer)
    }
    this.#todoClearTimers.clear()
  }

  /**
   * Abort current operation and wait for agent to become idle.
   */
  /** 中止当前操作并等待 Agent 空闲（含压缩、handoff、bash 等子系统） */
  async abort(options?: { goalReason?: "interrupted" | "internal" }): Promise<void> {
    this.abortRetry()
    this.#promptGeneration++
    this.#scheduledHiddenNextTurnGeneration = undefined
    this.abortCompaction()
    this.abortHandoff()
    this.abortBash()
    this.abortEval()
    const postPromptDrain = this.#cancelPostPromptTasks()
    this.agent.abort()
    await postPromptDrain
    await this.agent.waitForIdle()
    await this.#goalRuntime.onTaskAborted({ reason: options?.goalReason ?? "interrupted" })
    // Clear prompt-in-flight state: waitForIdle resolves when the agent loop's finally
    // block runs, but nested prompt setup/finalizers may still be unwinding. Without this,
    // a subsequent prompt() can incorrectly observe the session as busy after an abort.
    this.#resetInFlight()
    // Safety net: if the agent loop aborted without producing an assistant
    // message (e.g. failed before the first stream), the in-flight yield was
    // never resolved or rejected by the normal message_end path. Reject it now
    // so any requeue callback still fires and the queue stays consistent.
    if (this.#toolChoiceQueue.hasInFlight) {
      this.#toolChoiceQueue.reject("aborted")
    }
  }

  /**
   * Start a new session, optionally with initial messages and parent tracking.
   * Clears all messages and starts a new session.
   * Listeners are preserved and will continue receiving events.
   * @param options - Optional initial messages and parent session path
   * @returns true if completed, false if cancelled by hook
   */
  /** 启动新会话：清空消息、重置 Agent 状态，可选保留父会话引用 */
  async newSession(options?: NewSessionOptions): Promise<boolean> {
    const previousSessionFile = this.sessionFile
    const nextDiscoverySessionToolNames = this.#mcpDiscoveryEnabled
      ? [...this.#getActiveNonMCPToolNames(), ...this.#filterSelectableMCPToolNames(this.#defaultSelectedMCPToolNames)]
      : undefined

    // Emit session_before_switch event with reason "new" (can be cancelled)
    if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
      const result = (await this.#extensionRunner.emit({
        type: "session_before_switch",
        reason: "new",
      })) as SessionBeforeSwitchResult | undefined

      if (result?.cancel) {
        return false
      }
    }

    this.#disconnectFromAgent()
    await this.abort()
    this.#cancelOwnAsyncJobs()
    this.#closeAllProviderSessions("new session")
    this.agent.reset()
    if (options?.drop && previousSessionFile) {
      try {
        await this.sessionManager.dropSession(previousSessionFile)
      } catch (err) {
        logger.error("Failed to delete session during /drop", { err })
      }
    } else {
      await this.sessionManager.flush()
    }
    await this.sessionManager.newSession(options)
    this.setTodoPhases([])
    this.#syncAgentSessionId()
    this.#rekeyHindsightMemoryForCurrentSessionId()
    this.#resetHindsightConversationTrackingIfHindsight()
    this.#steeringMessages = []
    this.#followUpMessages = []
    this.#pendingNextTurnMessages = []
    this.#scheduledHiddenNextTurnGeneration = undefined

    this.sessionManager.appendThinkingLevelChange(this.thinkingLevel)
    this.sessionManager.appendServiceTierChange(this.serviceTier ?? null)
    if (nextDiscoverySessionToolNames) {
      await this.#applyActiveToolsByName(nextDiscoverySessionToolNames, { persistMCPSelection: false })
      if (this.getSelectedMCPToolNames().length > 0) {
        this.sessionManager.appendMCPToolSelection(this.getSelectedMCPToolNames())
      }
    }
    this.#rememberSessionDefaultSelectedMCPToolNames(this.sessionFile, this.#getConfiguredDefaultSelectedMCPToolNames())

    this.#todoReminderCount = 0
    this.#planReferenceSent = false
    this.#planReferencePath = "local://PLAN.md"
    this.#reconnectToAgent()

    // Emit session_switch event with reason "new" to hooks
    if (this.#extensionRunner) {
      await this.#extensionRunner.emit({
        type: "session_switch",
        reason: "new",
        previousSessionFile,
      })
    }

    return true
  }

  /**
   * Set a display name for the current session.
   */
  /** 设置当前会话的显示名称 */
  setSessionName(name: string, source: "auto" | "user" = "auto"): Promise<boolean> {
    return this.sessionManager.setSessionName(name, source)
  }

  /**
   * Fork the current session, creating a new session file with the exact same state.
   * Copies all entries and artifacts to the new session.
   * Unlike newSession(), this preserves all messages in the agent state.
   * @returns true if completed, false if cancelled by hook or not persisting
   */
  /** 分叉当前会话：复制条目与 artifacts 到新会话文件，保留全部消息状态 */
  async fork(): Promise<boolean> {
    const previousSessionFile = this.sessionFile

    // Emit session_before_switch event with reason "fork" (can be cancelled)
    if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
      const result = (await this.#extensionRunner.emit({
        type: "session_before_switch",
        reason: "fork",
      })) as SessionBeforeSwitchResult | undefined

      if (result?.cancel) {
        return false
      }
    }

    // Flush current session to ensure all entries are written
    await this.sessionManager.flush()

    // Fork the session (creates new session file with same entries)
    const forkResult = await this.sessionManager.fork()
    if (!forkResult) {
      return false
    }

    // Copy artifacts directory if it exists
    const oldArtifactDir = forkResult.oldSessionFile.slice(0, -6)
    const newArtifactDir = forkResult.newSessionFile.slice(0, -6)

    try {
      const oldDirStat = await fs.promises.stat(oldArtifactDir)
      if (oldDirStat.isDirectory()) {
        await fs.promises.cp(oldArtifactDir, newArtifactDir, { recursive: true })
      }
    } catch (err) {
      if (!isEnoent(err)) {
        logger.warn("Failed to copy artifacts during fork", {
          oldArtifactDir,
          newArtifactDir,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Update agent session ID
    this.#syncAgentSessionId()
    this.#rekeyHindsightMemoryForCurrentSessionId()

    // Emit session_switch event with reason "fork" to hooks
    if (this.#extensionRunner) {
      await this.#extensionRunner.emit({
        type: "session_switch",
        reason: "fork",
        previousSessionFile,
      })
    }

    return true
  }

  // =========================================================================
  // Model Management
  // =========================================================================

  /**
   * Set model directly.
   * Validates API key, saves to session and settings.
   * @throws Error if no API key available for the model
   */
  /** 设置模型（持久化到设置），校验 API Key 后写入会话日志和设置文件 */
  async setModel(
    model: Model,
    role: string = "default",
    options?: { selector?: string; thinkingLevel?: ThinkingLevel },
  ): Promise<void> {
    const previousEditMode = this.#resolveActiveEditMode()
    const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId)
    if (!apiKey) {
      throw new Error(`No API key for ${model.provider}/${model.id}`)
    }

    this.#clearActiveRetryFallback()
    this.#setModelWithProviderSessionReset(model)
    this.sessionManager.appendModelChange(`${model.provider}/${model.id}`, role)
    this.settings.setModelRole(role, this.#formatRoleModelValue(role, model, options?.selector, options?.thinkingLevel))
    this.settings.getStorage()?.recordModelUsage(`${model.provider}/${model.id}`)

    // Re-apply thinking for the newly selected model. Prefer the model's
    // configured defaultLevel; otherwise preserve the current level.
    this.setThinkingLevel(model.thinking?.defaultLevel ?? this.thinkingLevel)
    await this.#syncEditToolModeAfterModelChange(previousEditMode)
  }

  /**
   * Set model temporarily (for this session only).
   * Validates API key, saves to session log but NOT to settings.
   * @throws Error if no API key available for the model
   */
  /** 临时设置模型（仅当前会话生效，不持久化到设置） */
  async setModelTemporary(model: Model, thinkingLevel?: ThinkingLevel): Promise<void> {
    const previousEditMode = this.#resolveActiveEditMode()
    const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId)
    if (!apiKey) {
      throw new Error(`No API key for ${model.provider}/${model.id}`)
    }

    this.#clearActiveRetryFallback()
    this.#setModelWithProviderSessionReset(model)
    this.sessionManager.appendModelChange(`${model.provider}/${model.id}`, "temporary")
    this.settings.getStorage()?.recordModelUsage(`${model.provider}/${model.id}`)

    // Apply explicit thinking level if given; otherwise prefer the model's
    // configured defaultLevel; otherwise re-clamp the current level.
    this.setThinkingLevel(thinkingLevel ?? model.thinking?.defaultLevel ?? this.thinkingLevel)
    await this.#syncEditToolModeAfterModelChange(previousEditMode)
  }

  /**
   * Cycle to next/previous model.
   * Uses scoped models (from --models flag) if available, otherwise all available models.
   * @param direction - "forward" (default) or "backward"
   * @returns The new model info, or undefined if only one model available
   */
  /** 循环切换模型（优先使用限定模型列表，否则遍历所有可用模型） */
  async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
    if (this.#scopedModels.length > 0) {
      return this.#cycleScopedModel(direction)
    }
    return this.#cycleAvailableModel(direction)
  }

  /**
   * Cycle through configured role models in a fixed order.
   * Skips missing roles.
   * @param roleOrder - Order of roles to cycle through (e.g., ["slow", "default", "smol"])
   * @param options - Optional settings: `temporary` to not persist to settings
   */
  /** 在角色模型列表中循环切换，按 roleOrder 顺序跳过未配置的角色 */
  async cycleRoleModels(
    roleOrder: readonly string[],
    options?: { temporary?: boolean },
  ): Promise<RoleModelCycleResult | undefined> {
    const availableModels = this.#modelRegistry.getAvailable()
    if (availableModels.length === 0) return undefined

    const currentModel = this.model
    if (!currentModel) return undefined
    const matchPreferences = { usageOrder: this.settings.getStorage()?.getModelUsageOrder() }
    const roleModels: Array<{
      role: string
      model: Model
      thinkingLevel?: ThinkingLevel
      explicitThinkingLevel: boolean
    }> = []

    for (const role of roleOrder) {
      const roleModelStr =
        role === "default"
          ? (this.settings.getModelRole("default") ?? `${currentModel.provider}/${currentModel.id}`)
          : this.settings.getModelRole(role)
      if (!roleModelStr) continue

      const resolved = resolveModelRoleValue(roleModelStr, availableModels, {
        settings: this.settings,
        matchPreferences,
        modelRegistry: this.#modelRegistry,
      })
      if (!resolved.model) continue

      roleModels.push({
        role,
        model: resolved.model,
        thinkingLevel: resolved.thinkingLevel,
        explicitThinkingLevel: resolved.explicitThinkingLevel,
      })
    }

    if (roleModels.length <= 1) return undefined

    const lastRole = this.sessionManager.getLastModelChangeRole()
    let currentIndex = lastRole ? roleModels.findIndex((entry) => entry.role === lastRole) : -1
    if (currentIndex === -1) {
      currentIndex = roleModels.findIndex((entry) => modelsAreEqual(entry.model, currentModel))
    }
    if (currentIndex === -1) currentIndex = 0

    const nextIndex = (currentIndex + 1) % roleModels.length
    const next = roleModels[nextIndex]

    if (options?.temporary) {
      await this.setModelTemporary(next.model, next.explicitThinkingLevel ? next.thinkingLevel : undefined)
    } else {
      await this.setModel(next.model, next.role)
      if (next.explicitThinkingLevel && next.thinkingLevel !== undefined) {
        this.setThinkingLevel(next.thinkingLevel)
      }
    }

    return { model: next.model, thinkingLevel: this.thinkingLevel, role: next.role }
  }

  /** 获取有 API Key 的限定模型列表 */
  async #getScopedModelsWithApiKey(): Promise<Array<{ model: Model; thinkingLevel?: ThinkingLevel }>> {
    const apiKeysByProvider = new Map<string, string | undefined>()
    const result: Array<{ model: Model; thinkingLevel?: ThinkingLevel }> = []

    for (const scoped of this.#scopedModels) {
      const provider = scoped.model.provider
      let apiKey: string | undefined
      if (apiKeysByProvider.has(provider)) {
        apiKey = apiKeysByProvider.get(provider)
      } else {
        apiKey = await this.#modelRegistry.getApiKeyForProvider(provider, this.sessionId)
        apiKeysByProvider.set(provider, apiKey)
      }

      if (apiKey) {
        result.push(scoped)
      }
    }

    return result
  }

  /** 在限定模型列表中循环切换 */
  async #cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
    const previousEditMode = this.#resolveActiveEditMode()
    const scopedModels = await this.#getScopedModelsWithApiKey()
    if (scopedModels.length <= 1) return undefined

    const currentModel = this.model
    let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel))

    if (currentIndex === -1) currentIndex = 0
    const len = scopedModels.length
    const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len
    const next = scopedModels[nextIndex]

    // Apply model
    this.#clearActiveRetryFallback()
    this.#setModelWithProviderSessionReset(next.model)
    this.sessionManager.appendModelChange(`${next.model.provider}/${next.model.id}`)
    this.settings.setModelRole("default", this.#formatRoleModelValue("default", next.model))
    this.settings.getStorage()?.recordModelUsage(`${next.model.provider}/${next.model.id}`)

    // Apply the scoped model's configured thinking level
    this.setThinkingLevel(next.thinkingLevel)
    await this.#syncEditToolModeAfterModelChange(previousEditMode)

    return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true }
  }

  /** 在全部可用模型中循环切换 */
  async #cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
    const previousEditMode = this.#resolveActiveEditMode()
    const availableModels = this.#modelRegistry.getAvailable()
    if (availableModels.length <= 1) return undefined

    const currentModel = this.model
    let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel))

    if (currentIndex === -1) currentIndex = 0
    const len = availableModels.length
    const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len
    const nextModel = availableModels[nextIndex]

    const apiKey = await this.#modelRegistry.getApiKey(nextModel, this.sessionId)
    if (!apiKey) {
      throw new Error(`No API key for ${nextModel.provider}/${nextModel.id}`)
    }

    this.#clearActiveRetryFallback()
    this.#setModelWithProviderSessionReset(nextModel)
    this.sessionManager.appendModelChange(`${nextModel.provider}/${nextModel.id}`)
    this.settings.setModelRole("default", this.#formatRoleModelValue("default", nextModel))
    this.settings.getStorage()?.recordModelUsage(`${nextModel.provider}/${nextModel.id}`)
    // Re-apply the current thinking level for the newly selected model
    this.setThinkingLevel(this.thinkingLevel)
    await this.#syncEditToolModeAfterModelChange(previousEditMode)

    return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false }
  }

  /**
   * Get all available models with valid API keys.
   */
  /** 返回当前注册表中所有可用的模型列表 */
  getAvailableModels(): Model[] {
    return this.#modelRegistry.getAvailable()
  }

  // =========================================================================
  // Thinking Level Management
  // =========================================================================

  /**
   * Set thinking level.
   * Saves the effective metadata-clamped level to session and settings only if it changes.
   */
  /** 设置思维等级，经模型元数据限幅后写入会话日志，等级变化时触发事件 */
  setThinkingLevel(level: ThinkingLevel | undefined, persist: boolean = false): void {
    const effectiveLevel = resolveThinkingLevelForModel(this.model, level)
    const isChanging = effectiveLevel !== this.#thinkingLevel

    this.#thinkingLevel = effectiveLevel
    this.agent.setThinkingLevel(toReasoningEffort(effectiveLevel))

    if (isChanging) {
      this.sessionManager.appendThinkingLevelChange(effectiveLevel)
      if (persist && effectiveLevel !== undefined && effectiveLevel !== ThinkingLevel.Off) {
        this.settings.set("defaultThinkingLevel", effectiveLevel)
      }
      this.#emit({ type: "thinking_level_changed", thinkingLevel: effectiveLevel })
    }
  }

  /**
   * Cycle to next thinking level.
   * @returns New level, or undefined if model doesn't support thinking
   */
  /** 循环切换思维等级，模型不支持思考时返回 undefined */
  cycleThinkingLevel(): ThinkingLevel | undefined {
    if (!this.model?.reasoning) return undefined

    const levels = [ThinkingLevel.Off, ...this.getAvailableThinkingLevels()]
    const currentLevel = this.thinkingLevel === ThinkingLevel.Inherit ? ThinkingLevel.Off : this.thinkingLevel
    const currentIndex = currentLevel ? levels.indexOf(currentLevel) : -1
    const nextIndex = (currentIndex + 1) % levels.length
    const nextLevel = levels[nextIndex]
    if (!nextLevel) return undefined

    this.setThinkingLevel(nextLevel)
    return nextLevel
  }

  /** 是否启用快速模式（serviceTier 为 priority） */
  isFastModeEnabled(): boolean {
    return this.serviceTier === "priority"
  }

  /** 设置服务层级并持久化到会话 */
  setServiceTier(serviceTier: ServiceTier | undefined): void {
    if (this.serviceTier === serviceTier) return
    this.agent.serviceTier = serviceTier
    this.sessionManager.appendServiceTierChange(serviceTier ?? null)
  }

  /** 开关快速模式（映射为 priority / undefined 服务层级） */
  setFastMode(enabled: boolean): void {
    this.setServiceTier(enabled ? "priority" : undefined)
  }

  /** 切换快速模式并返回新状态 */
  toggleFastMode(): boolean {
    const enabled = !this.isFastModeEnabled()
    this.setFastMode(enabled)
    return enabled
  }

  /**
   * Get available thinking levels for current model.
   */
  /** 返回当前模型支持的思维等级列表 */
  getAvailableThinkingLevels(): ReadonlyArray<Effort> {
    if (!this.model) return []
    return getSupportedEfforts(this.model)
  }

  // =========================================================================
  // Message Queue Mode Management
  // =========================================================================

  /**
   * Set steering mode.
   * Saves to settings.
   */
  /** 设置转向模式并持久化到设置 */
  setSteeringMode(mode: "all" | "one-at-a-time"): void {
    this.agent.setSteeringMode(mode)
    this.settings.set("steeringMode", mode)
  }

  /**
   * Set follow-up mode.
   * Saves to settings.
   */
  /** 设置追问模式并持久化到设置 */
  setFollowUpMode(mode: "all" | "one-at-a-time"): void {
    this.agent.setFollowUpMode(mode)
    this.settings.set("followUpMode", mode)
  }

  /**
   * Set interrupt mode.
   * Saves to settings.
   */
  /** 设置中断模式并持久化到设置 */
  setInterruptMode(mode: "immediate" | "wait"): void {
    this.agent.setInterruptMode(mode)
    this.settings.set("interruptMode", mode)
  }

  // =========================================================================
  // Compaction
  // =========================================================================

  /** 裁剪工具输出以释放上下文（按 DEFAULT_PRUNE_CONFIG） */
  async #pruneToolOutputs(): Promise<{ prunedCount: number; tokensSaved: number } | undefined> {
    const branchEntries = this.sessionManager.getBranch()
    const result = pruneToolOutputs(branchEntries, DEFAULT_PRUNE_CONFIG)
    if (result.prunedCount === 0) {
      return undefined
    }

    await this.sessionManager.rewriteEntries()
    const sessionContext = this.buildDisplaySessionContext()
    this.agent.replaceMessages(sessionContext.messages)
    this.#syncTodoPhasesFromBranch()
    this.#closeCodexProviderSessionsForHistoryRewrite()
    return result
  }

  /**
   * Manually compact the session context.
   * Aborts current agent operation first.
   * @param customInstructions Optional instructions for the compaction summary
   * @param options Optional callbacks for completion/error handling
   */
  /** 手动触发会话压缩：中止当前操作、生成摘要后重写会话条目 */
  async compact(customInstructions?: string, options?: CompactOptions): Promise<CompactionResult> {
    if (this.#compactionAbortController) {
      throw new Error("Compaction already in progress")
    }
    this.#disconnectFromAgent()
    await this.abort()
    const compactionAbortController = new AbortController()
    this.#compactionAbortController = compactionAbortController

    try {
      if (!this.model) {
        throw new Error("No model selected")
      }

      const compactionSettings = this.settings.getGroup("compaction")
      const pathEntries = this.sessionManager.getBranch()
      const preparation = prepareCompaction(pathEntries, compactionSettings)
      if (!preparation) {
        // Check why we can't compact
        const lastEntry = pathEntries[pathEntries.length - 1]
        if (lastEntry?.type === "compaction") {
          throw new Error("Already compacted")
        }
        throw new Error("Nothing to compact (session too small)")
      }

      let hookCompaction: CompactionResult | undefined
      let fromExtension = false
      let preserveData: Record<string, unknown> | undefined

      if (this.#extensionRunner?.hasHandlers("session_before_compact")) {
        const result = (await this.#extensionRunner.emit({
          type: "session_before_compact",
          preparation,
          branchEntries: pathEntries,
          customInstructions,
          signal: compactionAbortController.signal,
        })) as SessionBeforeCompactResult | undefined

        if (result?.cancel) {
          throw new CompactionCancelledError()
        }

        if (result?.compaction) {
          hookCompaction = result.compaction
          fromExtension = true
        }
      }

      const compactionPrep = await this.#prepareCompactionFromHooks(preparation, hookCompaction)

      let summary: string
      let shortSummary: string | undefined
      let firstKeptEntryId: string
      let tokensBefore: number
      let details: unknown

      if (compactionPrep.kind === "fromHook") {
        summary = compactionPrep.summary
        shortSummary = compactionPrep.shortSummary
        firstKeptEntryId = compactionPrep.firstKeptEntryId
        tokensBefore = compactionPrep.tokensBefore
        details = compactionPrep.details
        preserveData = compactionPrep.preserveData
      } else {
        // Generate compaction result. Only convert known abort-shaped
        // rejections (AbortError raised while the abort signal is set,
        // or an already-typed sentinel) into `CompactionCancelledError`
        // so downstream callers can discriminate cancel from generic
        // failure via `instanceof` without inspecting message strings.
        // Real compaction bugs (network, server, parsing, etc.) keep
        // their original shape — they must not be silently relabeled
        // as cancellations even if the signal happens to be aborted
        // for an unrelated reason. Assignments live inside the try
        // block because every catch path throws — the post-try reads
        // of the result-derived locals are reachable only on success.
        try {
          const result = await this.#compactWithFallbackModel(
            preparation,
            customInstructions,
            compactionAbortController.signal,
            {
              promptOverride: compactionPrep.hookPrompt,
              extraContext: compactionPrep.hookContext,
              remoteInstructions: this.#baseSystemPrompt.join("\n\n"),
              convertToLlm,
            },
          )
          summary = result.summary
          shortSummary = result.shortSummary
          firstKeptEntryId = result.firstKeptEntryId
          tokensBefore = result.tokensBefore
          details = result.details
          preserveData = { ...(compactionPrep.preserveData ?? {}), ...(result.preserveData ?? {}) }
        } catch (err) {
          if (err instanceof CompactionCancelledError) {
            throw err
          }
          if (compactionAbortController.signal.aborted && err instanceof Error && err.name === "AbortError") {
            throw new CompactionCancelledError()
          }
          throw err
        }
      }

      if (compactionAbortController.signal.aborted) {
        throw new CompactionCancelledError()
      }

      this.sessionManager.appendCompaction(
        summary,
        shortSummary,
        firstKeptEntryId,
        tokensBefore,
        details,
        fromExtension,
        preserveData,
      )
      const newEntries = this.sessionManager.getEntries()
      const sessionContext = this.buildDisplaySessionContext()
      this.agent.replaceMessages(sessionContext.messages)
      this.#syncTodoPhasesFromBranch()
      this.#closeCodexProviderSessionsForHistoryRewrite()

      // Get the saved compaction entry for the hook
      const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
        | CompactionEntry
        | undefined

      if (this.#extensionRunner && savedCompactionEntry) {
        await this.#extensionRunner.emit({
          type: "session_compact",
          compactionEntry: savedCompactionEntry,
          fromExtension,
        })
      }

      const compactionResult: CompactionResult = {
        summary,
        shortSummary,
        firstKeptEntryId,
        tokensBefore,
        details,
        preserveData,
      }
      options?.onComplete?.(compactionResult)
      return compactionResult
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      options?.onError?.(err)
      throw error
    } finally {
      if (this.#compactionAbortController === compactionAbortController) {
        this.#compactionAbortController = undefined
      }
      this.#reconnectToAgent()
    }
  }

  /**
   * Ask the active memory backend for an extra-context block to splice into
   * the compaction summary prompt. Both the manual and auto compaction paths
   * funnel through this helper so the behaviour stays identical.
   *
   * Failures are swallowed: a memory backend going sideways MUST NOT block
   * compaction (which is itself the recovery path for context overflow).
   */
  /** 从记忆后端收集预压缩上下文片段，失败时静默忽略以防阻断压缩流程 */
  async #collectMemoryBackendContext(preparation: {
    messagesToSummarize: AgentMessage[]
    turnPrefixMessages: AgentMessage[]
  }): Promise<string | undefined> {
    const backend = resolveMemoryBackend(this.settings)
    if (!backend.preCompactionContext) return undefined
    const messages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages)
    try {
      return await backend.preCompactionContext(messages, this.settings, this)
    } catch (err) {
      logger.debug("Memory backend preCompactionContext failed", {
        backend: backend.id,
        error: String(err),
      })
      return undefined
    }
  }

  /**
   * Cancel in-progress context maintenance (manual compaction, auto-compaction, or auto-handoff).
   */
  /** 中止正在进行的压缩操作（手动/自动压缩或自动切换） */
  abortCompaction(): void {
    this.#compactionAbortController?.abort()
    this.#autoCompactionAbortController?.abort()
    this.#handoffAbortController?.abort()
  }

  /** 触发空闲时压缩（走自动压缩流程并发出 UI 事件） */
  async runIdleCompaction(): Promise<void> {
    if (this.isStreaming || this.isCompacting) return
    await this.#runAutoCompaction("idle", false, true)
  }

  /**
   * Cancel in-progress branch summarization.
   */
  /** 中止正在进行的分支摘要生成 */
  abortBranchSummary(): void {
    this.#branchSummaryAbortController?.abort()
  }

  /**
   * Cancel in-progress handoff generation.
   */
  /** 中止正在进行的交接文档生成 */
  abortHandoff(): void {
    this.#handoffAbortController?.abort()
  }

  /**
   * Check if handoff generation is in progress.
   */
  /** 交接文档生成是否进行中 */
  get isGeneratingHandoff(): boolean {
    return this.#handoffAbortController !== undefined
  }

  /**
   * Generate a handoff document with a oneshot LLM call, then start a new session with it.
   *
   * @param customInstructions Optional focus for the handoff document
   * @param options Handoff execution options
   * @returns The handoff document text, or undefined if cancelled/failed
   */
  /** 生成交接文档并启动新会话：单次 LLM 调用生成摘要，之后将文档注入新会话 */
  async handoff(customInstructions?: string, options?: SessionHandoffOptions): Promise<HandoffResult | undefined> {
    const entries = this.sessionManager.getBranch()
    const messageCount = entries.filter((e) => e.type === "message").length

    if (messageCount < 2) {
      throw new Error("Nothing to hand off (no messages yet)")
    }

    this.#skipPostTurnMaintenanceAssistantTimestamp = undefined

    this.#handoffAbortController = new AbortController()
    const handoffAbortController = this.#handoffAbortController
    const handoffSignal = handoffAbortController.signal
    const sourceSignal = options?.signal
    const onSourceAbort = () => {
      if (!handoffSignal.aborted) {
        handoffAbortController.abort()
      }
    }
    if (sourceSignal) {
      sourceSignal.addEventListener("abort", onSourceAbort, { once: true })
      if (sourceSignal.aborted) {
        onSourceAbort()
      }
    }

    try {
      if (handoffSignal.aborted) {
        throw new Error("Handoff cancelled")
      }

      const model = this.model
      if (!model) {
        throw new Error("No model selected for handoff")
      }
      const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId)
      if (!apiKey) {
        throw new Error(`No API key for ${model.provider}`)
      }

      const handoffText = await generateHandoff(
        this.agent.state.messages,
        model,
        apiKey,
        {
          systemPrompt: this.#baseSystemPrompt,
          tools: this.agent.state.tools,
          customInstructions,
          convertToLlm,
          initiatorOverride: "agent",
          metadata: this.agent.metadataForProvider(model.provider),
          telemetry: resolveTelemetry(this.agent.telemetry, this.sessionId),
        },
        handoffSignal,
      )

      if (handoffSignal.aborted) {
        throw new Error("Handoff cancelled")
      }
      if (!handoffText) {
        return undefined
      }

      // Start a new session
      const previousSessionFile = this.sessionFile
      await this.sessionManager.flush()
      this.#cancelOwnAsyncJobs()
      await this.sessionManager.newSession(previousSessionFile ? { parentSession: previousSessionFile } : undefined)
      this.agent.reset()
      this.#syncAgentSessionId()
      this.#rekeyHindsightMemoryForCurrentSessionId()
      this.#resetHindsightConversationTrackingIfHindsight()
      this.#steeringMessages = []
      this.#followUpMessages = []
      this.#pendingNextTurnMessages = []
      this.#scheduledHiddenNextTurnGeneration = undefined
      this.#todoReminderCount = 0

      // Inject the handoff document as a custom message
      const handoffContent = createHandoffContext(handoffText)
      this.sessionManager.appendCustomMessageEntry("handoff", handoffContent, true, undefined, "agent")
      await this.sessionManager.ensureOnDisk()
      let savedPath: string | undefined
      if (options?.autoTriggered && this.settings.get("compaction.handoffSaveToDisk")) {
        const artifactsDir = this.sessionManager.getArtifactsDir()
        if (artifactsDir) {
          const handoffFilePath = path.join(artifactsDir, createHandoffFileName())
          try {
            await Bun.write(handoffFilePath, `${handoffText}\n`)
            savedPath = handoffFilePath
          } catch (error) {
            logger.warn("Failed to save handoff document to disk", {
              path: handoffFilePath,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        } else {
          logger.debug("Skipping handoff document save because session is not persisted")
        }
      }

      // Rebuild agent messages from session
      const sessionContext = this.buildDisplaySessionContext()
      this.agent.replaceMessages(sessionContext.messages)
      this.#syncTodoPhasesFromBranch()

      return { document: handoffText, savedPath }
    } catch (error) {
      if (handoffSignal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new Error("Handoff cancelled")
      }
      throw error
    } finally {
      sourceSignal?.removeEventListener("abort", onSourceAbort)
      this.#handoffAbortController = undefined
    }
  }

  /**
   * Check if context maintenance or promotion is needed and run it.
   * Called after agent_end and before prompt submission.
   *
   * Three cases (in order):
   * 1. Overflow + promotion: promote to larger model, retry without maintenance
   * 2. Overflow + no promotion target: run context maintenance, auto-retry on same model
   * 3. Threshold: Context over threshold, run context maintenance (no auto-retry)
   *
   * @param assistantMessage The assistant message to check
   * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
   */
  /** 检查是否需要压缩或模型晋级：溢出时优先晋级，无晋级目标时自动压缩 */
  async #checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<void> {
    // Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
    if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return
    const contextWindow = this.model?.contextWindow ?? 0
    const generation = this.#promptGeneration
    // Skip overflow check if the message came from a different model.
    // This handles the case where user switched from a smaller-context model (e.g. opus)
    // to a larger-context model (e.g. codex) - the overflow error from the old model
    // shouldn't trigger compaction for the new model.
    const sameModel =
      this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id
    // This handles the case where an error was kept after compaction (in the "kept" region).
    // The error shouldn't trigger another compaction since we already compacted.
    // Example: opus fails -> switch to codex -> compact -> switch back to opus -> opus error
    // is still in context but shouldn't trigger compaction again.
    const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch())
    const errorIsFromBeforeCompaction =
      compactionEntry !== null && assistantMessage.timestamp < new Date(compactionEntry.timestamp).getTime()
    if (sameModel && !errorIsFromBeforeCompaction && isContextOverflow(assistantMessage, contextWindow)) {
      // Remove the error message from agent state (it IS saved to session for history,
      // but we don't want it in context for the retry)
      const messages = this.agent.state.messages
      if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
        this.agent.replaceMessages(messages.slice(0, -1))
      }

      // Try context promotion first - switch to a larger model and retry without compacting
      const promoted = await this.#tryContextPromotion(assistantMessage)
      if (promoted) {
        // Retry on the promoted (larger) model without compacting
        this.#scheduleAgentContinue({ delayMs: 100, generation })
        return
      }

      // No promotion target available fall through to compaction
      const compactionSettings = this.settings.getGroup("compaction")
      if (compactionSettings.enabled && compactionSettings.strategy !== "off") {
        await this.#runAutoCompaction("overflow", true)
      }
      return
    }
    const compactionSettings = this.settings.getGroup("compaction")
    if (!compactionSettings.enabled || compactionSettings.strategy === "off") return

    // Case 2: Threshold - turn succeeded but context is getting large
    // Skip if this was an error (non-overflow errors don't have usage data)
    if (assistantMessage.stopReason === "error") return
    const pruneResult = await this.#pruneToolOutputs()
    let contextTokens = calculateContextTokens(assistantMessage.usage)
    if (pruneResult) {
      contextTokens = Math.max(0, contextTokens - pruneResult.tokensSaved)
    }
    if (shouldCompact(contextTokens, contextWindow, compactionSettings)) {
      // Try promotion first — if a larger model is available, switch instead of compacting
      const promoted = await this.#tryContextPromotion(assistantMessage)
      if (!promoted) {
        await this.#runAutoCompaction("threshold", false)
      }
    }
  }

  /** 判断助手消息是否以成功的 yield 工具调用结束 */
  #assistantEndedWithSuccessfulYield(assistantMessage: AssistantMessage): boolean {
    const toolCallId = this.#lastSuccessfulYieldToolCallId
    if (!toolCallId) return false
    const lastToolCall = assistantMessage.content
      .slice()
      .reverse()
      .find((content): content is ToolCall => content.type === "toolCall")
    return lastToolCall?.name === "yield" && lastToolCall.id === toolCallId
  }

  /** 强制在 yield 前执行 rewind（活跃 checkpoint 时注入提醒并调度 continue） */
  #enforceRewindBeforeYield(): boolean {
    if (!this.#checkpointState || this.#pendingRewindReport) {
      return false
    }
    const reminder = [
      "<system-warning>",
      "You are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint.",
      "</system-warning>",
    ].join("\n")
    this.agent.appendMessage({
      role: "developer",
      content: [{ type: "text", text: reminder }],
      attribution: "agent",
      timestamp: Date.now(),
    })
    this.#scheduleAgentContinue({ generation: this.#promptGeneration })
    return true
  }

  /** 应用回退操作：截断消息、分支并写入 rewind 报告 */
  async #applyRewind(report: string): Promise<void> {
    const checkpointState = this.#checkpointState
    if (!checkpointState) {
      return
    }
    const safeCount = Math.max(0, Math.min(checkpointState.checkpointMessageCount, this.agent.state.messages.length))
    this.agent.replaceMessages(this.agent.state.messages.slice(0, safeCount))
    try {
      this.sessionManager.branchWithSummary(checkpointState.checkpointEntryId, report, {
        startedAt: checkpointState.startedAt,
      })
    } catch (error) {
      logger.warn("Rewind branch checkpoint missing, falling back to root", {
        error: error instanceof Error ? error.message : String(error),
      })
      this.sessionManager.branchWithSummary(null, report, { startedAt: checkpointState.startedAt })
    }
    const details = { startedAt: checkpointState.startedAt, rewoundAt: new Date().toISOString() }
    this.agent.appendMessage({
      role: "custom",
      customType: "rewind-report",
      content: report,
      display: false,
      details,
      attribution: "agent",
      timestamp: Date.now(),
    })
    this.sessionManager.appendCustomMessageEntry("rewind-report", report, false, details, "agent")
    this.#checkpointState = undefined
    this.#pendingRewindReport = undefined
  }

  /** 强制 Plan 模式工具决策（未调用 ask/resolve 时注入提醒） */
  async #enforcePlanModeToolDecision(): Promise<void> {
    if (!this.#planModeState?.enabled) {
      return
    }
    const assistantMessage = this.#findLastAssistantMessage()
    if (!assistantMessage) {
      return
    }
    if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
      return
    }

    const calledRequiredTool = assistantMessage.content.some(
      (content) => content.type === "toolCall" && (content.name === "ask" || content.name === "resolve"),
    )
    if (calledRequiredTool) {
      return
    }
    const hasRequiredTools = this.#toolRegistry.has("ask") && this.#toolRegistry.has("resolve")
    if (!hasRequiredTools) {
      logger.warn("Plan mode enforcement skipped because ask/resolve tools are unavailable", {
        activeToolNames: this.agent.state.tools.map((tool) => tool.name),
      })
      return
    }

    const reminder = prompt.render(planModeToolDecisionReminderPrompt, {
      askToolName: "ask",
    })

    await this.prompt(reminder, {
      synthetic: true,
      expandPromptTemplates: false,
      toolChoice: "required",
    })
  }

  /** 创建积极 Todo 前奏：首轮用户消息时强制 todo_write，跳过问句/感叹句 */
  #createEagerTodoPrelude(promptText: string): { message: AgentMessage; toolChoice: ToolChoice } | undefined {
    const eagerTodosEnabled = this.settings.get("todo.eager")
    const todosEnabled = this.settings.get("todo.enabled")
    if (!eagerTodosEnabled || !todosEnabled) {
      return undefined
    }

    if (this.#planModeState?.enabled) {
      return undefined
    }
    if (this.getTodoPhases().length > 0) {
      return undefined
    }

    // Only inject on the first user message of the conversation. Subsequent user
    // turns must not receive the eager todo reminder — they often correct, clarify,
    // or redirect the prior task, and forcing a brand-new todo list there is wrong.
    const hasPriorUserMessage = this.agent.state.messages.some((m) => m.role === "user")
    if (hasPriorUserMessage) {
      return undefined
    }

    const trimmedPromptText = promptText.trimEnd()
    if (trimmedPromptText.endsWith("?") || trimmedPromptText.endsWith("!")) {
      return undefined
    }

    if (!this.#toolRegistry.has("todo_write")) {
      logger.warn("Eager todo enforcement skipped because todo_write is unavailable", {
        activeToolNames: this.agent.state.tools.map((tool) => tool.name),
      })
      return undefined
    }

    const todoWriteToolChoice = buildNamedToolChoice("todo_write", this.model)
    if (!todoWriteToolChoice) {
      logger.warn("Eager todo enforcement skipped because the current model does not support forcing todo_write", {
        modelApi: this.model?.api,
        modelId: this.model?.id,
      })
      return undefined
    }

    const eagerTodoReminder = prompt.render(eagerTodoPrompt)

    return {
      message: {
        role: "custom",
        customType: "eager-todo-prelude",
        content: eagerTodoReminder,
        display: false,
        attribution: "agent",
        timestamp: Date.now(),
      },
      toolChoice: todoWriteToolChoice,
    }
  }
  /**
   * Check if agent stopped with incomplete todos and prompt to continue.
   */
  /** 检查未完成 Todo 并发送提醒以继续工作 */
  async #checkTodoCompletion(): Promise<void> {
    // Skip todo reminders when the most recent turn was driven by an explicit user force —
    // the user wanted exactly that tool, not a follow-up nag about incomplete todos.
    const lastServedLabel = this.#toolChoiceQueue.consumeLastServedLabel()
    if (lastServedLabel === "user-force") {
      return
    }

    const remindersEnabled = this.settings.get("todo.reminders")
    const todosEnabled = this.settings.get("todo.enabled")
    if (!remindersEnabled || !todosEnabled) {
      this.#todoReminderCount = 0
      return
    }

    const remindersMax = this.settings.get("todo.reminders.max")
    if (this.#todoReminderCount >= remindersMax) {
      logger.debug("Todo completion: max reminders reached", { count: this.#todoReminderCount })
      return
    }

    const phases = this.getTodoPhases()
    if (phases.length === 0) {
      this.#todoReminderCount = 0
      return
    }

    const incompleteByPhase = phases
      .map((phase) => ({
        name: phase.name,
        tasks: phase.tasks
          .filter(
            (task): task is TodoItem & { status: "pending" | "in_progress" } =>
              task.status === "pending" || task.status === "in_progress",
          )
          .map((task) => ({ content: task.content, status: task.status })),
      }))
      .filter((phase) => phase.tasks.length > 0)
    const incomplete = incompleteByPhase.flatMap((phase) => phase.tasks)
    if (incomplete.length === 0) {
      this.#todoReminderCount = 0
      return
    }

    // Build reminder message
    this.#todoReminderCount++
    const todoList = incompleteByPhase
      .map((phase) => `- ${phase.name}\n${phase.tasks.map((task) => `  - ${task.content}`).join("\n")}`)
      .join("\n")
    const reminder =
      `<system-reminder>\n` +
      `You stopped with ${incomplete.length} incomplete todo item(s):\n${todoList}\n\n` +
      `Please continue working on these tasks or mark them complete if finished.\n` +
      `(Reminder ${this.#todoReminderCount}/${remindersMax})\n` +
      `</system-reminder>`

    logger.debug("Todo completion: sending reminder", {
      incomplete: incomplete.length,
      attempt: this.#todoReminderCount,
    })

    // Emit event for UI to render notification
    await this.#emitSessionEvent({
      type: "todo_reminder",
      todos: incomplete,
      attempt: this.#todoReminderCount,
      maxAttempts: remindersMax,
    })

    // Inject reminder and continue the conversation
    this.agent.appendMessage({
      role: "developer",
      content: [{ type: "text", text: reminder }],
      attribution: "agent",
      timestamp: Date.now(),
    })
    this.#scheduleAgentContinue({ generation: this.#promptGeneration })
  }

  /**
   * Attempt context promotion to a larger model.
   * Returns true if promotion succeeded (caller should retry without compacting).
   */
  /** 尝试将上下文晋级到更大窗口的模型，成功则无需压缩即可重试 */
  async #tryContextPromotion(assistantMessage: AssistantMessage): Promise<boolean> {
    const promotionSettings = this.settings.getGroup("contextPromotion")
    if (!promotionSettings.enabled) return false
    const currentModel = this.model
    if (!currentModel) return false
    if (assistantMessage.provider !== currentModel.provider || assistantMessage.model !== currentModel.id) return false
    const contextWindow = currentModel.contextWindow ?? 0
    if (contextWindow <= 0) return false
    const targetModel = await this.#resolveContextPromotionTarget(currentModel, contextWindow)
    if (!targetModel) return false

    try {
      await this.setModelTemporary(targetModel)
      logger.debug("Context promotion switched model on overflow", {
        from: `${currentModel.provider}/${currentModel.id}`,
        to: `${targetModel.provider}/${targetModel.id}`,
      })
      return true
    } catch (error) {
      logger.warn("Context promotion failed", {
        from: `${currentModel.provider}/${currentModel.id}`,
        to: `${targetModel.provider}/${targetModel.id}`,
        error: String(error),
      })
      return false
    }
  }

  /** 解析上下文推广目标模型（更大 contextWindow 且可解析 API Key） */
  async #resolveContextPromotionTarget(currentModel: Model, contextWindow: number): Promise<Model | undefined> {
    const availableModels = this.#modelRegistry.getAvailable()
    if (availableModels.length === 0) return undefined

    const candidate = this.#resolveContextPromotionConfiguredTarget(currentModel, availableModels)
    if (!candidate) return undefined
    if (modelsAreEqual(candidate, currentModel)) return undefined
    if (candidate.contextWindow <= contextWindow) return undefined
    const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId)
    if (!apiKey) return undefined
    return candidate
  }

  /** 设置模型并重置相关提供商会话状态 */
  #setModelWithProviderSessionReset(model: Model): void {
    const currentModel = this.model
    if (currentModel) {
      this.#closeProviderSessionsForModelSwitch(currentModel, model)
    }
    this.agent.setModel(model)
  }

  /** 历史重写后关闭 Codex 提供商会话（避免陈旧会话 ID） */
  #closeCodexProviderSessionsForHistoryRewrite(): void {
    const currentModel = this.model
    if (!currentModel || currentModel.api !== "openai-codex-responses") return
    this.#closeProviderSessionsForModelSwitch(currentModel, currentModel)
  }

  /** 模型切换时关闭受影响的 OpenAI/Codex 提供商会话状态 */
  #closeProviderSessionsForModelSwitch(currentModel: Model, nextModel: Model): void {
    const providerKeys = new Set<string>()
    if (currentModel.api === "openai-codex-responses" || nextModel.api === "openai-codex-responses") {
      providerKeys.add("openai-codex-responses")
    }
    if (currentModel.api === "openai-responses") {
      providerKeys.add(`openai-responses:${currentModel.provider}`)
    }
    if (nextModel.api === "openai-responses") {
      providerKeys.add(`openai-responses:${nextModel.provider}`)
    }

    for (const providerKey of providerKeys) {
      const state = this.#providerSessionState.get(providerKey)
      if (!state) continue

      try {
        state.close()
      } catch (error) {
        logger.warn("Failed to close provider session state during model switch", {
          providerKey,
          error: String(error),
        })
      }

      this.#providerSessionState.delete(providerKey)
    }
  }

  /** 递归规范化提供商重放载荷中的嵌套结构 */
  #normalizeProviderReplayValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.#normalizeProviderReplayValue(item))
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entryValue]) => [key, this.#normalizeProviderReplayValue(entryValue)]),
      )
    }
    return value
  }

  /** 规范化会话消息用于提供商重放比较（剔除 thinking 等不稳定块） */
  #normalizeSessionMessageForProviderReplay(message: AgentMessage): unknown {
    switch (message.role) {
      case "user":
      case "developer":
        return {
          role: message.role,
          content: this.#normalizeProviderReplayValue(message.content),
          providerPayload: message.providerPayload,
        }
      case "assistant": {
        const isResponsesFamilyMessage = message.api === "openai-responses" || message.api === "openai-codex-responses"
        return {
          role: message.role,
          content:
            isResponsesFamilyMessage && Array.isArray(message.content)
              ? message.content.flatMap((block) => {
                  if (block.type === "thinking") {
                    return []
                  }
                  if (block.type === "toolCall") {
                    return [
                      {
                        type: block.type,
                        id: block.id,
                        name: block.name,
                        arguments: block.arguments,
                      },
                    ]
                  }
                  if (block.type === "text") {
                    return [{ type: block.type, text: block.text, textSignature: block.textSignature }]
                  }
                  return [this.#normalizeProviderReplayValue(block)]
                })
              : this.#normalizeProviderReplayValue(message.content),
          api: message.api,
          provider: message.provider,
          model: message.model,
          stopReason: message.stopReason,
          errorMessage: message.errorMessage,
          providerPayload: isResponsesFamilyMessage ? undefined : message.providerPayload,
        }
      }
      case "toolResult":
        return {
          role: message.role,
          toolName: message.toolName,
          toolCallId: message.toolCallId,
          isError: message.isError,
          content: this.#normalizeProviderReplayValue(message.content),
        }
      case "bashExecution":
        return {
          role: message.role,
          command: message.command,
          output: message.output,
          exitCode: message.exitCode,
          cancelled: message.cancelled,
          meta: message.meta
            ? {
                truncation: this.#normalizeProviderReplayValue(message.meta.truncation),
                limits: this.#normalizeProviderReplayValue(message.meta.limits),
                diagnostics: message.meta.diagnostics
                  ? this.#normalizeProviderReplayValue({
                      summary: message.meta.diagnostics.summary,
                      messages: message.meta.diagnostics.messages,
                    })
                  : undefined,
              }
            : undefined,
          excludeFromContext: message.excludeFromContext,
        }
      case "pythonExecution":
        return {
          role: message.role,
          code: message.code,
          output: message.output,
          exitCode: message.exitCode,
          cancelled: message.cancelled,
          meta: message.meta
            ? {
                truncation: this.#normalizeProviderReplayValue(message.meta.truncation),
                limits: this.#normalizeProviderReplayValue(message.meta.limits),
                diagnostics: message.meta.diagnostics
                  ? this.#normalizeProviderReplayValue({
                      summary: message.meta.diagnostics.summary,
                      messages: message.meta.diagnostics.messages,
                    })
                  : undefined,
              }
            : undefined,
          excludeFromContext: message.excludeFromContext,
        }
      case "custom":
      case "hookMessage":
        return {
          role: message.role,
          customType: message.customType,
          content: this.#normalizeProviderReplayValue(message.content),
        }
      case "branchSummary":
        return { role: message.role, summary: message.summary }
      case "compactionSummary":
        return {
          role: message.role,
          summary: message.summary,
          providerPayload: message.providerPayload,
        }
      case "fileMention":
        return {
          role: message.role,
          files: message.files.map((file) => ({
            path: file.path,
            content: file.content,
            image: file.image,
          })),
        }
      default:
        return this.#normalizeProviderReplayValue(message)
    }
  }

  /** 比较两组会话消息是否发生变化（规范化后 JSON 比较） */
  #didSessionMessagesChange(previousMessages: AgentMessage[], nextMessages: AgentMessage[]): boolean {
    return (
      JSON.stringify(previousMessages.map((message) => this.#normalizeSessionMessageForProviderReplay(message))) !==
      JSON.stringify(nextMessages.map((message) => this.#normalizeSessionMessageForProviderReplay(message)))
    )
  }

  /** 获取模型唯一键 provider/id */
  #getModelKey(model: Model): string {
    return `${model.provider}/${model.id}`
  }

  /** 格式化角色模型值字符串（含思维等级后缀） */
  #formatRoleModelValue(
    role: string,
    model: Model,
    selectorOverride?: string,
    thinkingLevelOverride?: ThinkingLevel,
  ): string {
    const modelKey = selectorOverride ?? `${model.provider}/${model.id}`
    if (thinkingLevelOverride !== undefined) {
      return formatModelSelectorValue(modelKey, thinkingLevelOverride)
    }
    const existingRoleValue = this.settings.getModelRole(role)
    if (!existingRoleValue) return modelKey

    const thinkingLevel = extractExplicitThinkingSelector(existingRoleValue, this.settings)
    return formatModelSelectorValue(modelKey, thinkingLevel)
  }

  /** 从模型配置解析上下文推广目标 */
  #resolveContextPromotionConfiguredTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
    const configuredTarget = currentModel.contextPromotionTarget?.trim()
    if (!configuredTarget) return undefined

    const parsed = parseModelString(configuredTarget)
    if (parsed) {
      const explicitModel = availableModels.find((m) => m.provider === parsed.provider && m.id === parsed.id)
      if (explicitModel) return explicitModel
    }

    return availableModels.find((m) => m.provider === currentModel.provider && m.id === configuredTarget)
  }

  /** 解析角色对应的完整模型与思维等级 */
  #resolveRoleModelFull(
    role: string,
    availableModels: Model[],
    currentModel: Model | undefined,
  ): ResolvedModelRoleValue {
    const roleModelStr =
      role === "default"
        ? (this.settings.getModelRole("default") ??
          (currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined))
        : this.settings.getModelRole(role)

    if (!roleModelStr) {
      return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined }
    }

    return resolveModelRoleValue(roleModelStr, availableModels, {
      settings: this.settings,
      matchPreferences: { usageOrder: this.settings.getStorage()?.getModelUsageOrder() },
      modelRegistry: this.#modelRegistry,
    })
  }

  /** 获取压缩候选模型列表（角色模型 + 最大 context 回退） */
  #getCompactionModelCandidates(availableModels: Model[]): Model[] {
    const candidates: Model[] = []
    const seen = new Set<string>()

    const addCandidate = (model: Model | undefined): void => {
      if (!model) return
      const key = this.#getModelKey(model)
      if (seen.has(key)) return
      seen.add(key)
      candidates.push(model)
    }

    const currentModel = this.model
    for (const role of MODEL_ROLE_IDS) {
      addCandidate(this.#resolveRoleModelFull(role, availableModels, currentModel).model)
    }

    const sortedByContext = [...availableModels].sort((a, b) => b.contextWindow - a.contextWindow)
    for (const model of sortedByContext) {
      if (!seen.has(this.#getModelKey(model))) {
        addCandidate(model)
        break
      }
    }

    return candidates
  }

  /** 判断压缩失败是否为凭证不可用 */
  #isCompactionAuthFailure(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return /auth_unavailable|no auth available/i.test(error.message)
  }

  /** 构建压缩凭证缺失时的用户可读错误 */
  #buildCompactionAuthError(): Error {
    const currentModel = this.model
    if (!currentModel) {
      return new Error(
        "Compaction requires a model with usable credentials, but no authenticated compaction model is available.",
      )
    }
    return new Error(
      `Compaction requires usable credentials for ${currentModel.provider}/${currentModel.id}. ` +
        `Configure ${currentModel.provider} credentials or assign an authenticated fallback role such as modelRoles.smol.`,
    )
  }

  /** 使用回退模型链执行压缩，跳过无 API Key 的候选 */
  async #compactWithFallbackModel(
    preparation: CompactionPreparation,
    customInstructions: string | undefined,
    signal: AbortSignal,
    options?: SummaryOptions,
  ): Promise<CompactionResult> {
    const candidates = this.#getCompactionModelCandidates(this.#modelRegistry.getAvailable())
    const telemetry = resolveTelemetry(this.agent.telemetry, this.sessionId)

    for (const candidate of candidates) {
      const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId)
      if (!apiKey) continue

      try {
        return await compact(preparation, candidate, apiKey, customInstructions, signal, {
          ...options,
          metadata: this.agent.metadataForProvider(candidate.provider),
          convertToLlm,
          telemetry,
        })
      } catch (error) {
        if (!this.#isCompactionAuthFailure(error)) {
          throw error
        }
      }
    }

    throw this.#buildCompactionAuthError()
  }

  /** 从扩展 Hook 准备压缩数据（hook 结果或默认 compact 路径） */
  async #prepareCompactionFromHooks(
    preparation: CompactionPreparation,
    hookCompaction: CompactionResult | undefined,
  ): Promise<
    | {
        kind: "fromHook"
        summary: string
        shortSummary: string | undefined
        firstKeptEntryId: string
        tokensBefore: number
        details: unknown
        preserveData: Record<string, unknown> | undefined
      }
    | {
        kind: "needsLlm"
        hookContext: string[] | undefined
        hookPrompt: string | undefined
        preserveData: Record<string, unknown> | undefined
      }
  > {
    let hookContext: string[] | undefined
    let hookPrompt: string | undefined
    let preserveData: Record<string, unknown> | undefined

    if (!hookCompaction && this.#extensionRunner?.hasHandlers("session.compacting")) {
      const compactMessages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages)
      const result = (await this.#extensionRunner.emit({
        type: "session.compacting",
        sessionId: this.sessionId,
        messages: compactMessages,
      })) as { context?: string[]; prompt?: string; preserveData?: Record<string, unknown> } | undefined

      hookContext = result?.context
      hookPrompt = result?.prompt
      preserveData = result?.preserveData
    }

    const memoryBackendContext = await this.#collectMemoryBackendContext(preparation)
    if (memoryBackendContext) {
      hookContext = hookContext ? [...hookContext, memoryBackendContext] : [memoryBackendContext]
    }

    if (hookCompaction) {
      preserveData ??= hookCompaction.preserveData
      return {
        kind: "fromHook",
        summary: hookCompaction.summary,
        shortSummary: hookCompaction.shortSummary,
        firstKeptEntryId: hookCompaction.firstKeptEntryId,
        tokensBefore: hookCompaction.tokensBefore,
        details: hookCompaction.details,
        preserveData,
      }
    }

    return { kind: "needsLlm", hookContext, hookPrompt, preserveData }
  }

  /**
   * Internal: Run auto-compaction with events.
   */
  /** 内部：执行自动压缩（溢出/阈值/空闲），发出 UI 事件并可自动继续 */
  async #runAutoCompaction(
    reason: "overflow" | "threshold" | "idle",
    willRetry: boolean,
    deferred = false,
  ): Promise<void> {
    const compactionSettings = this.settings.getGroup("compaction")
    if (compactionSettings.strategy === "off") return
    if (reason !== "idle" && !compactionSettings.enabled) return
    const generation = this.#promptGeneration
    if (!deferred && reason !== "overflow" && reason !== "idle" && compactionSettings.strategy === "handoff") {
      this.#schedulePostPromptTask(
        async (signal) => {
          await Promise.resolve()
          if (signal.aborted) return
          await this.#runAutoCompaction(reason, willRetry, true)
        },
        { generation },
      )
      return
    }

    let action: "context-full" | "handoff" =
      compactionSettings.strategy === "handoff" && reason !== "overflow" ? "handoff" : "context-full"
    await this.#emitSessionEvent({ type: "auto_compaction_start", reason, action })
    // Abort any older auto-compaction before installing this run's controller.
    this.#autoCompactionAbortController?.abort()
    const autoCompactionAbortController = new AbortController()
    this.#autoCompactionAbortController = autoCompactionAbortController
    const autoCompactionSignal = autoCompactionAbortController.signal

    try {
      if (compactionSettings.strategy === "handoff" && reason !== "overflow") {
        const handoffFocus = AUTO_HANDOFF_THRESHOLD_FOCUS
        const handoffResult = await this.handoff(handoffFocus, {
          autoTriggered: true,
          signal: this.#autoCompactionAbortController.signal,
        })
        if (!handoffResult) {
          const aborted = autoCompactionSignal.aborted
          if (aborted) {
            await this.#emitSessionEvent({
              type: "auto_compaction_end",
              action,
              result: undefined,
              aborted: true,
              willRetry: false,
            })
            return
          }
          logger.warn("Auto-handoff returned no document; falling back to context-full maintenance", {
            reason,
          })
          action = "context-full"
        }
        if (handoffResult) {
          await this.#emitSessionEvent({
            type: "auto_compaction_end",
            action,
            result: undefined,
            aborted: false,
            willRetry: false,
          })
          if (!autoCompactionSignal.aborted && reason !== "idle" && compactionSettings.autoContinue !== false) {
            this.#scheduleAutoContinuePrompt(generation)
          }
          return
        }
      }

      if (!this.model) {
        await this.#emitSessionEvent({
          type: "auto_compaction_end",
          action,
          result: undefined,
          aborted: false,
          willRetry: false,
          skipped: true,
        })
        return
      }

      const availableModels = this.#modelRegistry.getAvailable()
      if (availableModels.length === 0) {
        await this.#emitSessionEvent({
          type: "auto_compaction_end",
          action,
          result: undefined,
          aborted: false,
          willRetry: false,
          skipped: true,
        })
        return
      }

      const pathEntries = this.sessionManager.getBranch()

      const preparation = prepareCompaction(pathEntries, compactionSettings)
      if (!preparation) {
        await this.#emitSessionEvent({
          type: "auto_compaction_end",
          action,
          result: undefined,
          aborted: false,
          willRetry: false,
          skipped: true,
        })
        if (!willRetry && this.agent.hasQueuedMessages()) {
          this.#scheduleAgentContinue({
            delayMs: 100,
            generation,
            shouldContinue: () => this.agent.hasQueuedMessages(),
          })
        }
        return
      }

      let hookCompaction: CompactionResult | undefined
      let fromExtension = false
      let preserveData: Record<string, unknown> | undefined

      if (this.#extensionRunner?.hasHandlers("session_before_compact")) {
        const hookResult = (await this.#extensionRunner.emit({
          type: "session_before_compact",
          preparation,
          branchEntries: pathEntries,
          customInstructions: undefined,
          signal: autoCompactionSignal,
        })) as SessionBeforeCompactResult | undefined

        if (hookResult?.cancel) {
          await this.#emitSessionEvent({
            type: "auto_compaction_end",
            action,
            result: undefined,
            aborted: true,
            willRetry: false,
          })
          return
        }

        if (hookResult?.compaction) {
          hookCompaction = hookResult.compaction
          fromExtension = true
        }
      }

      const compactionPrep = await this.#prepareCompactionFromHooks(preparation, hookCompaction)

      let summary: string
      let shortSummary: string | undefined
      let firstKeptEntryId: string
      let tokensBefore: number
      let details: unknown

      if (compactionPrep.kind === "fromHook") {
        summary = compactionPrep.summary
        shortSummary = compactionPrep.shortSummary
        firstKeptEntryId = compactionPrep.firstKeptEntryId
        tokensBefore = compactionPrep.tokensBefore
        details = compactionPrep.details
        preserveData = compactionPrep.preserveData
      } else {
        const candidates = this.#getCompactionModelCandidates(availableModels)
        const retrySettings = this.settings.getGroup("retry")
        const telemetry = resolveTelemetry(this.agent.telemetry, this.sessionId)
        let compactResult: CompactionResult | undefined
        let lastError: unknown

        for (const candidate of candidates) {
          const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId)
          if (!apiKey) continue

          let attempt = 0
          while (true) {
            try {
              compactResult = await compact(preparation, candidate, apiKey, undefined, autoCompactionSignal, {
                promptOverride: compactionPrep.hookPrompt,
                extraContext: compactionPrep.hookContext,
                remoteInstructions: this.#baseSystemPrompt.join("\n\n"),
                metadata: this.agent.metadataForProvider(candidate.provider),
                initiatorOverride: "agent",
                convertToLlm,
                telemetry,
              })
              break
            } catch (error) {
              if (autoCompactionSignal.aborted) {
                throw error
              }

              const message = error instanceof Error ? error.message : String(error)
              if (this.#isCompactionAuthFailure(error)) {
                lastError = this.#buildCompactionAuthError()
                break
              }
              const retryAfterMs = this.#parseRetryAfterMsFromError(message)
              const shouldRetry =
                retrySettings.enabled &&
                attempt < retrySettings.maxRetries &&
                (retryAfterMs !== undefined || this.#isTransientErrorMessage(message) || isUsageLimitError(message))
              if (!shouldRetry) {
                lastError = error
                break
              }

              const baseDelayMs = retrySettings.baseDelayMs * 2 ** attempt
              const delayMs = retryAfterMs !== undefined ? Math.max(baseDelayMs, retryAfterMs) : baseDelayMs

              // If retry delay is too long (>30s), try next candidate instead of waiting
              const maxAcceptableDelayMs = 30_000
              if (delayMs > maxAcceptableDelayMs) {
                const hasMoreCandidates = candidates.indexOf(candidate) < candidates.length - 1
                if (hasMoreCandidates) {
                  logger.warn("Auto-compaction retry delay too long, trying next model", {
                    delayMs,
                    retryAfterMs,
                    error: message,
                    model: `${candidate.provider}/${candidate.id}`,
                  })
                  lastError = error
                  break // Exit retry loop, continue to next candidate
                }
                // No more candidates - we have to wait
              }

              attempt++
              logger.warn("Auto-compaction failed, retrying", {
                attempt,
                maxRetries: retrySettings.maxRetries,
                delayMs,
                retryAfterMs,
                error: message,
                model: `${candidate.provider}/${candidate.id}`,
              })
              await scheduler.wait(delayMs, { signal: autoCompactionSignal })
            }
          }

          if (compactResult) {
            break
          }
        }

        if (!compactResult) {
          if (lastError) {
            throw lastError
          }
          throw new Error("Compaction failed: no available model")
        }

        summary = compactResult.summary
        shortSummary = compactResult.shortSummary
        firstKeptEntryId = compactResult.firstKeptEntryId
        tokensBefore = compactResult.tokensBefore
        details = compactResult.details
        preserveData = { ...(compactionPrep.preserveData ?? {}), ...(compactResult.preserveData ?? {}) }
      }

      if (autoCompactionSignal.aborted) {
        await this.#emitSessionEvent({
          type: "auto_compaction_end",
          action,
          result: undefined,
          aborted: true,
          willRetry: false,
        })
        return
      }

      this.sessionManager.appendCompaction(
        summary,
        shortSummary,
        firstKeptEntryId,
        tokensBefore,
        details,
        fromExtension,
        preserveData,
      )
      const newEntries = this.sessionManager.getEntries()
      const sessionContext = this.buildDisplaySessionContext()
      this.agent.replaceMessages(sessionContext.messages)
      this.#syncTodoPhasesFromBranch()
      this.#closeCodexProviderSessionsForHistoryRewrite()

      // Get the saved compaction entry for the hook
      const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
        | CompactionEntry
        | undefined

      if (this.#extensionRunner && savedCompactionEntry) {
        await this.#extensionRunner.emit({
          type: "session_compact",
          compactionEntry: savedCompactionEntry,
          fromExtension,
        })
      }

      const result: CompactionResult = {
        summary,
        shortSummary,
        firstKeptEntryId,
        tokensBefore,
        details,
        preserveData,
      }
      await this.#emitSessionEvent({ type: "auto_compaction_end", action, result, aborted: false, willRetry })

      if (!willRetry && reason !== "idle" && compactionSettings.autoContinue !== false) {
        this.#scheduleAutoContinuePrompt(generation)
      }

      if (willRetry) {
        const messages = this.agent.state.messages
        const lastMsg = messages[messages.length - 1]
        if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
          this.agent.replaceMessages(messages.slice(0, -1))
        }

        this.#scheduleAgentContinue({ delayMs: 100, generation })
      } else if (this.agent.hasQueuedMessages()) {
        // Auto-compaction can complete while follow-up/steering/custom messages are waiting.
        // Kick the loop so queued messages are actually delivered.
        this.#scheduleAgentContinue({
          delayMs: 100,
          generation,
          shouldContinue: () => this.agent.hasQueuedMessages(),
        })
      }
    } catch (error) {
      if (autoCompactionSignal.aborted) {
        await this.#emitSessionEvent({
          type: "auto_compaction_end",
          action,
          result: undefined,
          aborted: true,
          willRetry: false,
        })
        return
      }
      const errorMessage = error instanceof Error ? error.message : "compaction failed"
      await this.#emitSessionEvent({
        type: "auto_compaction_end",
        action,
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage:
          reason === "overflow"
            ? `Context overflow recovery failed: ${errorMessage}`
            : `Auto-compaction failed: ${errorMessage}`,
      })
    } finally {
      if (this.#autoCompactionAbortController === autoCompactionAbortController) {
        this.#autoCompactionAbortController = undefined
      }
    }
  }

  /**
   * Toggle auto-compaction setting.
   */
  /** 切换自动压缩开关，启用时若策略为 off 则回退为 context-full */
  setAutoCompactionEnabled(enabled: boolean): void {
    this.settings.set("compaction.enabled", enabled)
    if (enabled && this.settings.get("compaction.strategy") === "off") {
      this.settings.set("compaction.strategy", "context-full")
    }
  }

  /** Whether auto-compaction is enabled */
  /** 自动压缩是否已启用 */
  get autoCompactionEnabled(): boolean {
    return this.settings.get("compaction.enabled") && this.settings.get("compaction.strategy") !== "off"
  }

  // =========================================================================
  // Auto-Retry
  // =========================================================================

  /**
   * Check if an error is retryable (transient errors or usage limits).
   * Context overflow errors are NOT retryable (handled by compaction instead).
   * Usage-limit errors are retryable because the retry handler performs credential switching.
   */
  /** 判断错误是否可重试（瞬态/限流可重试，上下文溢出走压缩而非重试） */
  #isRetryableError(message: AssistantMessage): boolean {
    if (message.stopReason !== "error" || !message.errorMessage) return false

    // Context overflow is handled by compaction, not retry
    const contextWindow = this.model?.contextWindow ?? 0
    if (isContextOverflow(message, contextWindow)) return false

    const err = message.errorMessage
    return this.#isTransientErrorMessage(err) || isUsageLimitError(err)
  }

  /** 判断错误消息是否为瞬态错误（信封或传输层） */
  #isTransientErrorMessage(errorMessage: string): boolean {
    return this.#isTransientEnvelopeErrorMessage(errorMessage) || this.#isTransientTransportErrorMessage(errorMessage)
  }

  /** 判断是否为 Anthropic 流信封在 message_start 前的瞬态失败 */
  #isTransientEnvelopeErrorMessage(errorMessage: string): boolean {
    // Match Anthropic stream-envelope failures that indicate a broken stream before any content starts.
    return /anthropic stream envelope error:/i.test(errorMessage) && /before message_start/i.test(errorMessage)
  }

  /** 判断是否为可重试的传输/限流/网络类错误消息 */
  #isTransientTransportErrorMessage(errorMessage: string): boolean {
    // Match: overloaded_error, provider returned error, rate limit, 429, 500, 502, 503, 504,
    // service unavailable, provider-suggested retry, network/connection/socket errors, fetch failed,
    // terminated, retry delay exceeded
    return (
      isUnexpectedSocketCloseMessage(errorMessage) ||
      /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|retry your request|network.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|timed? out|timeout|terminated|retry delay|stream stall|no error details in response/i.test(
        errorMessage,
      )
    )
  }

  /** 获取配置的重试回退链 */
  #getRetryFallbackChains(): RetryFallbackChains {
    const configuredChains = this.settings.get("retry.fallbackChains")
    if (!configuredChains || typeof configuredChains !== "object") return {}
    return configuredChains as RetryFallbackChains
  }

  /** 验证回退链配置格式与模型引用，无效项写入 configWarnings */
  #validateRetryFallbackChains(): void {
    const configuredChains = this.settings.get("retry.fallbackChains")
    if (configuredChains === undefined) return
    if (!configuredChains || typeof configuredChains !== "object" || Array.isArray(configuredChains)) {
      const msg = "retry.fallbackChains must be a mapping of role names to selector arrays."
      logger.warn(msg)
      this.configWarnings.push(msg)
      return
    }

    for (const [role, chain] of Object.entries(configuredChains)) {
      if (!Array.isArray(chain)) {
        const msg = `Fallback chain for role '${role}' must be an array of selector strings.`
        logger.warn(msg)
        this.configWarnings.push(msg)
        continue
      }
      for (const selectorStr of chain) {
        if (typeof selectorStr !== "string") {
          const msg = `Fallback chain for role '${role}' contains a non-string selector.`
          logger.warn(msg)
          this.configWarnings.push(msg)
          continue
        }
        const parsed = parseRetryFallbackSelector(selectorStr)
        if (!parsed) {
          const msg = `Invalid fallback selector format in role '${role}': ${selectorStr}`
          logger.warn(msg)
          this.configWarnings.push(msg)
          continue
        }
        const exists = this.#modelRegistry.find(parsed.provider, parsed.id)
        if (!exists) {
          const msg = `Fallback chain for role '${role}' references unknown model: ${selectorStr}`
          logger.warn(msg)
          this.configWarnings.push(msg)
        }
      }
    }
  }

  /** 获取重试回退恢复策略 */
  #getRetryFallbackRevertPolicy(): RetryFallbackRevertPolicy {
    return this.settings.get("retry.fallbackRevertPolicy") === "never" ? "never" : "cooldown-expiry"
  }

  /** 获取角色的主模型回退选择器 */
  #getRetryFallbackPrimarySelector(role: string): RetryFallbackSelector | undefined {
    const configuredSelector = this.settings.getModelRole(role)
    return configuredSelector ? parseRetryFallbackSelector(configuredSelector) : undefined
  }

  /** 清除活跃重试回退状态 */
  #clearActiveRetryFallback(): void {
    this.#activeRetryFallback = undefined
  }

  /** 判断回退选择器是否处于冷却抑制期 */
  #isRetryFallbackSelectorSuppressed(selector: RetryFallbackSelector): boolean {
    return this.#modelRegistry.isSelectorSuppressed(selector.raw)
  }

  /** 记录回退选择器冷却时间（来自 retry-after 或限流原因推算） */
  #noteRetryFallbackCooldown(currentSelector: string, retryAfterMs: number | undefined, errorMessage: string): void {
    let cooldownMs = retryAfterMs
    if (!cooldownMs || cooldownMs <= 0) {
      const reason = parseRateLimitReason(errorMessage)
      cooldownMs = reason === "UNKNOWN" ? 5 * 60 * 1000 : calculateRateLimitBackoffMs(reason)
    }
    this.#modelRegistry.suppressSelector(currentSelector, Date.now() + cooldownMs)
  }

  /** 根据当前选择器反查其所属的回退链角色名 */
  #resolveRetryFallbackRole(currentSelector: string): string | undefined {
    const parsedCurrent = parseRetryFallbackSelector(currentSelector)
    if (!parsedCurrent) return undefined
    const currentBaseSelector = formatRetryFallbackBaseSelector(parsedCurrent)
    for (const role of Object.keys(this.#getRetryFallbackChains())) {
      const primarySelector = this.#getRetryFallbackPrimarySelector(role)
      if (!primarySelector) continue
      if (primarySelector.raw === currentSelector) return role
      if (formatRetryFallbackBaseSelector(primarySelector) === currentBaseSelector) return role
    }
    return undefined
  }

  /** 获取角色的有效回退链（主模型 + 配置的 fallback 列表，去重） */
  #getRetryFallbackEffectiveChain(role: string): RetryFallbackSelector[] {
    const primarySelector = this.#getRetryFallbackPrimarySelector(role)
    if (!primarySelector) return []
    const chain = [primarySelector]
    const seen = new Set<string>([primarySelector.raw])
    for (const selector of this.#getRetryFallbackChains()[role] ?? []) {
      const parsed = parseRetryFallbackSelector(selector)
      if (!parsed || seen.has(parsed.raw)) continue
      seen.add(parsed.raw)
      chain.push(parsed)
    }
    return chain
  }

  /** 查找当前选择器之后的回退候选列表 */
  #findRetryFallbackCandidates(role: string, currentSelector: string): RetryFallbackSelector[] {
    const chain = this.#getRetryFallbackEffectiveChain(role)
    if (chain.length <= 1) return []
    const parsedCurrent = parseRetryFallbackSelector(currentSelector)
    const currentBaseSelector = parsedCurrent ? formatRetryFallbackBaseSelector(parsedCurrent) : undefined
    const exactIndex = chain.findIndex((selector) => selector.raw === currentSelector)
    if (exactIndex >= 0) return chain.slice(exactIndex + 1)
    const baseIndex = currentBaseSelector
      ? chain.findIndex((selector) => formatRetryFallbackBaseSelector(selector) === currentBaseSelector)
      : -1
    if (baseIndex >= 0) return chain.slice(baseIndex + 1)
    return chain.slice(1)
  }

  /** 应用回退候选模型并记录活跃回退状态 */
  async #applyRetryFallbackCandidate(
    role: string,
    selector: RetryFallbackSelector,
    currentSelector: string,
  ): Promise<void> {
    const candidate = this.#modelRegistry.find(selector.provider, selector.id)
    if (!candidate) {
      throw new Error(`Retry fallback model not found: ${selector.raw}`)
    }
    const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId)
    if (!apiKey) {
      throw new Error(`No API key for retry fallback ${selector.raw}`)
    }

    const currentThinkingLevel = this.thinkingLevel
    const nextThinkingLevel = selector.thinkingLevel ?? currentThinkingLevel

    this.#setModelWithProviderSessionReset(candidate)
    this.sessionManager.appendModelChange(`${candidate.provider}/${candidate.id}`, "temporary")
    this.settings.getStorage()?.recordModelUsage(`${candidate.provider}/${candidate.id}`)
    this.setThinkingLevel(nextThinkingLevel)
    if (!this.#activeRetryFallback) {
      this.#activeRetryFallback = {
        role,
        originalSelector: currentSelector,
        originalThinkingLevel: currentThinkingLevel,
        lastAppliedFallbackThinkingLevel: nextThinkingLevel,
      }
    } else {
      this.#activeRetryFallback.lastAppliedFallbackThinkingLevel = nextThinkingLevel
    }
    await this.#emitSessionEvent({
      type: "retry_fallback_applied",
      from: currentSelector,
      to: selector.raw,
      role,
    })
  }

  /** 尝试模型回退链中的下一个可用候选 */
  async #tryRetryModelFallback(currentSelector: string): Promise<boolean> {
    const role = this.#activeRetryFallback?.role ?? this.#resolveRetryFallbackRole(currentSelector)
    if (!role) return false

    for (const selector of this.#findRetryFallbackCandidates(role, currentSelector)) {
      if (this.#isRetryFallbackSelectorSuppressed(selector)) continue
      const candidate = this.#modelRegistry.find(selector.provider, selector.id)
      if (!candidate) continue
      const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId)
      if (!apiKey) continue
      await this.#applyRetryFallbackCandidate(role, selector, currentSelector)
      return true
    }

    return false
  }

  /** 冷却期过后尝试恢复主模型（cooldown-expiry 策略） */
  async #maybeRestoreRetryFallbackPrimary(): Promise<void> {
    if (!this.#activeRetryFallback) return
    if (this.#getRetryFallbackRevertPolicy() !== "cooldown-expiry") return

    const {
      originalSelector: originalSelectorRaw,
      originalThinkingLevel,
      lastAppliedFallbackThinkingLevel,
    } = this.#activeRetryFallback
    const originalSelector = parseRetryFallbackSelector(originalSelectorRaw)
    if (!originalSelector) {
      this.#clearActiveRetryFallback()
      return
    }

    const currentModel = this.model
    if (!currentModel) return
    const currentSelector = formatRetryFallbackSelector(currentModel, this.thinkingLevel)
    if (currentSelector === originalSelector.raw) {
      if (!this.#isRetryFallbackSelectorSuppressed(originalSelector)) {
        this.#clearActiveRetryFallback()
      }
      return
    }
    if (this.#isRetryFallbackSelectorSuppressed(originalSelector)) return

    const primaryModel = this.#modelRegistry.find(originalSelector.provider, originalSelector.id)
    if (!primaryModel) return
    const apiKey = await this.#modelRegistry.getApiKey(primaryModel, this.sessionId)
    if (!apiKey) return

    const currentThinkingLevel = this.thinkingLevel
    const thinkingToApply =
      currentThinkingLevel === lastAppliedFallbackThinkingLevel ? originalThinkingLevel : currentThinkingLevel
    this.#setModelWithProviderSessionReset(primaryModel)
    this.sessionManager.appendModelChange(`${primaryModel.provider}/${primaryModel.id}`, "temporary")
    this.settings.getStorage()?.recordModelUsage(`${primaryModel.provider}/${primaryModel.id}`)
    this.setThinkingLevel(thinkingToApply)
    this.#clearActiveRetryFallback()
  }

  /** 从错误消息中解析 retry-after 延迟毫秒数 */
  #parseRetryAfterMsFromError(errorMessage: string): number | undefined {
    const now = Date.now()
    const retryAfterMsMatch = /retry-after-ms\s*[:=]\s*(\d+)/i.exec(errorMessage)
    if (retryAfterMsMatch) {
      return Math.max(0, Number(retryAfterMsMatch[1]))
    }

    const retryAfterMatch = /retry-after\s*[:=]\s*([^\s,;]+)/i.exec(errorMessage)
    if (retryAfterMatch) {
      const value = retryAfterMatch[1]
      const seconds = Number(value)
      if (!Number.isNaN(seconds)) {
        return Math.max(0, seconds * 1000)
      }
      const dateMs = Date.parse(value)
      if (!Number.isNaN(dateMs)) {
        return Math.max(0, dateMs - now)
      }
    }

    const resetMsMatch = /x-ratelimit-reset-ms\s*[:=]\s*(\d+)/i.exec(errorMessage)
    if (resetMsMatch) {
      const resetMs = Number(resetMsMatch[1])
      if (!Number.isNaN(resetMs)) {
        if (resetMs > 1_000_000_000_000) {
          return Math.max(0, resetMs - now)
        }
        return Math.max(0, resetMs)
      }
    }

    const resetMatch = /x-ratelimit-reset\s*[:=]\s*(\d+)/i.exec(errorMessage)
    if (resetMatch) {
      const resetSeconds = Number(resetMatch[1])
      if (!Number.isNaN(resetSeconds)) {
        if (resetSeconds > 1_000_000_000) {
          return Math.max(0, resetSeconds * 1000 - now)
        }
        return Math.max(0, resetSeconds * 1000)
      }
    }

    // Smart Fallback if no exact headers found
    return undefined
  }

  /**
   * Handle retryable errors with exponential backoff.
   * @returns true if retry was initiated, false if max retries exceeded or disabled
   */
  /** 处理可重试错误：指数退避、模型回退链，超限后停止 */
  async #handleRetryableError(message: AssistantMessage): Promise<boolean> {
    const retrySettings = this.settings.getGroup("retry")
    if (!retrySettings.enabled) return false

    const generation = this.#promptGeneration
    this.#retryAttempt++

    // Create retry promise on first attempt so waitForRetry() can await it
    // Ensure only one promise exists (avoid orphaned promises from concurrent calls)
    if (!this.#retryPromise) {
      const { promise, resolve } = Promise.withResolvers<void>()
      this.#retryPromise = promise
      this.#retryResolve = resolve
    }

    if (this.#retryAttempt > retrySettings.maxRetries) {
      // Max retries exceeded, emit final failure and reset
      await this.#emitSessionEvent({
        type: "auto_retry_end",
        success: false,
        attempt: this.#retryAttempt - 1,
        finalError: message.errorMessage,
      })
      this.#retryAttempt = 0
      this.#resolveRetry() // Resolve so waitForRetry() completes
      return false
    }

    const errorMessage = message.errorMessage || "Unknown error"
    const parsedRetryAfterMs = this.#parseRetryAfterMsFromError(errorMessage)
    let delayMs = retrySettings.baseDelayMs * 2 ** (this.#retryAttempt - 1)
    let switchedCredential = false
    let switchedModel = false

    if (this.model && isUsageLimitError(errorMessage)) {
      const retryAfterMs = parsedRetryAfterMs ?? calculateRateLimitBackoffMs(parseRateLimitReason(errorMessage))
      const switched = await this.#modelRegistry.authStorage.markUsageLimitReached(
        this.model.provider,
        this.sessionId,
        {
          retryAfterMs,
          baseUrl: this.model.baseUrl,
        },
      )
      if (switched) {
        switchedCredential = true
        delayMs = 0
      } else if (retryAfterMs > delayMs) {
        // No more accounts to switch to — wait out the backoff
        delayMs = retryAfterMs
      }
    }

    const currentSelector = this.model ? formatRetryFallbackSelector(this.model, this.thinkingLevel) : undefined
    if (!switchedCredential && currentSelector) {
      this.#noteRetryFallbackCooldown(currentSelector, parsedRetryAfterMs, errorMessage)
      switchedModel = await this.#tryRetryModelFallback(currentSelector)
      if (switchedModel) {
        delayMs = 0
      } else if (parsedRetryAfterMs && parsedRetryAfterMs > delayMs) {
        delayMs = parsedRetryAfterMs
      }
    }

    await this.#emitSessionEvent({
      type: "auto_retry_start",
      attempt: this.#retryAttempt,
      maxAttempts: retrySettings.maxRetries,
      delayMs,
      errorMessage,
    })

    // Remove error message from agent state (keep in session for history)
    const messages = this.agent.state.messages
    if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
      this.agent.replaceMessages(messages.slice(0, -1))
    }

    // Wait with exponential backoff (abortable).
    const retryAbortController = new AbortController()
    this.#retryAbortController?.abort()
    this.#retryAbortController = retryAbortController
    try {
      await scheduler.wait(delayMs, { signal: retryAbortController.signal })
    } catch {
      if (this.#retryAbortController !== retryAbortController) {
        return false
      }
      // Aborted during sleep - emit end event so UI can clean up
      const attempt = this.#retryAttempt
      this.#retryAttempt = 0
      this.#retryAbortController = undefined
      await this.#emitSessionEvent({
        type: "auto_retry_end",
        success: false,
        attempt,
        finalError: "Retry cancelled",
      })
      this.#resolveRetry()
      return false
    }
    if (this.#retryAbortController === retryAbortController) {
      this.#retryAbortController = undefined
    }

    // Retry via continue() outside the agent_end event callback chain.
    this.#scheduleAgentContinue({ delayMs: 1, generation })

    return true
  }

  /**
   * Cancel in-progress retry.
   */
  /** 取消正在进行的自动重试 */
  abortRetry(): void {
    this.#retryAbortController?.abort()
    // Note: _retryAttempt is reset in the catch block of _autoRetry
    this.#resolveRetry()
  }

  /** 等待 Agent 空闲后重新提示，遇 AgentBusyError 则轮询直至超时 */
  async #promptAgentWithIdleRetry(messages: AgentMessage[], options?: { toolChoice?: ToolChoice }): Promise<void> {
    const deadline = Date.now() + 30_000
    for (;;) {
      try {
        await this.agent.prompt(messages, options)
        return
      } catch (err) {
        if (!(err instanceof AgentBusyError)) {
          throw err
        }
        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting for prior agent run to finish before prompting.")
        }
        await this.agent.waitForIdle()
      }
    }
  }

  /** Whether auto-retry is currently in progress */
  /** 自动重试是否正在进行 */
  get isRetrying(): boolean {
    return this.#retryPromise !== undefined
  }

  /** Whether auto-retry is enabled */
  /** 自动重试是否已启用 */
  get autoRetryEnabled(): boolean {
    return this.settings.get("retry.enabled") ?? true
  }

  /**
   * Toggle auto-retry setting.
   */
  /** 切换自动重试开关 */
  setAutoRetryEnabled(enabled: boolean): void {
    this.settings.set("retry.enabled", enabled)
  }
  /**
   * Manually retry the last failed assistant turn.
   * Removes the error message from agent state and re-attempts with a fresh retry budget.
   * @returns true if retry was initiated, false if no failed turn to retry or agent is busy
   */
  /** 手动重试上一轮失败的助手回合，移除错误消息后重新调度 */
  async retry(): Promise<boolean> {
    if (this.isStreaming || this.isCompacting || this.isRetrying) return false

    const messages = this.agent.state.messages
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.role !== "assistant") return false

    const assistantMsg = lastMsg as AssistantMessage
    if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted") return false

    // Remove the failed/aborted assistant message (same as auto-retry does before re-attempting)
    this.agent.replaceMessages(messages.slice(0, -1))

    // Reset retry budget for a fresh attempt
    this.#retryAttempt = 0

    // Re-attempt the turn
    this.#scheduleAgentContinue({ delayMs: 1 })

    return true
  }

  // =========================================================================
  // Bash Execution
  // =========================================================================

  /** 保存 bash 原始输出 artifact 并返回路径 */
  async #saveBashOriginalArtifact(originalText: string): Promise<string | undefined> {
    try {
      return await this.sessionManager.saveArtifact(originalText, "bash-original")
    } catch {
      return undefined
    }
  }

  /**
   * Execute a bash command.
   * Adds result to agent context and session.
   * @param command The bash command to execute
   * @param onChunk Optional streaming callback for output
   * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
   */
  /** 执行 bash 命令并将结果写入 Agent 上下文与会话历史 */
  async executeBash(
    command: string,
    onChunk?: (chunk: string) => void,
    options?: { excludeFromContext?: boolean },
  ): Promise<BashResult> {
    const excludeFromContext = options?.excludeFromContext === true
    const cwd = this.sessionManager.getCwd()

    if (this.#extensionRunner?.hasHandlers("user_bash")) {
      const hookResult = await this.#extensionRunner.emitUserBash({
        type: "user_bash",
        command,
        excludeFromContext,
        cwd,
      })
      if (hookResult?.result) {
        this.recordBashResult(command, hookResult.result, options)
        return hookResult.result
      }
    }

    const abortController = new AbortController()
    this.#bashAbortControllers.add(abortController)

    try {
      const result = await executeBashCommand(command, {
        onChunk,
        signal: abortController.signal,
        sessionKey: this.sessionId,
        timeout: clampTimeout("bash") * 1000,
        onMinimizedSave: (originalText) => this.#saveBashOriginalArtifact(originalText),
      })

      this.recordBashResult(command, result, options)
      return result
    } finally {
      this.#bashAbortControllers.delete(abortController)
    }
  }

  /**
   * Record a bash execution result in session history.
   * Used by executeBash and by extensions that handle bash execution themselves.
   */
  /** 将 bash 执行结果记录到会话历史（供 executeBash 或扩展自行执行后调用） */
  recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
    const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get()
    const bashMessage: BashExecutionMessage = {
      role: "bashExecution",
      command,
      output: result.output,
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      truncated: result.truncated,
      meta,
      timestamp: Date.now(),
      excludeFromContext: options?.excludeFromContext,
    }

    // If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
    if (this.isStreaming) {
      // Queue for later - will be flushed on agent_end
      this.#pendingBashMessages.push(bashMessage)
    } else {
      // Add to agent state immediately
      this.agent.appendMessage(bashMessage)

      // Save to session
      this.sessionManager.appendMessage(bashMessage)
    }
  }

  /**
   * Cancel running bash command.
   */
  /** 中止正在运行的 bash 命令 */
  abortBash(): void {
    for (const abortController of this.#bashAbortControllers) {
      abortController.abort()
    }
  }

  /** Whether a bash command is currently running */
  /** bash 命令是否正在执行 */
  get isBashRunning(): boolean {
    return this.#bashAbortControllers.size > 0
  }

  /** Whether there are pending bash messages waiting to be flushed */
  /** 是否有待刷新的 bash 消息（流式期间排队） */
  get hasPendingBashMessages(): boolean {
    return this.#pendingBashMessages.length > 0
  }

  /**
   * Flush pending bash messages to agent state and session.
   * Called after agent turn completes to maintain proper message ordering.
   */
  /** 将排队的 bash 消息刷入 Agent 状态与会话（回合结束后保持消息顺序） */
  #flushPendingBashMessages(): void {
    if (this.#pendingBashMessages.length === 0) return

    for (const bashMessage of this.#pendingBashMessages) {
      // Add to agent state
      this.agent.appendMessage(bashMessage)

      // Save to session
      this.sessionManager.appendMessage(bashMessage)
    }

    this.#pendingBashMessages = []
  }

  // =========================================================================
  // User-Initiated Python Execution
  // =========================================================================

  /**
   * Execute Python code in the shared kernel.
   * Uses the same kernel session as eval's Python backend, allowing collaborative editing.
   * @param code The Python code to execute
   * @param onChunk Optional streaming callback for output
   * @param options.excludeFromContext If true, execution won't be sent to LLM ($$ prefix)
   */
  /** 在共享内核中执行 Python 代码（与 eval 后端共用内核会话） */
  async executePython(
    code: string,
    onChunk?: (chunk: string) => void,
    options?: { excludeFromContext?: boolean },
  ): Promise<PythonResult> {
    const excludeFromContext = options?.excludeFromContext === true
    const cwd = this.sessionManager.getCwd()
    this.assertEvalExecutionAllowed()

    const abortController = new AbortController()
    const execution = (async (): Promise<PythonResult> => {
      if (this.#extensionRunner?.hasHandlers("user_python")) {
        const hookResult = await this.#extensionRunner.emitUserPython({
          type: "user_python",
          code,
          excludeFromContext,
          cwd,
        })
        this.assertEvalExecutionAllowed()
        if (hookResult?.result) {
          this.recordPythonResult(code, hookResult.result, options)
          return hookResult.result
        }
      }

      // Use the same session ID as eval's Python backend for kernel sharing
      const sessionFile = this.sessionManager.getSessionFile()
      const sessionId = sessionFile ? `session:${sessionFile}:cwd:${cwd}` : `cwd:${cwd}`
      const result = await executePythonCommand(code, {
        cwd,
        sessionId,
        kernelOwnerId: this.#evalKernelOwnerId,
        kernelMode: this.settings.get("python.kernelMode"),
        onChunk,
        signal: abortController.signal,
      })
      this.recordPythonResult(code, result, options)
      return result
    })()
    return await this.trackEvalExecution(execution, abortController)
  }

  /** 断言 Python 执行允许（设置与能力检查） */
  assertEvalExecutionAllowed(): void {
    if (this.#evalExecutionDisposing) {
      throw new Error("Python execution is unavailable while session disposal is in progress")
    }
  }

  /**
   * Track Python work started outside AgentSession.executePython so dispose can await and abort it too.
   */
  /** 追踪外部发起的 Python 执行，以便 dispose 时可中止并等待结束 */
  trackEvalExecution<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
    this.#evalAbortControllers.add(abortController)
    this.#activeEvalExecutions.add(execution)
    void execution.then(
      () => {
        this.#evalAbortControllers.delete(abortController)
        this.#activeEvalExecutions.delete(execution)
      },
      () => {
        this.#evalAbortControllers.delete(abortController)
        this.#activeEvalExecutions.delete(execution)
      },
    )
    return execution
  }

  /**
   * Record a Python execution result in session history.
   */
  /** 将 Python 执行结果记录到会话历史 */
  recordPythonResult(code: string, result: PythonResult, options?: { excludeFromContext?: boolean }): void {
    const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get()
    const pythonMessage: PythonExecutionMessage = {
      role: "pythonExecution",
      code,
      output: result.output,
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      truncated: result.truncated,
      meta,
      timestamp: Date.now(),
      excludeFromContext: options?.excludeFromContext,
    }

    // If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
    if (this.isStreaming) {
      this.#pendingPythonMessages.push(pythonMessage)
    } else {
      this.agent.appendMessage(pythonMessage)
      this.sessionManager.appendMessage(pythonMessage)
    }
  }

  /**
   * Cancel running Python execution.
   */
  /** 中止正在运行的 Python 执行 */
  abortEval(): void {
    for (const abortController of this.#evalAbortControllers) {
      abortController.abort()
    }
  }

  /** 等待所有 Python 执行完成或超时 */
  async #waitForEvalExecutionsToSettle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.#activeEvalExecutions.size > 0) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        return false
      }
      const settled = await Promise.race([
        Promise.allSettled(Array.from(this.#activeEvalExecutions)).then(() => true),
        Bun.sleep(remainingMs).then(() => false),
      ])
      if (!settled && this.#activeEvalExecutions.size > 0) {
        return false
      }
    }
    return true
  }

  /** dispose 前等待或中止 Python 执行，为释放保留内核做准备 */
  async #prepareEvalExecutionsForDispose(): Promise<boolean> {
    if (!(await this.#waitForEvalExecutionsToSettle(3_000))) {
      logger.warn("Aborting active Python execution during dispose before retained kernel cleanup")
      this.abortEval()
      if (!(await this.#waitForEvalExecutionsToSettle(1_000))) {
        logger.warn(
          "Python execution is still active after dispose aborted all active runs; retained kernel ownership will still be detached",
        )
        return false
      }
    }
    return true
  }

  /** Whether a Python execution is currently running */
  /** Python 执行是否正在进行 */
  get isEvalRunning(): boolean {
    return this.#evalAbortControllers.size > 0
  }

  /** Whether there are pending Python messages waiting to be flushed */
  /** 是否有待刷新的 Python 消息 */
  get hasPendingPythonMessages(): boolean {
    return this.#pendingPythonMessages.length > 0
  }

  /**
   * Flush pending Python messages to agent state and session.
   */
  /** 将排队的 Python 消息刷入 Agent 状态与会话 */
  #flushPendingPythonMessages(): void {
    if (this.#pendingPythonMessages.length === 0) return

    for (const pythonMessage of this.#pendingPythonMessages) {
      this.agent.appendMessage(pythonMessage)
      this.sessionManager.appendMessage(pythonMessage)
    }

    this.#pendingPythonMessages = []
  }

  // =========================================================================
  // Background-Channel IRC Exchanges
  // =========================================================================

  /**
   * Generate an ephemeral reply to a background message (e.g. an IRC ping from
   * another agent) using this session's current model + system prompt + history.
   *
   * The reply is computed via a side-channel `streamSimple` call (analogous to
   * `/btw`) so it never blocks on the recipient's in-flight tool calls.  After
   * the reply is generated, both the incoming question and the auto-reply are
   * queued for injection into the recipient's persisted history so the model
   * sees the exchange on its next turn.  Injection happens immediately when the
   * session is idle, otherwise it is deferred until streaming ends.
   */
  /** 为背景消息（如 IRC）生成临时回复，侧信道流式生成后注入持久化历史 */
  async respondAsBackground(args: {
    from: string
    message: string
    awaitReply?: boolean
    signal?: AbortSignal
  }): Promise<{ replyText: string | null }> {
    const awaitReply = args.awaitReply !== false
    const incomingTimestamp = Date.now()
    const incomingRecord: CustomMessage = {
      role: "custom",
      customType: "irc:incoming",
      content: `[IRC \`${args.from}\` → you]\n\n${args.message}`,
      display: true,
      details: { from: args.from, message: args.message },
      attribution: "agent",
      timestamp: incomingTimestamp,
    }
    void this.#emitSessionEvent({ type: "irc_message", message: incomingRecord })
    this.#forwardIrcRelayToMain({
      from: args.from,
      to: this.#agentId ?? "?",
      body: args.message,
      kind: "message",
      timestamp: incomingTimestamp,
    })

    if (!awaitReply) {
      this.#queueBackgroundExchangeInjection([incomingRecord])
      return { replyText: null }
    }

    const incomingPrompt = prompt.render(ircIncomingTemplate, {
      from: args.from,
      message: args.message,
    })
    const { replyText } = await this.runEphemeralTurn({
      promptText: incomingPrompt,
      signal: args.signal,
    })

    const replyRecord: CustomMessage = {
      role: "custom",
      customType: "irc:autoreply",
      content: `[IRC you → \`${args.from}\` (auto)]\n\n${replyText}`,
      display: true,
      details: { to: args.from, reply: replyText },
      attribution: "agent",
      timestamp: Date.now(),
    }
    void this.#emitSessionEvent({ type: "irc_message", message: replyRecord })
    this.#forwardIrcRelayToMain({
      from: this.#agentId ?? "?",
      to: args.from,
      body: replyText,
      kind: "reply",
      timestamp: replyRecord.timestamp,
    })
    this.#queueBackgroundExchangeInjection([incomingRecord, replyRecord])

    return { replyText }
  }

  /**
   * Forward an IRC exchange observation to the main agent's session UI so the
   * user can see every IRC conversation in the main transcript, even when the
   * main agent is not a direct participant. The relay record is display-only:
   * it is NOT injected into the main agent's persisted history.
   */
  /** 将 IRC 交换转发到主 agent 的 UI（仅展示，不写入主会话持久化历史） */
  #forwardIrcRelayToMain(args: {
    from: string
    to: string
    body: string
    kind: "message" | "reply"
    timestamp: number
  }): void {
    const registry = this.#agentRegistry
    if (!registry) return
    // If this session is the main agent, the local emit already reached the main UI.
    if (this.#agentId === MAIN_AGENT_ID) return
    const mainRef = registry.get(MAIN_AGENT_ID)
    const mainSession = mainRef?.session
    if (!mainSession || mainSession === this) return
    const arrow = args.kind === "reply" ? "→ (auto)" : "→"
    const relayRecord: CustomMessage = {
      role: "custom",
      customType: "irc:relay",
      content: `[IRC \`${args.from}\` ${arrow} \`${args.to}\`]\n\n${args.body}`,
      display: true,
      details: { from: args.from, to: args.to, body: args.body, kind: args.kind },
      attribution: "agent",
      timestamp: args.timestamp,
    }
    mainSession.emitIrcRelayObservation(relayRecord)
  }

  /**
   * Emit an IRC relay observation event on this session for UI rendering only.
   * Does not persist the record to history. Public so other sessions can forward.
   */
  /** 发出 IRC 中继观察事件（仅 UI 渲染，不持久化；供其他会话转发） */
  emitIrcRelayObservation(record: CustomMessage): void {
    void this.#emitSessionEvent({ type: "irc_message", message: record })
  }

  /**
   * Run a single ephemeral side-channel turn against this session's current
   * model + system prompt + history.  No tools are used; the side request
   * does not block on, or interfere with, any in-flight main turn.  The
   * session's history and persisted state are NOT modified by this call.
   *
   * Used by `respondAsBackground` (IRC) and `BtwController` (`/btw`) to share
   * the snapshot + stream pipeline.  The snapshot includes any in-flight
   * streaming assistant text so the model sees the half-finished response
   * rather than missing context.
   */
  /** 执行临时侧信道回合（不修改会话历史，供 IRC/Btw 等共享快照管线） */
  async runEphemeralTurn(args: {
    promptText: string
    onTextDelta?: (delta: string) => void
    signal?: AbortSignal
  }): Promise<{ replyText: string; assistantMessage: AssistantMessage }> {
    const model = this.model
    if (!model) {
      throw new Error("No active model on session")
    }
    const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId)
    if (!apiKey) {
      throw new Error(`No API key for ${model.provider}/${model.id}`)
    }

    const snapshot = this.#buildEphemeralSnapshot(args.promptText)
    const llmMessages = await this.convertMessagesToLlm(snapshot, args.signal)
    const context: Context = {
      systemPrompt: this.systemPrompt,
      messages: llmMessages,
    }
    const options = this.prepareSimpleStreamOptions(
      {
        apiKey,
        sessionId: this.sessionId,
        reasoning: toReasoningEffort(this.thinkingLevel),
        hideThinkingSummary: this.agent.hideThinkingSummary,
        serviceTier: this.serviceTier,
        signal: args.signal,
        toolChoice: "none",
      },
      model.provider,
    )

    let replyText = ""
    let assistantMessage: AssistantMessage | undefined
    const stream = streamSimple(model, context, options)
    for await (const event of stream) {
      if (event.type === "text_delta") {
        replyText += event.delta
        if (args.onTextDelta) args.onTextDelta(event.delta)
        continue
      }
      if (event.type === "done") {
        assistantMessage = event.message
        break
      }
      if (event.type === "error") {
        throw new Error(event.error.errorMessage || "Ephemeral turn failed")
      }
    }

    if (!assistantMessage) {
      throw new Error("Ephemeral turn ended without a final message")
    }
    return { replyText: replyText.trim(), assistantMessage }
  }

  /**
   * Build a message snapshot for an ephemeral side-channel turn.  Includes
   * the in-flight streaming assistant message (if any) so the model sees
   * the partial response in context, then appends the prompt as a virtual
   * user message.
   */
  /** 构建临时回合的消息快照（含流式中的助手文本 + 虚拟用户提示） */
  #buildEphemeralSnapshot(promptText: string): AgentMessage[] {
    const messages = [...this.messages]
    const streaming = this.agent.state.streamMessage
    if (streaming && streaming.role === "assistant") {
      const streamingText = streaming.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("")
      if (streamingText) {
        const normalized: AssistantMessage = {
          ...streaming,
          content: [{ type: "text", text: streamingText }],
        }
        const lastMessage = messages.at(-1)
        if (lastMessage?.role === "assistant") {
          messages[messages.length - 1] = normalized
        } else {
          messages.push(normalized)
        }
      }
    }
    messages.push({
      role: "user",
      content: [{ type: "text", text: promptText }],
      attribution: "agent",
      timestamp: Date.now(),
    })
    return messages
  }

  /** 入队后台交换消息；空闲时立即刷入，流式中则延迟刷出 */
  #queueBackgroundExchangeInjection(messages: CustomMessage[]): void {
    this.#pendingBackgroundExchanges.push(messages)
    if (!this.isStreaming) {
      this.#flushPendingBackgroundExchanges()
      return
    }
    this.#scheduleBackgroundExchangeFlush()
  }

  /** 调度后台交换刷入（轮询直至流式结束） */
  #scheduleBackgroundExchangeFlush(): void {
    if (this.#scheduledBackgroundExchangeFlush) return
    this.#scheduledBackgroundExchangeFlush = true
    const attempt = (): void => {
      if (this.#pendingBackgroundExchanges.length === 0 || this.#isDisposed) {
        this.#pendingBackgroundExchanges = []
        this.#scheduledBackgroundExchangeFlush = false
        return
      }
      if (this.isStreaming) {
        setTimeout(attempt, 50)
        return
      }
      this.#scheduledBackgroundExchangeFlush = false
      this.#flushPendingBackgroundExchanges()
    }
    setTimeout(attempt, 0)
  }

  /** 将待处理的后台交换批量注入 Agent 状态与持久化历史 */
  #flushPendingBackgroundExchanges(): void {
    if (this.#pendingBackgroundExchanges.length === 0) return
    const batches = this.#pendingBackgroundExchanges
    this.#pendingBackgroundExchanges = []
    for (const batch of batches) {
      for (const msg of batch) {
        // emitExternalEvent on message_end appends to agent state and dispatches
        // to all session listeners, which in turn handle TUI rendering and
        // sessionManager persistence via #handleAgentEvent.
        this.agent.emitExternalEvent({ type: "message_start", message: msg })
        this.agent.emitExternalEvent({ type: "message_end", message: msg })
      }
    }
  }

  // =========================================================================
  // Session Management
  // =========================================================================

  /**
   * Reload the current session from disk.
   *
   * Intended for extension commands and headless modes to re-read the current session
   * file and re-emit session_switch hooks.
   */
  /** 从磁盘重新加载当前会话 */
  async reload(): Promise<void> {
    const sessionFile = this.sessionFile
    if (!sessionFile) return
    await this.switchSession(sessionFile)
  }

  /**
   * Switch to a different session file.
   * Aborts current operation, loads messages, restores model/thinking.
   * Listeners are preserved and will continue receiving events.
   * @returns true if switch completed, false if cancelled by hook
   */
  /** 切换到不同的会话文件；中止当前操作并恢复模型/思维等级，监听器保留 */
  async switchSession(sessionPath: string): Promise<boolean> {
    const previousSessionFile = this.sessionManager.getSessionFile()
    const switchingToDifferentSession = previousSessionFile
      ? path.resolve(previousSessionFile) !== path.resolve(sessionPath)
      : true
    // Emit session_before_switch event (can be cancelled)
    if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
      const result = (await this.#extensionRunner.emit({
        type: "session_before_switch",
        reason: "resume",
        targetSessionFile: sessionPath,
      })) as SessionBeforeSwitchResult | undefined

      if (result?.cancel) {
        return false
      }
    }

    this.#disconnectFromAgent()
    await this.abort()

    // Flush pending writes before switching so restore snapshots reflect committed state.
    await this.sessionManager.flush()
    const previousSessionState = this.sessionManager.captureState()
    const previousSessionContext = this.buildDisplaySessionContext()
    // switchSession replaces these arrays wholesale during load/rollback, so retaining
    // the existing message objects is sufficient and avoids structured-clone failures for
    // extension/custom metadata that is valid to persist but not cloneable.
    const previousAgentMessages = [...this.agent.state.messages]
    const previousSteeringMessages = [...this.#steeringMessages]
    const previousFollowUpMessages = [...this.#followUpMessages]
    const previousPendingNextTurnMessages = [...this.#pendingNextTurnMessages]
    const previousScheduledHiddenNextTurnGeneration = this.#scheduledHiddenNextTurnGeneration
    const previousModel = this.model
    const previousThinkingLevel = this.#thinkingLevel
    const previousServiceTier = this.agent.serviceTier
    const previousSelectedMCPToolNames = new Set(this.#selectedMCPToolNames)
    const previousTools = [...this.agent.state.tools]
    const previousBaseSystemPrompt = this.#baseSystemPrompt
    const previousSystemPrompt = this.agent.state.systemPrompt
    const previousFallbackSelectedMCPToolNames = previousSessionFile
      ? this.#getSessionDefaultSelectedMCPToolNames(previousSessionFile)
      : undefined

    this.#steeringMessages = []
    this.#followUpMessages = []
    this.#pendingNextTurnMessages = []
    this.#scheduledHiddenNextTurnGeneration = undefined

    try {
      await this.sessionManager.setSessionFile(sessionPath)
      this.#syncAgentSessionId()
      this.#rekeyHindsightMemoryForCurrentSessionId()

      const sessionContext = this.buildDisplaySessionContext()
      const didReloadConversationChange =
        !switchingToDifferentSession &&
        this.#didSessionMessagesChange(previousSessionContext.messages, sessionContext.messages)
      const fallbackSelectedMCPToolNames = this.#getSessionDefaultSelectedMCPToolNames(sessionPath)
      await this.#restoreMCPSelectionsForSessionContext(sessionContext, { fallbackSelectedMCPToolNames })

      // Emit session_switch event to hooks
      if (this.#extensionRunner) {
        await this.#extensionRunner.emit({
          type: "session_switch",
          reason: "resume",
          previousSessionFile,
        })
      }

      this.agent.replaceMessages(sessionContext.messages)
      this.#syncTodoPhasesFromBranch()
      if (switchingToDifferentSession) {
        this.#closeAllProviderSessions("session switch")
      } else if (didReloadConversationChange) {
        this.#closeAllProviderSessions("session reload")
      }

      // Restore model if saved
      const defaultModelStr = sessionContext.models.default
      if (defaultModelStr) {
        const slashIdx = defaultModelStr.indexOf("/")
        if (slashIdx > 0) {
          const provider = defaultModelStr.slice(0, slashIdx)
          const modelId = defaultModelStr.slice(slashIdx + 1)
          const availableModels = this.#modelRegistry.getAvailable()
          const match = availableModels.find((m) => m.provider === provider && m.id === modelId)
          if (match) {
            const currentModel = this.model
            const shouldResetProviderState =
              switchingToDifferentSession ||
              (currentModel !== undefined &&
                (currentModel.provider !== match.provider ||
                  currentModel.id !== match.id ||
                  currentModel.api !== match.api))
            if (shouldResetProviderState) {
              this.#setModelWithProviderSessionReset(match)
            } else {
              this.agent.setModel(match)
            }
          }
        }
      }

      const hasThinkingEntry = this.sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change")
      const hasServiceTierEntry = this.sessionManager.getBranch().some((entry) => entry.type === "service_tier_change")
      const defaultThinkingLevel = this.settings.get("defaultThinkingLevel")
      const configuredServiceTier = this.settings.get("serviceTier")
      const nextThinkingLevel = resolveThinkingLevelForModel(
        this.model,
        hasThinkingEntry ? (sessionContext.thinkingLevel as ThinkingLevel | undefined) : defaultThinkingLevel,
      )
      this.#thinkingLevel = nextThinkingLevel
      this.agent.setThinkingLevel(toReasoningEffort(nextThinkingLevel))
      this.agent.serviceTier = hasServiceTierEntry
        ? sessionContext.serviceTier
        : configuredServiceTier === "none"
          ? undefined
          : configuredServiceTier

      if (switchingToDifferentSession) {
        this.#resetHindsightConversationTrackingIfHindsight()
      }
      this.#reconnectToAgent()
      return true
    } catch (error) {
      this.sessionManager.restoreState(previousSessionState)
      this.#syncAgentSessionId(previousSessionState.sessionId)
      this.#rekeyHindsightMemoryForCurrentSessionId()
      let restoreMcpError: unknown
      try {
        await this.#restoreMCPSelectionsForSessionContext(previousSessionContext, {
          fallbackSelectedMCPToolNames: previousFallbackSelectedMCPToolNames,
        })
      } catch (mcpError) {
        restoreMcpError = mcpError
        logger.warn("Failed to restore MCP selections after switch error", {
          previousSessionFile,
          targetSessionFile: sessionPath,
          error: String(mcpError),
        })
        this.#selectedMCPToolNames = new Set(previousSelectedMCPToolNames)
        this.agent.setTools(previousTools)
        this.#baseSystemPrompt = previousBaseSystemPrompt
        this.agent.setSystemPrompt(previousSystemPrompt)
      }
      this.#baseSystemPrompt = previousBaseSystemPrompt
      this.agent.setSystemPrompt(previousSystemPrompt)
      this.agent.replaceMessages(previousAgentMessages)
      this.#steeringMessages = previousSteeringMessages
      this.#followUpMessages = previousFollowUpMessages
      this.#pendingNextTurnMessages = previousPendingNextTurnMessages
      this.#scheduledHiddenNextTurnGeneration = previousScheduledHiddenNextTurnGeneration
      if (previousModel) {
        this.agent.setModel(previousModel)
      }
      this.#thinkingLevel = previousThinkingLevel
      this.agent.setThinkingLevel(toReasoningEffort(previousThinkingLevel))
      this.agent.serviceTier = previousServiceTier
      this.#syncTodoPhasesFromBranch()
      this.#reconnectToAgent()
      if (restoreMcpError) {
        throw restoreMcpError
      }
      throw error
    }
  }

  /**
   * Create a branch from a specific entry.
   * Emits before_branch/branch session events to hooks.
   *
   * @param entryId ID of the entry to branch from
   * @returns Object with:
   *   - selectedText: The text of the selected user message (for editor pre-fill)
   *   - cancelled: True if a hook cancelled the branch
   */
  /** 从指定条目创建分支会话，触发 before_branch/branch 钩子 */
  async branch(entryId: string): Promise<{
    selectedText: string
    cancelled: boolean
  }> {
    const previousSessionFile = this.sessionFile
    const selectedEntry = this.sessionManager.getEntry(entryId)

    if (!selectedEntry || selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
      throw new Error("Invalid entry ID for branching")
    }

    const selectedText = this.#extractUserMessageText(selectedEntry.message.content)

    let skipConversationRestore = false

    // Emit session_before_branch event (can be cancelled)
    if (this.#extensionRunner?.hasHandlers("session_before_branch")) {
      const result = (await this.#extensionRunner.emit({
        type: "session_before_branch",
        entryId,
      })) as SessionBeforeBranchResult | undefined

      if (result?.cancel) {
        return { selectedText, cancelled: true }
      }
      skipConversationRestore = result?.skipConversationRestore ?? false
    }

    // Clear pending messages (bound to old session state)
    this.#pendingNextTurnMessages = []
    this.#scheduledHiddenNextTurnGeneration = undefined

    // Flush pending writes before branching
    await this.sessionManager.flush()
    this.#cancelOwnAsyncJobs()

    if (!selectedEntry.parentId) {
      await this.sessionManager.newSession({ parentSession: previousSessionFile })
    } else {
      this.sessionManager.createBranchedSession(selectedEntry.parentId)
    }
    this.#syncTodoPhasesFromBranch()
    this.#syncAgentSessionId()
    this.#rekeyHindsightMemoryForCurrentSessionId()
    this.#resetHindsightConversationTrackingIfHindsight()

    // Reload messages from entries (works for both file and in-memory mode)
    const sessionContext = this.buildDisplaySessionContext()

    await this.#restoreMCPSelectionsForSessionContext(sessionContext)

    // Emit session_branch event to hooks (after branch completes)
    if (this.#extensionRunner) {
      await this.#extensionRunner.emit({
        type: "session_branch",
        previousSessionFile,
      })
    }

    if (!skipConversationRestore) {
      this.agent.replaceMessages(sessionContext.messages)
      this.#closeCodexProviderSessionsForHistoryRewrite()
    }

    return { selectedText, cancelled: false }
  }

  // =========================================================================
  // Tree Navigation
  // =========================================================================

  /**
   * Navigate to a different node in the session tree.
   * Unlike branch() which creates a new session file, this stays in the same file.
   *
   * @param targetId The entry ID to navigate to
   * @param options.summarize Whether user wants to summarize abandoned branch
   * @param options.customInstructions Custom instructions for summarizer
   * @returns Result with editorText (if user message) and cancelled status
   */
  /** 在同一会话文件内导航到树节点，可选摘要被放弃的子树 */
  async navigateTree(
    targetId: string,
    options: { summarize?: boolean; customInstructions?: string } = {},
  ): Promise<{
    editorText?: string
    cancelled: boolean
    aborted?: boolean
    summaryEntry?: BranchSummaryEntry
    /** Raw session context built during navigation — pass to renderInitialMessages to skip a second O(N) walk. */
    sessionContext?: SessionContext
  }> {
    const oldLeafId = this.sessionManager.getLeafId()

    // No-op if already at target
    if (targetId === oldLeafId) {
      return { cancelled: false }
    }

    // Model required for summarization
    if (options.summarize && !this.model) {
      throw new Error("No model available for summarization")
    }

    const targetEntry = this.sessionManager.getEntry(targetId)
    if (!targetEntry) {
      throw new Error(`Entry ${targetId} not found`)
    }

    // Collect entries to summarize (from old leaf to common ancestor)
    const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
      this.sessionManager,
      oldLeafId,
      targetId,
    )

    // Prepare event data
    const preparation: TreePreparation = {
      targetId,
      oldLeafId,
      commonAncestorId,
      entriesToSummarize,
      userWantsSummary: options.summarize ?? false,
    }

    // Set up abort controller for summarization
    this.#branchSummaryAbortController = new AbortController()
    let hookSummary: { summary: string; details?: unknown } | undefined
    let fromExtension = false

    // Emit session_before_tree event
    if (this.#extensionRunner?.hasHandlers("session_before_tree")) {
      const result = (await this.#extensionRunner.emit({
        type: "session_before_tree",
        preparation,
        signal: this.#branchSummaryAbortController.signal,
      })) as SessionBeforeTreeResult | undefined

      if (result?.cancel) {
        return { cancelled: true }
      }

      if (result?.summary && options.summarize) {
        hookSummary = result.summary
        fromExtension = true
      }
    }

    // Run default summarizer if needed
    let summaryText: string | undefined
    let summaryDetails: unknown
    if (options.summarize && entriesToSummarize.length > 0 && !hookSummary) {
      const model = this.model!
      const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId)
      if (!apiKey) {
        throw new Error(`No API key for ${model.provider}`)
      }
      const branchSummarySettings = this.settings.getGroup("branchSummary")
      const result = await generateBranchSummary(entriesToSummarize, {
        model,
        apiKey,
        signal: this.#branchSummaryAbortController.signal,
        customInstructions: options.customInstructions,
        reserveTokens: branchSummarySettings.reserveTokens,
        metadata: this.agent.metadataForProvider(model.provider),
        convertToLlm,
        telemetry: resolveTelemetry(this.agent.telemetry, this.sessionId),
      })
      this.#branchSummaryAbortController = undefined
      if (result.aborted) {
        return { cancelled: true, aborted: true }
      }
      if (result.error) {
        throw new Error(result.error)
      }
      summaryText = result.summary
      summaryDetails = {
        readFiles: result.readFiles || [],
        modifiedFiles: result.modifiedFiles || [],
      }
    } else if (hookSummary) {
      summaryText = hookSummary.summary
      summaryDetails = hookSummary.details
    }

    // Determine the new leaf position based on target type
    let newLeafId: string | null
    let editorText: string | undefined

    if (targetEntry.type === "message" && targetEntry.message.role === "user") {
      // User message: leaf = parent (null if root), text goes to editor
      newLeafId = targetEntry.parentId
      editorText = this.#extractUserMessageText(targetEntry.message.content)
    } else if (targetEntry.type === "custom_message") {
      // Custom message: leaf = parent (null if root), text goes to editor
      newLeafId = targetEntry.parentId
      editorText =
        typeof targetEntry.content === "string"
          ? targetEntry.content
          : targetEntry.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("")
    } else {
      // Non-user message: leaf = selected node
      newLeafId = targetId
    }

    // Switch leaf (with or without summary)
    // Summary is attached at the navigation target position (newLeafId), not the old branch
    let summaryEntry: BranchSummaryEntry | undefined
    if (summaryText) {
      // Create summary at target position (can be null for root)
      const summaryId = this.sessionManager.branchWithSummary(newLeafId, summaryText, summaryDetails, fromExtension)
      summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry
    } else if (newLeafId === null) {
      // No summary, navigating to root - reset leaf
      this.sessionManager.resetLeaf()
    } else {
      // No summary, navigating to non-root
      this.sessionManager.branch(newLeafId)
    }

    // Update agent state — build display context to populate agent messages.
    const stateContext = this.sessionManager.buildSessionContext()
    const displayContext = deobfuscateSessionContext(stateContext, this.#obfuscator)
    await this.#restoreMCPSelectionsForSessionContext(displayContext)
    this.agent.replaceMessages(displayContext.messages)
    this.#syncTodoPhasesFromBranch()
    this.#closeCodexProviderSessionsForHistoryRewrite()

    this.#branchSummaryAbortController = undefined

    // Emit session_tree event; only handlers can mutate session entries, so skip
    // the emit and the context rebuild when no handlers are registered (mirrors
    // the session_before_tree guard above).
    if (this.#extensionRunner?.hasHandlers("session_tree")) {
      await this.#extensionRunner.emit({
        type: "session_tree",
        newLeafId: this.sessionManager.getLeafId(),
        oldLeafId,
        summaryEntry,
        fromExtension: summaryText ? fromExtension : undefined,
      })
      const rawContext = this.sessionManager.buildSessionContext()
      return { editorText, cancelled: false, summaryEntry, sessionContext: rawContext }
    }
    return { editorText, cancelled: false, summaryEntry, sessionContext: stateContext }
  }

  /**
   * Get all user messages from session for branch selector.
   */
  /** 获取会话中所有用户消息，供分支选择器使用 */
  getUserMessagesForBranching(): Array<{ entryId: string; text: string }> {
    const entries = this.sessionManager.getEntries()
    const result: Array<{ entryId: string; text: string }> = []

    for (const entry of entries) {
      if (entry.type !== "message") continue
      if (entry.message.role !== "user") continue

      const text = this.#extractUserMessageText(entry.message.content)
      if (text) {
        result.push({ entryId: entry.id, text })
      }
    }

    return result
  }

  #extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("")
    }
    return ""
  }

  /**
   * Get session statistics.
   */
  /** 获取当前会话的统计信息（消息数、token、费用等） */
  getSessionStats(): SessionStats {
    const state = this.state
    const userMessages = state.messages.filter((m) => m.role === "user").length
    const assistantMessages = state.messages.filter((m) => m.role === "assistant").length
    const toolResults = state.messages.filter((m) => m.role === "toolResult").length

    let toolCalls = 0
    let totalInput = 0
    let totalOutput = 0
    let totalCacheRead = 0
    let totalCacheWrite = 0
    let totalCost = 0

    let totalPremiumRequests = 0
    const getTaskToolUsage = (details: unknown): Usage | undefined => {
      if (!details || typeof details !== "object") return undefined
      const record = details as Record<string, unknown>
      const usage = record.usage
      if (!usage || typeof usage !== "object") return undefined
      return usage as Usage
    }

    for (const message of state.messages) {
      if (message.role === "assistant") {
        const assistantMsg = message as AssistantMessage
        toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length
        totalInput += assistantMsg.usage.input
        totalOutput += assistantMsg.usage.output
        totalCacheRead += assistantMsg.usage.cacheRead
        totalCacheWrite += assistantMsg.usage.cacheWrite
        totalPremiumRequests += assistantMsg.usage.premiumRequests ?? 0
        totalCost += assistantMsg.usage.cost.total
      }

      if (message.role === "toolResult" && message.toolName === "task") {
        const usage = getTaskToolUsage(message.details)
        if (usage) {
          totalInput += usage.input
          totalOutput += usage.output
          totalCacheRead += usage.cacheRead
          totalCacheWrite += usage.cacheWrite
          totalPremiumRequests += usage.premiumRequests ?? 0
          totalCost += usage.cost.total
        }
      }
    }

    return {
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: state.messages.length,
      tokens: {
        input: totalInput,
        output: totalOutput,
        cacheRead: totalCacheRead,
        cacheWrite: totalCacheWrite,
        total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
      },
      cost: totalCost,
      premiumRequests: totalPremiumRequests,
    }
  }

  /**
   * Get current context usage statistics.
   * Uses the last assistant message's usage data when available,
   * otherwise estimates tokens for all messages.
   */
  /** 获取当前上下文占用（优先使用末条助手 usage，压缩后无 post-compaction 数据时返回 null） */
  getContextUsage(): ContextUsage | undefined {
    const model = this.model
    if (!model) return undefined

    const contextWindow = model.contextWindow ?? 0
    if (contextWindow <= 0) return undefined

    // After compaction, the last assistant usage reflects pre-compaction context size.
    // We can only trust usage from an assistant that responded after the latest compaction.
    // If no such assistant exists, context token count is unknown until the next LLM response.
    const branchEntries = this.sessionManager.getBranch()
    const latestCompaction = getLatestCompactionEntry(branchEntries)

    if (latestCompaction) {
      // Check if there's a valid assistant usage after the compaction boundary
      const compactionIndex = branchEntries.lastIndexOf(latestCompaction)
      let hasPostCompactionUsage = false
      for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
        const entry = branchEntries[i]
        if (entry.type === "message" && entry.message.role === "assistant") {
          const assistant = entry.message
          if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
            const contextTokens = calculateContextTokens(assistant.usage)
            if (contextTokens > 0) {
              hasPostCompactionUsage = true
            }
            break
          }
        }
      }

      if (!hasPostCompactionUsage) {
        return { tokens: null, contextWindow, percent: null }
      }
    }

    const estimate = this.#estimateContextTokens()
    const percent = (estimate.tokens / contextWindow) * 100

    return {
      tokens: estimate.tokens,
      contextWindow,
      percent,
    }
  }

  async fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null> {
    const authStorage = this.#modelRegistry.authStorage
    if (!authStorage.fetchUsageReports) return null
    return authStorage.fetchUsageReports({
      baseUrlResolver: (provider) => this.#modelRegistry.getProviderBaseUrl?.(provider),
      signal,
    })
  }

  /**
   * Estimate context tokens from messages, using the last assistant usage when available.
   */
  /** 估算上下文 token 数：有末条助手 usage 时以其为基准累加后续消息 */
  #estimateContextTokens(): {
    tokens: number
  } {
    const messages = this.messages

    // Find last assistant message with usage
    let lastUsageIndex: number | null = null
    let lastUsage: Usage | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === "assistant") {
        const assistantMsg = msg as AssistantMessage
        if (assistantMsg.usage) {
          lastUsage = assistantMsg.usage
          lastUsageIndex = i
          break
        }
      }
    }

    if (!lastUsage || lastUsageIndex === null) {
      // No usage data - estimate all messages
      let estimated = 0
      for (const message of messages) {
        estimated += estimateTokens(message)
      }
      return {
        tokens: estimated,
      }
    }

    const usageTokens = calculatePromptTokens(lastUsage)
    let trailingTokens = 0
    for (let i = lastUsageIndex + 1; i < messages.length; i++) {
      trailingTokens += estimateTokens(messages[i])
    }

    return {
      tokens: usageTokens + trailingTokens,
    }
  }

  /**
   * Export session to HTML.
   * @param outputPath Optional output path (defaults to session directory)
   * @returns Path to exported file
   */
  /** 将会话导出为 HTML 文件 */
  async exportToHtml(outputPath?: string): Promise<string> {
    const themeName = getCurrentThemeName()
    return exportSessionToHtml(this.sessionManager, this.state, { outputPath, themeName })
  }

  // =========================================================================
  // Utilities
  // =========================================================================

  /**
   * Get text content of last assistant message.
   * Useful for /copy command.
   * @returns Text content, or undefined if no assistant message exists
   */
  /** 获取最近助手消息的纯文本内容（供 /copy 等命令使用） */
  getLastAssistantText(): string | undefined {
    const lastAssistant = this.#getLastCopyCandidateAssistantMessage()
    if (!lastAssistant) return undefined

    let text = ""
    for (const content of lastAssistant.content) {
      if (content.type === "text") {
        text += content.text
      }
    }

    return text.trim() || undefined
  }

  hasCopyCandidateAssistantMessage(): boolean {
    return this.#getLastCopyCandidateAssistantMessage() !== undefined
  }

  #getLastCopyCandidateAssistantMessage(): AssistantMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i]
      if (message.role !== "assistant") continue

      const assistantMessage = message as AssistantMessage
      // Skip aborted messages with no content
      if (assistantMessage.stopReason === "aborted" && assistantMessage.content.length === 0) continue

      return assistantMessage
    }

    return undefined
  }
  /**
   * Get text content of the most recent visible handoff message.
   * Fresh handoff sessions store the handoff context as a custom message, not
   * an assistant message, so callers that copy the "last" message can use this
   * as a fallback before the new session has an assistant response.
   */
  /** 获取最近可见的 handoff 自定义消息文本（新会话尚无助手回复时的复制回退） */
  getLastVisibleHandoffText(): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i]
      if (message.role !== "custom") continue

      const customMessage = message as CustomMessage
      if (customMessage.customType !== "handoff" || !customMessage.display) continue

      if (typeof customMessage.content === "string") {
        return customMessage.content.trim() || undefined
      }

      let text = ""
      for (const content of customMessage.content) {
        if (content.type === "text") {
          text += content.text
        }
      }
      return text.trim() || undefined
    }

    return undefined
  }

  /**
   * Format the entire session as plain text for clipboard export.
   * Includes user messages, assistant text, thinking blocks, tool calls, and tool results.
   */
  /** 将会话格式化为纯文本（含用户/助手/思考/工具调用与结果），供剪贴板导出 */
  formatSessionAsText(): string {
    return formatSessionDumpText({
      messages: this.messages,
      systemPrompt: this.agent.state.systemPrompt,
      model: this.agent.state.model,
      thinkingLevel: this.#thinkingLevel,
      tools: this.agent.state.tools,
    })
  }

  /**
   * Format the conversation as compact context for subagents.
   * Includes only user messages and assistant text responses.
   * Excludes: system prompt, tool definitions, tool calls/results, thinking blocks.
   */
  /** 格式化为子 Agent 可用的紧凑上下文（仅用户与助手文本，排除工具与思考块） */
  formatCompactContext(): string {
    const lines: string[] = []
    lines.push("# Conversation Context")
    lines.push("")
    lines.push(
      "This is a summary of the parent conversation. Read this if you need additional context about what was discussed or decided.",
    )
    lines.push("")

    for (const msg of this.messages) {
      if (msg.role === "user" || msg.role === "developer") {
        lines.push(msg.role === "developer" ? "## Developer" : "## User")
        lines.push("")
        if (typeof msg.content === "string") {
          lines.push(msg.content)
        } else {
          for (const c of msg.content) {
            if (c.type === "text") {
              lines.push(c.text)
            } else if (c.type === "image") {
              lines.push("[Image attached]")
            }
          }
        }
        lines.push("")
      } else if (msg.role === "assistant") {
        const assistantMsg = msg as AssistantMessage
        // Only include text content, skip tool calls and thinking
        const textParts: string[] = []
        for (const c of assistantMsg.content) {
          if (c.type === "text" && c.text.trim()) {
            textParts.push(c.text)
          }
        }
        if (textParts.length > 0) {
          lines.push("## Assistant")
          lines.push("")
          lines.push(textParts.join("\n\n"))
          lines.push("")
        }
      } else if (msg.role === "fileMention") {
        const fileMsg = msg as FileMentionMessage
        const paths = fileMsg.files.map((f) => f.path).join(", ")
        lines.push(`[Files referenced: ${paths}]`)
        lines.push("")
      } else if (msg.role === "compactionSummary") {
        const compactMsg = msg as CompactionSummaryMessage
        lines.push("## Earlier Context (Summarized)")
        lines.push("")
        lines.push(compactMsg.summary)
        lines.push("")
      }
      // Skip: toolResult, bashExecution, pythonExecution, branchSummary, custom, hookMessage
    }

    return lines.join("\n").trim()
  }

  // =========================================================================
  // Extension System
  // =========================================================================

  /**
   * Check if extensions have handlers for a specific event type.
   */
  /** 检查扩展是否注册了指定事件类型的处理器 */
  hasExtensionHandlers(eventType: string): boolean {
    return this.#extensionRunner?.hasHandlers(eventType) ?? false
  }

  /**
   * Get the extension runner (for setting UI context and error handlers).
   */
  /** 获取扩展运行器（用于设置 UI 上下文与错误处理器） */
  get extensionRunner(): ExtensionRunner | undefined {
    return this.#extensionRunner
  }
}

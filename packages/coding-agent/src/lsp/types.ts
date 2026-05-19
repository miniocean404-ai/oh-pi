
import type { ptree } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";

// =============================================================================
// 工具参数模式定义
// =============================================================================

/** LSP 工具的参数校验模式 */
export const lspSchema = z.object({
	action: z.enum([
		"diagnostics",
		"definition",
		"references",
		"hover",
		"symbols",
		"rename",
		"rename_file",
		"code_actions",
		"type_definition",
		"implementation",
		"status",
		"reload",
		"capabilities",
		"request",
	]),
	file: z.string().describe("file path or source path for rename_file").optional(),
	line: z.number().describe("line number (1-indexed)").optional(),
	symbol: z.string().describe("symbol substring on the line").optional(),
	query: z.string().describe("search query or code-action selector").optional(),
	new_name: z.string().describe("new symbol name or destination path").optional(),
	apply: z.boolean().describe("apply edits").optional(),
	timeout: z.number().describe("request timeout in seconds").optional(),
	payload: z.string().describe("json-encoded request params").optional(),
});

/** LSP 工具参数类型（由 lspSchema 推导） */
export type LspParams = z.infer<typeof lspSchema>;

/** LSP 工具执行详情 */
export interface LspToolDetails {
	serverName?: string;
	action: string;
	success: boolean;
	request?: LspParams;
}

// =============================================================================
// LSP 协议核心类型
// =============================================================================

/** 文本位置（行号和字符偏移） */
export interface Position {
	line: number;
	character: number;
}

/** 文本范围（起始和结束位置） */
export interface Range {
	start: Position;
	end: Position;
}

/** 文件位置（URI + 范围） */
export interface Location {
	uri: string;
	range: Range;
}

/** 位置链接（带有原始选择范围和目标信息） */
export interface LocationLink {
	originSelectionRange?: Range;
	targetUri: string;
	targetRange: Range;
	targetSelectionRange: Range;
}

// =============================================================================
// 诊断信息
// =============================================================================

/** 诊断严重级别：1=错误, 2=警告, 3=信息, 4=提示 */
export type DiagnosticSeverity = 1 | 2 | 3 | 4; // error, warning, info, hint

/** 诊断关联信息 */
export interface DiagnosticRelatedInformation {
	location: Location;
	message: string;
}

/** 诊断信息（包含范围、严重级别、消息等） */
export interface Diagnostic {
	range: Range;
	severity?: DiagnosticSeverity;
	code?: string | number;
	codeDescription?: { href: string };
	source?: string;
	message: string;
	tags?: number[];
	relatedInformation?: DiagnosticRelatedInformation[];
	data?: unknown;
}

/** 已发布的诊断信息（含版本号） */
export interface PublishedDiagnostics {
	diagnostics: Diagnostic[];
	version: number | null;
}

/** 发布诊断信息的参数 */
export interface PublishDiagnosticsParams {
	uri: string;
	diagnostics: Diagnostic[];
	version?: number | null;
}

// =============================================================================
// 文本编辑
// =============================================================================

/** 文本编辑（范围 + 新文本） */
export interface TextEdit {
	range: Range;
	newText: string;
}

/** 带注解的文本编辑 */
export interface AnnotatedTextEdit extends TextEdit {
	annotationId?: string;
}

/** 文本文档标识符 */
export interface TextDocumentIdentifier {
	uri: string;
}

/** 带版本号的文本文档标识符 */
export interface VersionedTextDocumentIdentifier extends TextDocumentIdentifier {
	version: number | null;
}

/** 可选版本号的文本文档标识符 */
export interface OptionalVersionedTextDocumentIdentifier extends TextDocumentIdentifier {
	version?: number | null;
}

/** 文本文档编辑（文档标识 + 编辑列表） */
export interface TextDocumentEdit {
	textDocument: OptionalVersionedTextDocumentIdentifier;
	edits: (TextEdit | AnnotatedTextEdit)[];
}

// =============================================================================
// 资源操作
// =============================================================================

/** 创建文件选项 */
export interface CreateFileOptions {
	overwrite?: boolean;
	ignoreIfExists?: boolean;
}

/** 创建文件操作 */
export interface CreateFile {
	kind: "create";
	uri: string;
	options?: CreateFileOptions;
}

/** 重命名文件选项 */
export interface RenameFileOptions {
	overwrite?: boolean;
	ignoreIfExists?: boolean;
}

/** 重命名文件操作 */
export interface RenameFile {
	kind: "rename";
	oldUri: string;
	newUri: string;
	options?: RenameFileOptions;
}

/** 删除文件选项 */
export interface DeleteFileOptions {
	recursive?: boolean;
	ignoreIfNotExists?: boolean;
}

/** 删除文件操作 */
export interface DeleteFile {
	kind: "delete";
	uri: string;
	options?: DeleteFileOptions;
}

/** 文档变更类型（文本编辑或资源操作） */
export type DocumentChange = TextDocumentEdit | CreateFile | RenameFile | DeleteFile;

/** 工作区编辑（多文件变更集合） */
export interface WorkspaceEdit {
	changes?: Record<string, TextEdit[]>;
	documentChanges?: DocumentChange[];
	changeAnnotations?: Record<string, { label: string; needsConfirmation?: boolean; description?: string }>;
}

// =============================================================================
// 代码操作
// =============================================================================

/** 代码操作类型 */
export type CodeActionKind =
	| "quickfix"
	| "refactor"
	| "refactor.extract"
	| "refactor.inline"
	| "refactor.rewrite"
	| "source"
	| "source.organizeImports"
	| "source.fixAll"
	| string;

/** LSP 命令 */
export interface Command {
	title: string;
	command: string;
	arguments?: unknown[];
}

/** 代码操作（包含标题、类型、编辑等） */
export interface CodeAction {
	title: string;
	kind?: CodeActionKind;
	diagnostics?: Diagnostic[];
	isPreferred?: boolean;
	disabled?: { reason: string };
	edit?: WorkspaceEdit;
	command?: Command;
	data?: unknown;
}

/** 代码操作上下文 */
export interface CodeActionContext {
	diagnostics: Diagnostic[];
	only?: CodeActionKind[];
	triggerKind?: 1 | 2; // Invoked = 1, Automatic = 2
}

// =============================================================================
// 符号
// =============================================================================

/** 符号类型枚举（1-26 对应不同符号类型） */
export type SymbolKind =
	| 1 // File
	| 2 // Module
	| 3 // Namespace
	| 4 // Package
	| 5 // Class
	| 6 // Method
	| 7 // Property
	| 8 // Field
	| 9 // Constructor
	| 10 // Enum
	| 11 // Interface
	| 12 // Function
	| 13 // Variable
	| 14 // Constant
	| 15 // String
	| 16 // Number
	| 17 // Boolean
	| 18 // Array
	| 19 // Object
	| 20 // Key
	| 21 // Null
	| 22 // EnumMember
	| 23 // Struct
	| 24 // Event
	| 25 // Operator
	| 26; // TypeParameter

/** 符号类型编号到名称的映射 */
export const SYMBOL_KIND_NAMES: Record<SymbolKind, string> = {
	1: "File",
	2: "Module",
	3: "Namespace",
	4: "Package",
	5: "Class",
	6: "Method",
	7: "Property",
	8: "Field",
	9: "Constructor",
	10: "Enum",
	11: "Interface",
	12: "Function",
	13: "Variable",
	14: "Constant",
	15: "String",
	16: "Number",
	17: "Boolean",
	18: "Array",
	19: "Object",
	20: "Key",
	21: "Null",
	22: "EnumMember",
	23: "Struct",
	24: "Event",
	25: "Operator",
	26: "TypeParameter",
};

/** 文档符号（支持层级结构） */
export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: SymbolKind;
	tags?: number[];
	deprecated?: boolean;
	range: Range;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

/** 符号信息（扁平格式） */
export interface SymbolInformation {
	name: string;
	kind: SymbolKind;
	tags?: number[];
	deprecated?: boolean;
	location: Location;
	containerName?: string;
}

// =============================================================================
// 悬停信息
// =============================================================================

/** 标记内容（纯文本或 Markdown） */
export interface MarkupContent {
	kind: "plaintext" | "markdown";
	value: string;
}

/** 标记字符串（纯文本或带语言标识的代码） */
export type MarkedString = string | { language: string; value: string };

/** 悬停信息 */
export interface Hover {
	contents: MarkupContent | MarkedString | MarkedString[];
	range?: Range;
}

// =============================================================================
// 代码检查客户端接口
// =============================================================================

/**
 * Interface for linter/formatter clients.
 * Can be implemented using LSP protocol or CLI tools.
 * 代码检查/格式化客户端接口。可通过 LSP 协议或 CLI 工具实现。
 */
export interface LinterClient {
	/** Format file content. Returns formatted content. */
	/** 格式化文件内容，返回格式化后的内容 */
	format(filePath: string, content: string): Promise<string>;

	/** Get diagnostics for a file. Content should already be written to disk. */
	/** 获取文件的诊断信息，文件内容应已写入磁盘 */
	lint(filePath: string): Promise<Diagnostic[]>;

	/** Dispose of any resources (e.g., LSP connection) */
	/** 释放资源（如 LSP 连接） */
	dispose?(): void;
}

/** Factory function to create a LinterClient */
/** 创建 LinterClient 的工厂函数 */
export type LinterClientFactory = (config: ServerConfig, cwd: string) => LinterClient;

// =============================================================================
// 服务器配置
// =============================================================================

/** 服务器特殊能力标识 */
export interface ServerCapabilities {
	flycheck?: boolean;
	ssr?: boolean;
	expandMacro?: boolean;
	runnables?: boolean;
	relatedTests?: boolean;
}

/** LSP 服务器配置 */
export interface ServerConfig {
	command: string;
	args?: string[];
	fileTypes: string[];
	rootMarkers: string[];
	initOptions?: Record<string, unknown>;
	settings?: Record<string, unknown>;
	disabled?: boolean;
	/** Per-server warmup timeout in milliseconds. Overrides the global WARMUP_TIMEOUT_MS for this server during startup. */
	/** 单服务器预热超时（毫秒），覆盖全局 WARMUP_TIMEOUT_MS */
	warmupTimeoutMs?: number;
	capabilities?: ServerCapabilities;
	/** If true, this is a linter/formatter server (e.g., Biome) - used only for diagnostics/actions, not type intelligence */
	/** 若为 true，表示这是一个代码检查/格式化服务器（如 Biome），仅用于诊断和操作，不提供类型推导 */
	isLinter?: boolean;
	/** Resolved absolute path to the command binary (set during config loading) */
	/** 已解析的命令二进制文件绝对路径（配置加载时设置） */
	resolvedCommand?: string;
	/**
	 * Custom linter client factory. If provided, creates a custom client instead of using LSP.
	 * The client handles format/lint operations. Useful for tools with buggy LSP implementations.
	 * 自定义代码检查客户端工厂。若提供，则使用自定义客户端而非 LSP。
	 */
	createClient?: LinterClientFactory;
}

// =============================================================================
// 客户端状态
// =============================================================================

/** 已打开的文件信息 */
export interface OpenFile {
	version: number;
	languageId: string;
}

/** 待处理的请求 */
export interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	method: string;
}

/** LSP 服务器能力声明 */
export interface LspServerCapabilities {
	renameProvider?: boolean | { prepareProvider?: boolean };
	codeActionProvider?: boolean | { resolveProvider?: boolean };
	hoverProvider?: boolean;
	definitionProvider?: boolean;
	referencesProvider?: boolean;
	documentSymbolProvider?: boolean;
	workspaceSymbolProvider?: boolean;
	[key: string]: unknown;
}

/** LSP 客户端实例（管理与服务器的连接状态） */
export interface LspClient {
	name: string;
	cwd: string;
	config: ServerConfig;
	proc: ptree.ChildProcess<"pipe">;
	requestId: number;
	diagnostics: Map<string, PublishedDiagnostics>;
	diagnosticsVersion: number;
	openFiles: Map<string, OpenFile>;
	pendingRequests: Map<number, PendingRequest>;
	messageBuffer: Uint8Array;
	isReading: boolean;
	serverCapabilities?: LspServerCapabilities;
	lastActivity: number;
	/** Serializes outbound JSON-RPC writes to the server process. */
	/** 序列化向服务器进程写入的 JSON-RPC 消息队列 */
	writeQueue: Promise<void>;
	/** Tracks active work-done progress tokens from the server */
	/** 跟踪服务器的活跃进度令牌 */
	activeProgressTokens: Set<string | number>;
	/** Resolves when the server's initial project loading completes (or after timeout) */
	/** 服务器初始项目加载完成（或超时）时解决 */
	projectLoaded: Promise<void>;
	/** Call to signal that project loading has completed */
	/** 调用以通知项目加载已完成 */
	resolveProjectLoaded: () => void;
}

// =============================================================================
// JSON-RPC 协议类型
// =============================================================================

/** JSON-RPC 请求 */
export interface LspJsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params: unknown;
}

/** JSON-RPC 响应 */
export interface LspJsonRpcResponse {
	jsonrpc: "2.0";
	id?: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC 通知（无需响应） */
export interface LspJsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}


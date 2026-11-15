# 03 · 核心契约：领域模型与端口

> 本文件为**规范性定义**。实现必须与这里的类型语义一致；新增字段允许（可选字段），修改或删除必须走 ADR（10-adr.md）。
> 所有类型零框架 import（只允许依赖 TypeScript 标准库与 JSON Schema 类型）。

## 1. 命名与通用约定【规范】

- 领域类型命名 PascalCase，事件类型 `XxxEvent`，端口 `I` 前缀禁用（直接名词命名）。
- 所有 `id` 为字符串 ULID/UUID。
- JSON Schema 为内核的 schema 规范（ADR-0002）；Zod 仅允许出现在适配器层做构造便利。
- 默认常量（全部可通过配置覆盖）：

| 常量 | 默认值 | 说明 |
|---|---|---|
| `MAX_STEPS` | 25 | 单 Turn 最大步数 |
| `MAX_TURN_TOKENS` | 1_000_000 | 单 Turn 累计 token（输入+输出） |
| `MAX_TURN_WALL_MS` | 600_000 | 单 Turn 墙钟上限（10 分钟） |
| `TOOL_RESULT_CHAR_CAP` | 20_000 | 工具输出进入 messages 前的硬截断（可按工具覆盖） |
| `LOOP_REPEAT_THRESHOLD` | 3 | 相同 (toolName, input) 哈希出现次数上限 |
| `CONTEXT_HASH_STREAK` | 3 | 连续上下文哈希不变轮数上限 |
| `SHORT_TERM_TOKEN_THRESHOLD` | 80_000 | 短期压缩的内核兜底阈值（shell 未传压缩配置时生效） |
| `COMPACTION_THRESHOLD_RATIO` | 0.9 | 自动压缩阈值 = 当前生效模型 contextWindow × 0.9（shell 按模型实时计算、切模型即更新；P2） |
| `EVENT_SCHEMA_VERSION` | 1 | 事件信封当前版本（FanoutSink 打戳；解析边界经 migrateEvent 沿链升级，未来版本透传） |
| `RESIDENT_THREAD_LIMIT` | 8 | 内核驻留全量消息的任务数上界（LRU 卸载，事件日志可随时重建；内存治理，P2） |
| `BUDGET_WARN_RATIO` | 0.8 | 预算预警比例 |

**路径规范【规范】**（ADR-0013）：所有领域对象与事件载荷中的路径字段（`DiffProposal.path`、`Diagnostic.file`、`toolExecuted.affectedPaths` 等）一律为**绝对路径**——多根工作区下"工作区相对路径"存在归属歧义，禁止作为内部表示；UI 层负责显示时相对化；Windows 上路径比较不区分大小写。

## 2. 消息模型【规范】

```ts
export type Role = 'user' | 'assistant' | 'system';

export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'summary'; text: string; summarizedRange: [number, number] }
  | { kind: 'tool-call'; toolCallId: string; name: string; args: string } // args 为 JSON 字符串
  | { kind: 'tool-result'; toolCallId: string; content: string;
      truncated: boolean; originalChars: number };

export interface ChatMessage {
  id: string;
  role: Role;
  parts: MessagePart[];
  createdAt: number;
}
```

**铁律**：这是内核自有类型，禁止在 domain/ports/agent-core 出现 AI SDK 的 `CoreMessage` 等外部类型（ADR-0002）。

## 3. 会话四级状态【规范】

```ts
export type AgentMode = 'plan' | 'edit' | 'explain';

export type TurnStatus =
  | 'running' | 'awaiting-approval' | 'completed'
  | 'degraded' | 'failed' | 'cancelled' | 'interrupted'; // interrupted 仅用于恢复时标记

export interface Usage { inputTokens: number; outputTokens: number; costEstimate: number; }

export interface Session {
  id: string;
  workspaceRoots: string[];      // 支持多根工作区
  threadIds: string[];
}

export interface Thread {
  id: string;
  title: string;                 // 首条消息自动生成，可编辑
  turnIds: string[];
  createdAt: number;
}

export interface Turn {
  id: string;
  threadId: string;
  mode: AgentMode;
  status: TurnStatus;
  usage: Usage;
  startedAt: number; endedAt?: number;
}
```

## 4. LoopState【规范】

```ts
export interface Budget { maxSteps: number; maxTurnTokens: number; maxWallMs: number; }
export interface BudgetSpent { steps: number; tokens: number; wallMs: number; }

export type TerminationReason =
  | 'natural' | 'maxSteps' | 'maxTurnTokens' | 'timeout'
  | 'loopDetected' | 'userCancelled' | 'modelError' | 'fatal';

export interface LoopState {
  threadId: string;
  turnId: string;
  messages: ChatMessage[];
  stepCount: number;
  seenToolCalls: Set<string>;   // hashToolCall(name, input) 集合
  contextHashStreak: number;    // 连续上下文哈希不变轮数
  toolsDisabled: boolean;       // 降级收尾时置 true
  budget: Budget;
  spent: BudgetSpent;
  abort: AbortSignal;           // 取消传播入口（见 07 §6）
}
```

**死循环哈希规范**：`hashToolCall(name, input) = sha256(name + '\u0000' + canonicalJson(input))`，其中 `canonicalJson` 对对象键递归排序后序列化。两处比较必须使用同一实现（domain 提供唯一函数）。

## 5. 工具契约【规范】

```ts
export type SideEffect = 'read' | 'write' | 'execute';
export type ToolSource = 'builtin' | 'plugin' | 'task';   // task 为 P3

// 可序列化的工具规格：进入 ModelRequest 与事件载荷（toolsChanged 等）的只有它
export interface ToolSpec {
  name: string;                    // 全局唯一，snake_case
  description: string;             // 面向模型的说明，必填
  inputSchema: JsonSchema;
  sideEffect: SideEffect;
  source: ToolSource;
}

// 执行侧契约（ToolHandler / ToolContext / ToolResult / RegisteredTool）归 ports 所有，
// 见 §9——domain 若持有它们将形成 domain→ports 反向依赖（ADR-0015）。
```

### 模式过滤规则【规范】

| 模式 | schema 中可见的工具 | 说明 |
|---|---|---|
| `plan` | 仅 `sideEffect === 'read'` | 修改性工具**不出现在 schema 里** |
| `explain` | 仅 `sideEffect === 'read'` | 同上；注入更多当前文件/选区上下文 |
| `edit` | read + write + execute(P3) | 写类工具按审批策略执行 |

### 内置工具目录与默认审批【规范】

| 工具 | 副作用 | 默认审批策略 | 关键护栏点 |
|---|---|---|---|
| `read_file` | read | auto | 路径越界；二进制探测；读取长度截断 |
| `list_dir` | read | auto | 路径越界 |
| `search_text` | read | auto | 路径越界；结果条数与总字符截断 |
| `write_file` | write | ask | 路径越界；checkpoint 懒快照（07 §5） |
| `apply_diff` | write | ask | hunk 上下文匹配校验失败即拒绝；checkpoint 懒快照 |
| `run_command`(P3) | execute | **deny（白名单命中才升级为 ask）** | 沙箱与白名单（07 §7） |
| `run_task`(P3) | execute | ask | 任务定义白名单 |
| `get_build_diagnostics`(P3) | read | auto | 无 |

## 6. DiffProposal【规范】

```ts
export interface DiffHunk {
  oldStart: number; oldLines: string[];
  newStart: number; newLines: string[];
}

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

export interface DiffProposal {
  id: string;
  path: string;                    // 工作区相对路径
  hunks: DiffHunk[];
  status: ProposalStatus;
  toolCallId: string;
  createdAt: number; resolvedAt?: number;
}
```

生命周期：`pending → accepted | rejected`；应用退出/线程关闭时未决提案置 `expired`；恢复会话时默认按 `rejected` 处理并向用户说明（可配置为重新询问，见 07 §2）。

## 7. 诊断【规范】（P3 消费，P1 定义）

```ts
export interface Diagnostic {
  file: string;
  range: { startLine: number; startCol: number; endLine: number; endCol: number };
  severity: 'error' | 'warning' | 'info' | 'hint';
  code?: string;
  message: string;
  source?: string;                 // 'tsc' | 'eslint' | 'go-build' | ...
}
```

## 8. 长期记忆【规范】

```ts
export interface MemoryFact {
  id: string;
  kind: 'preference' | 'convention' | 'fact';
  content: string;
  createdAt: number;
  source: 'extracted' | 'user-pinned';
  scope?: 'task' | 'global';            // ADR-0021：缺省 global；任务级记忆带 threadId
  threadId?: string;
  turnId?: string;                      // 溯源：来自哪一轮（提炼/pinned 均记）
  status?: 'active' | 'superseded';     // 新事实覆盖旧事实，不物理删除
}

// ---- 任务简报 / 中间产物（ADR-0021）----
export interface Brief { threadId: string; content: string; rev: number }
export interface ArtifactRef {
  hash: string;                          // 内容寻址（sha256 前 16 位）
  kind: 'tool-output' | 'plan' | 'report';
  summary: string;                       // 一行摘要：进上下文与事件的只有它
  size: number;
}
export interface SkillManifest {         // 只含索引字段（body 不进上下文，ADR-0022）
  name: string;
  description: string;                   // 触发描述，注入索引用
  scope: 'user' | 'project';
  entry: string;                         // SKILL.md 绝对路径
}
```

## 9. 端口契约【规范】

端口归内核所有；适配器实现端口；签名只使用本文件类型。

```ts
// ---- 模型（ADR-0001/0002）----
export interface ModelRequest {
  modelTier: 'main' | 'cheap';
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];               // 已按模式过滤（仅可序列化规格，不含 handler）
  signal: AbortSignal;
}

export type ModelStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call-delta'; toolCallId: string; argsDelta: string }
  | { type: 'tool-call-complete'; toolCallId: string; name: string; args: string }
  | { type: 'usage'; delta: { inputTokens: number; outputTokens: number } }
  | { type: 'retrying'; attempt: number; reason: string }        // 适配器内重试，事件化
  | { type: 'finish'; finishReason: 'stop' | 'tool-calls' | 'length' | 'error';
      errorMessage?: string };

export interface ModelClient {
  stream(req: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

// ---- 工具执行契约（ADR-0015：归 ports，domain 不持有 handler）----
export interface ToolContext {
  workspaceRoots: string[];
  signal: AbortSignal;             // 取消传播到工具内部
  editor?: EditorGateway;          // 需要编辑器能力的工具使用（经 RPC 跨进程）
  toolCallId?: string;             // prepareApproval 产出 DiffProposal 时需要
  turnId?: string;                 // checkpoint 懒快照按 Turn 归档（07 §5）
}

export interface ToolResult {
  ok: boolean;
  content: string;                 // 原始内容；截断在管道内完成
  structured?: unknown;            // P3 结构化诊断等
  affectedPaths?: string[];        // 影响的绝对路径（ADR-0014 编辑器刷新依据）
}

export type ToolHandler = (input: unknown, ctx: ToolContext) => Promise<ToolResult>;

/** 注册表内部条目 = 可序列化规格 + 执行体；handler 不进入任何序列化边界（ADR-0011） */
export interface RegisteredTool extends ToolSpec {
  handler?: ToolHandler;           // builtin 工具由组合根装配；插件工具由 plugin-host 适配出 handler
  prepareApproval?: (input: unknown, ctx: ToolContext) => Promise<DiffProposal | undefined>;
  // 审批前准备钩子：校验输入并产出 DiffProposal（apply_diff 的 hunk 校验、write_file 的旧新对比）
}

// ---- 审批（ADR-0003）----
export interface ApprovalSpec {
  approvalId: string;
  toolName: string;
  input: unknown;
  sideEffect: SideEffect;
  diffProposal?: DiffProposal;
}

export type ApprovalDecision =
  | { kind: 'approved' }
  | { kind: 'rejected'; message?: string }
  | { kind: 'modified'; input: unknown; message?: string };

export interface ApprovalRequester {
  request(spec: ApprovalSpec, signal: AbortSignal): Promise<ApprovalDecision>;
}

// ---- 编辑器网关 ----
export interface EditorGateway {
  openFile(path: string, opts?: { line?: number; col?: number }): Promise<void>;
  applyEdit(path: string, edit: { startLine: number; startCol: number;
    endLine: number; endCol: number; newText: string }): Promise<boolean>;
  getSelection(): Promise<{ path: string; text: string } | null>;
  revealLine(path: string, line: number): Promise<void>;
}

// ---- 上下文提供者（扩展点）----
export interface ContextChunk {
  providerId: string;
  text: string;
  priority: number;                // 越小越优先保留
  tokens: number;
}

export interface ContextProvider {
  id: string;                      // 全局唯一
  priority: number;
  provide(ctx: { threadId: string; mode: AgentMode;
                 latestUserMessage?: string }): Promise<ContextChunk | null>;
}

// ---- 事件与持久化 ----
export interface EventSink { publish(event: LoopEvent): void; }

export interface MemoryStore {
  appendEvent(threadId: string, event: LoopEvent): Promise<void>;      // 事件溯源日志
  loadEvents(threadId: string): Promise<LoopEvent[]>;
  /** 删除会话日志（用户删除任务；checkpoint 不随之删除） */
  deleteThread(threadId: string): Promise<void>;
  saveFact(fact: MemoryFact): Promise<void>;
  queryFacts(query: string, limit: number): Promise<MemoryFact[]>;
  listThreads(): Promise<Thread[]>;
}

// ---- 简报 / 产物 / 技能（ADR-0021/0022；实现均落 memory-store 适配器，P2 可整体换 SQLite）----
export interface BriefStore {
  /** 读现值（文件为主：装配与 UI 均读它；事件只审计不重建） */
  read(threadId: string): Promise<Brief | null>;
  write(threadId: string, content: string, actor: 'user' | 'agent'): Promise<Brief>; // rev 递增 + briefUpdated 事件
}
export interface ArtifactStore {
  put(content: string, meta: { threadId: string; turnId?: string; kind: ArtifactRef['kind']; summary: string }): Promise<ArtifactRef>;
  get(hash: string, offset?: number): Promise<string>;   // 分页取回
  list(threadId: string): Promise<ArtifactRef[]>;
}
export interface SkillRegistry {
  scan(): Promise<SkillManifest[]>;                      // user + project 双作用域
  readBody(name: string): Promise<string>;
}

export interface Clock { now(): number; }

// ---- P3 预留（接口留白，P1/P2 只声明不实现）----
export interface TerminalProvider {
  create(opts: { cwd: string; env?: Record<string, string> }): TerminalSession;
}
export interface TerminalSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
  kill(): void;
}

export interface TaskDef { id: string; name: string; command: string; kind: 'build' | 'test' | 'run'; }
export interface TaskRun { onOutput(cb: (chunk: string) => void): void; onDiagnostics(cb: (d: Diagnostic[]) => void): void; kill(): void; }
export interface TaskProvider {
  detect(workspaceRoots: string[]): Promise<string | null>;   // 项目类型
  listTasks(): Promise<TaskDef[]>;
  run(taskId: string): TaskRun;
}
```

## 10. 事件类型

`LoopEvent` 完整目录见 [04-event-pipeline.md](04-event-pipeline.md)（规范）。本文件不重复定义。

## 11. 配置契约与环境事件源（审计修订新增）【规范】

```ts
export interface AppConfig {
  models: { main: ModelConfig; cheap: ModelConfig };
  approval: Record<SideEffect, 'auto' | 'ask' | 'deny'>;
  restorePolicy: 'reject' | 're-ask';       // 会话恢复时挂起审批的处理（07 §1.3）
  limits: { maxSteps: number; maxTurnTokens: number; maxWallMs: number;
            toolResultCharCap: number };
  guardrails: { dangerousCommandPatterns: string[]; injectionPatterns: string[] };
  workspaceRoots: string[];
}

export interface ModelConfig {
  provider: string; modelId: string; baseURL?: string;
  apiKeyRef?: string;              // 密钥引用名，密钥本体在 OS keychain（07 §3）
}

export interface ConfigStore {
  load(): Promise<AppConfig>;
  save(patch: Partial<AppConfig>): Promise<void>;   // 合并语义；密钥引用不落明文
}

// 编辑器/UI → 内核通知的订阅端口（04 §2 流向 B 的接收端，此前缺端口定义）
export interface EnvironmentEventSource {
  subscribe(cb: (event: EnvironmentEvent) => void): () => void;
}
```

- P1 的 `ConfigStore` 实现放在 memory-store 适配器（同族 JSON 文件，`userData/config.json`）；企业策略层（09 §3）作为叠加配置源合并进 `AppConfig`（只允许改严）。
- 设置 UI 见 06 §4.6；M3 交付基础版。

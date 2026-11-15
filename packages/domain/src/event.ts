// 04 事件契约：LoopEvent 信封 + 完整目录 + EnvironmentEvent
// 铁律（04 §4）：只追加不可变；全部可 JSON 序列化；payload 禁止携带函数（ADR-0011）
import type { Diagnostic } from './diagnostic';
import type { DiffProposal } from './diff';
import type { PlanStep } from './plan';
import type { TerminationReason } from './loop-state';
import type { ArtifactRef, MemoryFact } from './memory';
import type { AgentMode, Usage } from './session';
import type { SideEffect, ToolSource, ToolSpec } from './tool';

export interface EventEnvelope {
  /** 线程内单调递增，由 EventSink 扇出点单点分配（ADR-0014） */
  seq: number;
  id: string;
  schemaVersion: 1;
  ts: number;
  threadId: string;
  turnId?: string;
  step?: number;
}

export type GuardrailRule =
  | 'pathOutside'
  | 'dangerousCommand'
  | 'readonlyBlocked'
  | 'schemaInvalid'
  | 'injectionWarning';

export interface LoopEventPayloads {
  // ---- A1 Turn / Thread 生命周期 ----
  turnStarted: {
    turnId: string;
    mode: AgentMode;
    model: string;
    userMessageId: string;
    /** 用户消息全文（事件溯源重放重建消息所需，可选新增字段不递增版本） */
    userText?: string;
      /** docs/16 多模态：用户附带的截图（事件溯源重放重建消息所需，可选新增字段不递增版本） */
    images?: { mime: string; base64: string }[];
  };
  turnCancelled: { turnId: string };
  turnCompleted: { outcome: 'completed' | 'degraded' | 'failed' };
  /** ADR-0026 计划分解：plan_write 工具经管道侧通道广播的全量步骤快照（last-write-wins） */
  planUpdated: { turnId: string; steps: PlanStep[] };
  /** docs/15：完成审计/完成声明裁决（UI 可消费展示遗留项；sink 对未知类型透传） */
  completionAudit: { verdict: 'selfReport' | 'audit-pass' | 'audit-continue' | 'audit-fail-open' | 'evidence-gate'; missing?: string[] };
  threadCreated: { threadId: string; title: string; /** 所属项目根（多项目，缺省首根） */ workspaceRoot?: string };
  threadTitleChanged: { threadId: string; title: string };
  /** 多项目：任务移动到另一项目（workspaceRoot 变更；后到为准） */
  threadMoved: { threadId: string; workspaceRoot: string };
  threadResumed: {
    threadId: string;
    restoredTurnCount: number;
    interruptedTurnIds: string[];
    /** 恢复时因重启而失效的未决审批数（可选新增） */
    pendingApprovalCount?: number;
  };
  // ---- A2 Step 与模型流 ----
  stepStarted: { step: number };
  textDelta: { messageId: string; text: string };
  reasoningDelta: { messageId: string; text: string };
  toolCallDelta: { messageId: string; toolCallId: string; argsDelta: string };
  toolCallComplete: { messageId: string; toolCallId: string; name: string; args: string };
  usageDelta: { inputTokens: number; outputTokens: number; /** 出处模型 id（P2 统计；历史事件无此字段） */ model?: string };
  retrying: { attempt: number; reason: string };
  stepCompleted: { finishReason: 'stop' | 'tool-calls' | 'length' | 'error'; usage: Usage };
  // ---- A3 工具管道 ----
  toolRequested: { toolCallId: string; name: string; input: unknown; sideEffect: SideEffect };
  guardrailTriggered: {
    toolCallId: string;
    rule: GuardrailRule;
    detail: string;
    action: 'blocked' | 'rewritten' | 'warned';
  };
  approvalRequired: {
    approvalId: string;
    toolCallId: string;
    /** 管线实际发射了 input/toolName/sideEffect（run_command 审批卡显示命令的主体）——类型此前漏声明 */
    input?: unknown;
    toolName?: string;
    sideEffect?: string;
    diffProposal?: DiffProposal;
  };
  approvalResolved: {
    approvalId: string;
    decision: 'approved' | 'rejected' | 'modified';
    modifiedInput?: unknown;
  };
  toolExecuted: { toolCallId: string; durationMs: number; affectedPaths: string[]; proposal?: DiffProposal; images?: { mime: string; base64: string }[] };

  toolFailed: { toolCallId: string; error: string };
  observationAdded: {
    toolCallId: string;
    truncated: boolean;
    originalChars: number;
    finalChars: number;
    preview: string;
    /** 截断后的完整内容（重放重建 tool-result part 所需） */
    content?: string;
  };
  // ---- A4 Diff 提案 ----
  diffProposed: { proposal: DiffProposal };
  diffResolved: { proposalId: string; status: 'accepted' | 'rejected' | 'expired' };
  // ---- A5 上下文与记忆 ----
  contextAssembled: {
    providers: { id: string; tokens: number }[];
    totalTokens: number;
    dropped: string[];
    /** 上下文容量分类占比（可选新增字段，容量指示器消费） */
    breakdown?: { messages: number; system: number; tools: number; other: number };
  };
  memoryCompressed: {
    compressedMessageIds: string[];
    summary: string;
    tokensSaved: number;
  };
  memoryExtracted: { facts: MemoryFact[] };
  memoryRecalled: { factIds: string[]; /** ADR-0021 召回可解释性：一条一句的引用预览 */ previews?: string[] };
  // ---- A5b 任务记忆 / 简报 / 产物 / 技能（P2.0，ADR-0021/0022）----
  memoryPinned: { fact: MemoryFact };
  memoryUnpinned: { factId: string };
  /** 仅审计：简报文件为主（文件即真相），重放不据此重建 */
  briefUpdated: { threadId: string; rev: number; hash: string; actor: 'user' | 'agent' };
  /** 事件只带 ref（hash+summary），blob 本体在 artifacts/ 内容寻址 */
  artifactStored: { ref: ArtifactRef };
  skillUsed: { name: string; scope: 'user' | 'project'; turnId?: string };
  // ---- A6 终止与预算 ----
  budgetWarning: {
    kind: 'maxSteps' | 'maxTurnTokens' | 'timeout';
    used: number;
    limit: number;
  };
  degradationStarted: { reason: string };
  loopTerminated: { reason: TerminationReason; finalSummary?: string };
  error: { source: 'model' | 'tool' | 'system'; message: string; recoverable: boolean };
  // ---- A7 Checkpoint ----
  checkpointCreated: { turnId: string; files: string[] };
  checkpointRestored: {
    turnId: string;
    restoredFiles: string[];
    failedFiles: string[];
    /** 检查点后被外部修改过的文件（watcher 观测，回滚时交集；#7 外部可见性） */
    externallyChanged?: string[];
  };
  // ---- A8 注册表与模式 ----
  toolsChanged: { added: ToolSpec[]; removed: string[]; source: ToolSource };
  modeChanged: { mode: AgentMode };
  modelChanged: { model: string };
}

export type EventType = keyof LoopEventPayloads;

export type LoopEvent = EventEnvelope & {
  [T in EventType]: { type: T; payload: LoopEventPayloads[T] };
}[EventType];

/** 流向 B：编辑器/UI → 内核（04 §2），内核只消费不广播 */
export type EnvironmentEvent =
  | { type: 'onDidChangeActiveEditor'; path: string | null }
  | {
      type: 'onDidChangeSelection';
      path: string;
      text: string;
      range: { startLine: number; startCol: number; endLine: number; endCol: number };
    }
  | { type: 'onDidSave'; path: string }
  | { type: 'onDidChangeDiagnostics'; path: string; diagnostics: Diagnostic[] };

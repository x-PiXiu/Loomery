# 04 · 事件管道

> 事件是内核对外的**唯一广播通道**，也是持久化（事件溯源）的唯一数据源。本文件为规范性定义，事件**只增不改不删**。

## 1. 统一信封【规范】

```ts
export interface LoopEvent {
  seq: number;            // 线程内单调递增；重放排序 + 乱序去重依据
  id: string;             // 事件唯一 ID
  schemaVersion: 1;       // 契约版本
  type: EventType;
  ts: number;
  threadId: string;
  turnId?: string;
  step?: number;
  payload: unknown;       // 按 type 确定，见 §3 目录
}
```

## 2. 两个流向【规范】

| 流向 | 名称 | 方向 | 用途 |
|---|---|---|---|
| A | `LoopEvent` | 内核 → 外层 | 渲染对话、持久化、审计 |
| B | `EnvironmentEvent` | 编辑器/UI → 内核 | ContextProvider 缓存失效，内核只消费不广播 |

流向 B 走独立通道（ipc-bridge 的 `env-event` 频道），不进入 LoopEvent 日志：

| EnvironmentEvent | 载荷 | 用途 |
|---|---|---|
| `onDidChangeActiveEditor` | `{ path } \| null` | 当前文件上下文刷新 |
| `onDidChangeSelection` | `{ path, text, range }` | 选区上下文刷新 |
| `onDidSave` | `{ path }` | 触发相关 provider 失效 |
| `onDidChangeDiagnostics` | `{ path, diagnostics: Diagnostic[] }` | 诊断上下文 |

## 3. LoopEvent 完整目录【规范】

"引入期"列表示该事件最早出现的阶段；P1 实现必须覆盖引入期为 P1 的全部事件。

### A1. Turn 生命周期

| 事件 | 载荷要点 | 主要消费者 | 引入期 |
|---|---|---|---|
| `turnStarted` | turnId, mode, model, userMessageId, **userText（重放重建用户消息用，可选新增）** | Chat, session | P1 |
| `turnCancelled` | turnId | Chat, session | P1 |
| `turnCompleted` | outcome: completed / degraded / failed | 状态栏, memory 钩子, session | P1 |
| `threadCreated` | threadId, title | ThreadList, session | P1（ADR-0014） |
| `threadTitleChanged` | threadId, title | ThreadList | P1（ADR-0014） |
| `threadResumed` | threadId, restoredTurnCount, interruptedTurnIds | ThreadList, Chat | P1（ADR-0014） |

### A2. Step 与模型流

| 事件 | 载荷要点 | 主要消费者 | 引入期 |
|---|---|---|---|
| `stepStarted` | step | 状态栏, 调试 | P1 |
| `textDelta` | messageId, text（增量；重放按 messageId 归组重建消息，ADR-0014） | Chat | P1 |
| `reasoningDelta` | text（增量，模型支持时） | Chat 折叠区 | P1（可选实现） |
| `toolCallDelta` | toolCallId, argsDelta | Chat 工具卡骨架 | P1 |
| `toolCallComplete` | messageId, toolCallId, name, args | Chat | P1 |
| `usageDelta` | inputTokens, outputTokens | 状态栏 | P1 |
| `retrying` | attempt, reason | Chat（弱提示）, 调试 | P1 |
| `stepCompleted` | finishReason, 累计 usage | 调试, session | P1 |

### A3. 工具管道（每次工具调用固定此链序）

```
toolRequested → [guardrailTriggered] → [approvalRequired → approvalResolved]
             → toolExecuted | toolFailed → observationAdded
```

| 事件 | 载荷要点 | 主要消费者 | 引入期 |
|---|---|---|---|
| `toolRequested` | toolCallId, name, input, sideEffect | Chat, 调试 | P1 |
| `guardrailTriggered` | rule: pathOutside / dangerousCommand / readonlyBlocked / schemaInvalid / injectionWarning；detail; action: blocked / rewritten / warned | Chat, 审计 | P1 |
| `approvalRequired` | approvalId, toolCallId, **diffProposal 全文（仅此一次）** | Chat 审批卡, Diff 面板 | P1 |
| `approvalResolved` | approvalId, decision: approved / rejected / modified, modifiedInput? | Chat, session | P1 |
| `toolExecuted` | toolCallId, durationMs, **affectedPaths: string[]（绝对路径；编辑器据此刷新打开的 buffer，ADR-0014）** | Chat, 调试, 编辑器 | P1 |
| `toolFailed` | toolCallId, error（执行期异常，区别于护栏拦截） | Chat | P1 |
| `observationAdded` | toolCallId, truncated, originalChars, finalChars, preview, **content（截断后完整内容，重放重建 tool-result 用，可选新增）** | Chat, 调试 | P1 |

### A4. Diff 提案

| 事件 | 载荷要点 | 主要消费者 | 引入期 |
|---|---|---|---|
| `diffProposed` | proposal 全文（与 approvalRequired 同发或紧随） | Diff 面板 | P1 |
| `diffResolved` | proposalId, status: accepted / rejected / expired | Diff 面板, Chat | P1 |

### A5. 上下文与记忆

| 事件 | 载荷要点 | 主要消费者 | 引入期 |
|---|---|---|---|
| `contextAssembled` | providers: [{id, tokens}], totalTokens, dropped: [providerId] | 调试 | P1 |
| `memoryCompressed` | threadId, compressedMessageIds: string[], summary, tokensSaved（**压缩决策与结果本身事件化**，重放据此确定性还原，ADR-0012） | Chat 提示, 调试 | P1 |
| `memoryExtracted` | facts: MemoryFact[] | Chat 弱提示 | P1 |
| `memoryRecalled` | factIds | 调试 | P1 |
| `memoryPinned` | fact: MemoryFact（source='user-pinned'，ADR-0021） | Chat 弱提示, 记忆面板 | P2.0 |
| `memoryUnpinned` | factId | 记忆面板 | P2.0 |
| `briefUpdated` | threadId, rev, hash, actor: 'user'\|'agent'（**仅审计**：简报文件为主，重放不重建，ADR-0021） | 调试, 简报面板 | P2.0 |
| `artifactStored` | ref: ArtifactRef（事件只带 hash+summary，序列化铁律，ADR-0021） | 产物面板, 调试 | P2.0 |
| `skillUsed` | name, scope, turnId（ADR-0022 记账） | 调试, 技能面板 | P2.0 |

### A6. 终止与预算

| 事件 | 载荷要点 | 主要消费者 | 引入期 |
|---|---|---|---|
| `budgetWarning` | kind: maxSteps / maxTurnTokens / timeout（与 TerminationReason 同名对齐，ADR-0014）, used, limit | 状态栏, Chat | P1 |
| `degradationStarted` | reason | Chat | P1 |
| `loopTerminated` | reason: natural / maxSteps / maxTurnTokens / timeout / loopDetected / userCancelled / modelError / fatal; finalSummary? | 全部 | P1 |
| `error` | source: model / tool / system, message, recoverable | Chat, 调试 | P1 |

### A7. Checkpoint（回滚）

| 事件 | 载荷要点 | 主要消费者 | 引入期 |
|---|---|---|---|
| `checkpointCreated` | turnId, files: [相对路径]（懒快照后发布） | 状态栏, Chat 横幅 | P1 |
| `checkpointRestored` | turnId, restoredFiles, 失败项 | Chat, session | P1 |

### A8. 注册表与模式（P2 关键）

| 事件 | 载荷要点 | 主要消费者 | 引入期 |
|---|---|---|---|
| `toolsChanged` | added: ToolSpec[], removed: string[], source: builtin / plugin（仅可序列化规格，**不含 handler**，ADR-0011） | Chat 工具面板, 调试 | P1（触发器 P2） |
| `modeChanged` | mode | 状态栏, Chat composer | P1 |
| `modelChanged` | model | 状态栏 | P1 |

## 4. 事件设计铁律【规范】

1. **只追加、不可变**：事件一经发布不得修改；状态恢复 = 重放。
2. **全部可 JSON 序列化**：大载荷（DiffProposal 全文）只随首个事件发送一次，后续按 id 引用。
3. **语义事件与流式 delta 分层**：`textDelta` 等增量事件允许 UI 节流合并（rAF / 16ms batch）；持久化保留全部事件。
4. **渲染层按 `seq` 排序去重**：跨进程到达顺序不保证，seq 是唯一排序依据。
5. **禁止在 payload 中夹带指令性内容**：payload 是数据，UI 不得将其解释为行为指令（与提示词注入防护同源，见 07 §4）。
6. **seq 由 EventSink 扇出点单点分配**：组合扇出（渲染层转发 + 日志落盘）在分发前统一分配 seq，保证两路消费者看到同一序号（ADR-0014）。
7. **payload 禁止携带函数**：凡进入事件的类型必须是纯数据（ToolSpec 而非 RegisteredTool，ADR-0011）。

## 5. 版本演进规则【规范】

1. 事件类型只新增；禁止修改已有 type 的 payload 语义；禁止删除事件类型。
2. 破坏性变更 = `schemaVersion` 递增 + 旧版本回放适配器（session 重放时按版本转换）。
3. 新增可选字段不递增版本；新增必填字段必须递增。
4. `LoopEvent` 的消费者（Chat/Diff/状态栏/调试/session/审计）各自声明"消费的事件集合"，新增事件时按表勾稽。

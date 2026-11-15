# 05 · 模块详细设计

> 每个模块给出：职责边界 / 关键设计 / 协作端口 / 交付里程碑。类型定义以 03 为准，事件以 04 为准。

## 1. domain（实体层）

**职责**：纯类型 + 纯规则函数，零框架 import，全部可表驱动单测。

**内容清单**：

| 类别 | 内容 |
|---|---|
| 类型 | ChatMessage / MessagePart / Session / Thread / Turn / LoopState / AgentTool / DiffProposal / Diagnostic / MemoryFact / LoopEvent |
| 规则纯函数 | `modeAllows(mode, tool)`、`isPathInsideWorkspace(path, roots)`、`isDangerousCommand(cmd)`、`hashToolCall(name, input)`、`truncateText(text, cap)`、`canonicalJson(obj)` |
| 常量 | §03.1 默认常量表 |

**禁止**：任何 IO、任何第三方 import、任何对 ports 的依赖。

## 2. ports（端口契约）

**职责**：内核所有的跨边界接口（见 03 §9）。本模块只有 `.ts` 类型文件，无实现。

## 3. agent-loop（执行引擎）

**职责**：编排、判停、熔断、降级。不持有任何 IO 能力。

### 循环骨架（规范性伪代码）

```
async function runTurn(turn, deps): Promise<void> {
  const state = initLoopState(turn)                       // LoopState 显式维护
  session.openTurn(turn); sink.publish(turnStarted)

  try {
    while (true) {
      // 1) 预算闸（warn → 硬停）
      checkBudget(state)                                  // 越线抛 BudgetExceeded

      // 2) 死循环闸
      if (state.contextHashStreak >= CONTEXT_HASH_STREAK) throw LoopDetected

      // 3) 装配请求（含记忆召回与上下文预算）
      const req = context.assemble(thread, turn, state)   // toolsDisabled 时 tools=[]
      sink.publish(contextAssembled)

      // 4) 模型流（abort 信号贯穿）
      sink.publish(stepStarted)
      const collected = { text: '', toolCalls: [] }
      for await (const ev of model.stream(req)) {
        sink.publish(toLoopEvent(ev))                     // delta 直接外流
        collect(collected, ev)
      }
      if (collected.finishReason !== 'tool-calls') return terminate('natural')

      // 5) 工具执行（逐个、串行）
      for (const call of collected.toolCalls) {
        const obs = await tools.execute(call, state)      // 管道见 §4
        appendObservation(state, obs)                     // 截断后的内容回灌
      }
      state.stepCount++
      sink.publish(stepCompleted)
    }
  } catch (err) {
    return degradeAndSummarize(state, err)                // 硬停不裸抛
  }
}
```

### 终止判定优先级【规范】

1. `finishReason !== 'tool-calls'` → `natural`（最高优先）；其中 `length`（输出被截断）按 natural 终止，但额外发布 `error { source: 'model', recoverable: true }` 提示用户
2. 预算：步数 / token / 墙钟任一越线（先 `budgetWarning` 80% 预警，再硬停）
3. 死循环：同一 `hashToolCall` 出现 ≥ `LOOP_REPEAT_THRESHOLD` 次，或 `contextHashStreak` ≥ 上限
4. 取消：`abort` 信号 → `userCancelled`（见 07 §6）
5. 模型错误：重试耗尽 → `modelError`

### 降级收尾【规范】

任何硬停路径不裸抛异常：置 `state.toolsDisabled = true`，用 cheap 模型发起一次"进展总结"请求（禁用工具），发布 `degradationStarted` → `loopTerminated { reason, finalSummary }`。用户始终被告知"做到哪了、为什么停"。

## 4. tool-runtime（工具运行时）

**职责**：注册表（唯一扩展点）+ 执行管道。

### ToolRegistry【规范】

- `register(tool: RegisteredTool)` / `unregister(name)` / `list(mode): ToolSpec[]` / `get(name)`；内部维护版本号。对外只暴露可序列化的 `ToolSpec`（ADR-0011）。
- 循环**每一步**重新读取注册表 → 支持会话中途动态增删工具（P2 插件依赖此语义）。
- `toolsChanged` 事件在注册表变更后发布。

### 执行管道（责任链，顺序固定）【规范】

```
Schema 校验(JSON Schema) → 模式过滤 → 确定性护栏 → 审批门 → handler → 结果截断 → observation
```

1. **Schema 校验**：input 不符合 schema → `guardrailTriggered { rule: schemaInvalid, action: blocked }`，工具不执行，错误信息回灌给模型。校验器为**内核内置零依赖子集**（type/properties/required/additionalProperties/enum/items/长度/数值范围，见 domain/rules/json-schema.ts）；完整 ajv 校验待需要时经适配器引入。
2. **模式过滤**：`modeAllows` 不通过 → 同上（双保险：schema 已过滤，这里兜底）。
3. **确定性护栏**（纯函数，规则来自配置数据，见 07 §4）：
   - `pathOutside`：路径解析后不在 workspaceRoots 内 → blocked（多根工作区按根列表逐一检查）
   - `dangerousCommand`：命令模式表命中 → blocked（P1 只对 P3 工具生效，规则先落）
   - `injectionWarning`：工具结果命中可疑指令模式 → 告警；命中时 write/execute 工具升级为强制 ask
4. **审批门**：按副作用等级与策略表决定 auto / ask / deny；ask 经 `ApprovalRequester` 端口跨进程询问；审批材料由工具的 `prepareApproval` 钩子产出（apply_diff 校验 hunk 后返回提案、write_file 合成旧/新对比）；`modified` 决策的 input **重新过一遍 Schema 与护栏**再执行；deny → `approvalResolved` + 回灌拒绝说明。
5. **handler 执行**：传入 `ToolContext`（含 abort signal）；超时与取消由 signal 控制。
6. **结果截断**：`truncateText(content, TOOL_RESULT_CHAR_CAP)`，记录 originalChars。
7. **产物拦截**【规范，ADR-0021】：截断前经 domain 纯函数 `decideArtifactCapture(result, thresholdTokens)`——超阈值结果整体写入 `ArtifactStore`（hash 寻址），observation 与事件只携带 `ArtifactRef`（hash+summary+size）；agent 需要细节时经 `read_artifact(hash, offset)` 分页取回。**事件里永远只有 hash，不放 blob**（序列化铁律）。
8. **observation 回灌**：`tool-result` part 拼入 messages，`observationAdded` 外流。

### 路径合法域【规范，ADR-0021】

- 守卫 `pathOutside` 的判定域从 workspaceRoots 扩为 **workspace ∪ 本任务 scratch 目录**（`userData/scratch/<threadId>/`，组合根注入）；域内写入按既有审批策略分流：workspace 写=审批+checkpoint，scratch 写=**免审**（agent 工作台，不进 git/checkpoint/上下文，任务删除随 GC）。
- 判定为 domain 纯函数 `isWritablePath(path, wsRoots, scratchRoot)`，适配器只提供根。

### PendingProposals【规范】

- `apply_diff` 执行成功后产生 `DiffProposal { status: pending }`，注册到本表；actual 写盘延迟到 accept（见 07 §2）。
- 会话关闭 / 应用退出 → 全部 pending 置 `expired` 并发布 `diffResolved`。

## 5. context（上下文装配）

**职责**：为每一步构建 `ModelRequest` 的 system + 上下文，管理 token 预算。

- **system prompt 组成**：基础人格 + 模式规则（plan/edit/explain 各自的行为约束与工具说明）+ 上下文贡献者产出 + 项目约定。
- **Provider 扇入**：内置 providers（当前文件、选区、诊断、项目结构）+ **长期记忆召回 provider（memory 模块以 provider 身份注册，ADR-0012）** + 未来插件 providers，统一走 `ContextProvider` 注册表；provider ctx 携带 `latestUserMessage` 供召回做相关性查询。
- **禁止 context 直接调用 memory**：记忆以贡献者身份进入装配管道，star 拓扑不被破坏（ADR-0012）。
- **预算分配**【规范】：每个 provider 按 priority 分配 token 配额；装配结果发布 `contextAssembled`（含 dropped 列表）；总预算 = 模型窗口 − 输出预留 − 历史消息占用。
- **统一贡献者仲裁**【规范，ADR-0021】：一切注入物（providers、简报、记忆召回、技能索引、消息流）统一为 `ContextContributor`（声明预算档 + 优先级类），经 domain 纯函数 `arbitrateContext(contributors, budgets)` 裁决——**context 不写 if-else 注入顺序**。裁剪优先级：全局记忆 → 提炼任务记忆 → 最老消息；**pinned 事实与系统提示永不裁**。新增注入种类 = 注册新贡献者（注册表扩展点，零改 context）。
- 装配产物计算上下文哈希（死循环检测用）。

## 6. memory（记忆策略）

| 层 | 策略【规范】 | 触发时机 |
|---|---|---|
| 瞬时 | 当前 `LoopState.messages`，Turn 结束交还 thread | — |
| 短期 | Turn 完成后估算 token，超阈值把最老 K 组消息压成 `summary` part（cheap 模型）；**以 tool-call/tool-result 配对组为最小压缩单元，禁止拆散配对** | 每次完成后检查 |
| 长期 | Turn 完成后提炼 preference/convention（cheap 模型），去重后 `MemoryStore.saveFact`；新 Turn 开始按相关度召回 top-k 注入 system | Turn 结束 / 开始 |

- 压缩与提炼都走 `ModelClient`（cheap 档）——内核内不允许出现第二条直连模型的路径。
- **压缩阈值【规范，P2】**：自动压缩阈值 = 当前生效模型 `contextWindow × 0.9`（`COMPACTION_THRESHOLD_RATIO`，shell 组装时按模型计算、configSave 切模型即更新）；内核兜底 `SHORT_TERM_TOKEN_THRESHOLD=80_000`。手动压缩：`thread.compact` RPC → `ThreadService.compactNow`（强制 threshold=0 压最老组，与自动共用 `runCompression` 同一条链；运行中拒绝）。UI 入口在容量圈下拉"立即压缩历史"。
- **空摘要防线【规范，P2】**：`compressIfNeeded` 对摘要模型返回空文本**按失败抛错**（绝不以空摘要替换真实历史——重放会吞掉原消息）；流式失败以 `finish{error}` 事件承载，summarize/提炼调用方必须转译为异常。
- **压缩事件化【规范】**：压缩的决策（哪些消息）与结果（摘要文本）本身作为 `memoryCompressed` 事件落日志；重放时按 `compressedMessageIds` 将对应消息替换为 `summary` part——保证 ADR-0008 的重放确定性。
- **压缩即沉淀**【规范，ADR-0021】：压缩执行时由 cheap 模型顺带提炼 3-5 条任务事实（scope='task'）写入条目记忆——**压掉 ≠ 忘掉**。
- **召回经 provider**：长期记忆召回由 memory 注册的 provider 在装配时完成（ADR-0012），不在 Turn 开始时另行调用。
- **条目记忆主从**【规范，ADR-0021】：pinned/提炼事实＝内核拥有 → 事件溯源（memoryPinned/Unpinned/Extracted 落事件日志），`userData/memory/tasks/<threadId>.json` 为可重建读模型；**简报**（BriefProvider 每轮注入，≤3k tokens）＝外部文档 → 文件为主，经 BriefStore 读现值，`briefUpdated` 仅审计。
- `memoryCompressed` / `memoryExtracted` / `memoryRecalled` / `memoryPinned` / `memoryUnpinned` / `briefUpdated` 事件全量外流。

## 6A. skills（技能，程序性知识）【P2.0，ADR-0022】

**职责**：跨任务可复用流程的扫描、索引注入与按需加载。独立于 memory（用户决策：技能不是记忆的子类）。

- **双作用域**：用户级 `userData/skills/<name>/SKILL.md` + 项目级 `<workspace>/.loomery/skills/<name>/SKILL.md`（可 git，团队共享）；manifest 只含 name/description/scope/entry（03 §8）。
- **索引注入**：`SkillIndexProvider` 以 ContextContributor 身份注册，只注入"名+触发描述"（~40 tokens/个）；**body 永不自动进上下文**。
- **按需加载**：`read_skill(name)` 工具（handler 走 SkillRegistry）；一轮内使用经 `skillUsed` 事件记账（可审计、可统计）。
- **首用确认**：项目级技能（来自 git 仓库，持久化注入面）首次使用经 `ApprovalRequester` 扩 confirm 种类询问用户；技能内脚本执行仍走 approval.execute 策略。
- **端口**：`SkillRegistry { scan(); readBody(name) }`（03 §9），实现落 memory-store 适配器；P2 技能市场经本模块对接。

## 7. session（会话状态）

**职责**：四级状态机 + 事件溯源持久化 + 恢复 + 取消令牌 + 用量聚合。

- **状态机**：`Session ⊃ Thread ⊃ Turn ⊃ Step`；Turn 状态迁移见 03 §3。
- **并发策略**【规范】：每个 Thread 同时最多一个活跃 Turn；再次发送则排队或提示（P1 选择：提示）。
- **事件溯源**【规范】：所有 `LoopEvent` 经 `EventSink` 分两路——①渲染层展示；②`MemoryStore.appendEvent` 追加事件日志（ADR-0023：默认 SQLite `events` 表，`LOOMERY_STORE=json` 回退 JSONL 文件）。不存独立"状态快照"，状态永远由重放推导。
- **恢复**（应用启动时组合根触发）：
  1. 重放各 thread 日志重建 Thread/Turn/消息状态；
  2. 上次运行中的 Turn 标记 `interrupted`；
  3. pending 的审批/diff 提案默认置 `rejected`/`expired` 并向用户说明（配置项可改为重新询问）；
  4. 发布 `threadResumed`。
- **内存治理【规范，P2】**：事件日志是事实源（引擎中立，ADR-0023 后=SQLite events 表），内核消息态是**可丢弃的读缓存**。四层机制——
  ① **懒恢复**：启动时组合根只 `seed` lite 元数据（标题/时间/项目/usage 折叠值，一遍读日志），消息留待首次使用（send/compactNow/getMessages）由 `ensureHydrated` 按需 rebuild（静默，未决审批落拒绝事件闭环）；启动内存从 O(全部历史消息) 降为 O(任务元数据)，启动读盘减半。
  ② **LRU 卸载**：驻留（已恢复）任务数超过 `RESIDENT_THREAD_LIMIT`（8）时，Turn 结束后按最久未用丢弃消息（运行中不可卸载），再次使用自动重建。
  ③ **usage 连续记账**：任务累计 token 单一字段贯穿生命周期——seed=启动折叠 / 恢复=事件重建真值 / 每 Turn 增量（`TurnResult.usage`）累加 / 卸载保留，跨卸载-恢复周期不丢不重。
  ④ **存储 GC【规范，P2】**：内存态有界后磁盘日志仍 append-only 无上界——每次压缩成功后（自动/手动共用链）把事件日志原子重写为**重放等价的稀疏事件流**（SQLite=事务内 DELETE+INSERT；JSON=tmp+rename）：被压缩消息的生成事件（textDelta/observation 等体积大头）整体删除、只保留最后一条 `memoryCompressed`（其摘要即折叠结果）；审计与统计基础永删不净（usageDelta/记忆事件/checkpoint/护栏/审批）；seq 原值保留（摘要 id=`restored_summary_<seq>` 跨重放/重写稳定）；重写前运行态摘要 id 对齐该口径（否则跨重启多轮压缩重放出重复摘要）。等价性由 `compactForStorage` 纯函数 + rebuild 前后全等测试锁定；`MemoryStore.rewriteEvents?` 为可选端口方法（缺省不 GC）。
  ⑤ **日志容错【规范，P2】**：JSONL 逐行容错解析（`parseJournalLines`，JSON 引擎与导入器共用）——崩溃残留的残行跳过并告警、uuid 重复行幂等去重，绝不让单行残缺拖垮整个任务的日志加载。
  策略落在用例层（`ThreadServiceDeps.residency` 可覆盖），组合根只装配不决策；换存储引擎（ADR-0023）策略不变。
  ⑥ **触发器埋点【规范，P2】**：恢复/重放耗时经 `ThreadServiceDeps.metrics.observe` 上报（`metrics.get` RPC 可查：bootMs/seedCount/foldListThreadsMs/hydrate{count,maxMs,slowCount}）；慢恢复（>2s，ADR-0023 触发器②）打 [metrics] 警告——迁移 SQLite 由数据说话，不盲飞。
  ⑦ **迁移边界【规范，P2】**：解析边界统一经 `migrateEvent`（JSONL 逐行 / SQLite 行水合）（domain/migrations，追加式步骤表）——旧版本信封沿链升级、未来版本透传；消费方永远只见当前版本。
- **运行中关窗确认【P2】**：有活跃 Turn 时点关闭 → native 对话框先问一次（进度已实时落盘，重启可续）；确认退出时主动 cancel 运行中 Turn（落 turnCancelled 审计），未及落盘部分由重启恢复按 interrupted 收尾；E2E/探针驱动豁免。
- **取消令牌**：每个 Turn 一个 `AbortController`；停止按钮 → `turnCancelled` + abort。
- **用量聚合**：token/费用按 Step/Turn/Thread 逐级累计，状态栏只读。
- **删除广播**【规范，ADR-0021】：`threadDeleted` 事件发布后，各适配器自行清理名下资源（任务记忆读模型、简报、scratch、artifacts 归属项）；决策在用例（广播），执行在适配器。

## 8. ai-sdk-adapter（模型适配器）

> **全局并发闸【规范，P2】**：所有模型流（main/cheap、全部任务）经 `Semaphore` 共享名额池（`maxConcurrency`，默认 4）——N 任务并发 busy 不会打爆 API；FIFO 公平排队，排队中被取消以 AbortError 出队。429 治理 = 全局上限 + 单请求退避重试两层。

**职责**：实现 `ModelClient`；**全工程唯一 import `ai` 包的位置**【规范】。

- 消息翻译：自有 `ChatMessage` ↔ SDK `CoreMessage`；工具声明转 SDK `tool()`（**`execute: undefined`**——执行权在循环手里）。
- 流归一化：SDK fullStream → `ModelStreamEvent`；`finishReason` 映射。
- 重试策略【规范】：429 / 5xx / 超时 → 指数退避重试最多 3 次，每次发 `retrying` 事件；耗尽后 `finish { finishReason: 'error' }`。
- 模型配置：`main` / `cheap` 两档，来自 shell 注入的配置（含 provider、modelId、baseURL、密钥引用——密钥本身见 07 §3）。

## 9. fs-tools（内置文件工具）

**职责**：实现 03 §5 表中 read/write 类工具的 handler；所有路径经 `isPathInsideWorkspace` 校验；**所有写操作先经 checkpoint 懒快照**（07 §5）。

| 工具 | 输入要点 | 输出 |
|---|---|---|
| `read_file` | path, offset?, limit? | 文件内容（带行号），二进制探测命中则返回占位说明 |
| `list_dir` | path | 目录树一层（含文件大小） |
| `search_text` | pattern, glob?, maxResults? | 命中行（file:line:text），条数与总字符双截断 |
| `write_file` | path, content | 写入结果；审批时合成"旧内容 vs 新内容"的 DiffProposal 供预览；写前懒快照 |
| `apply_diff` | path, hunks | hunk 上下文匹配校验（失败即返回可读错误回灌模型）；校验通过产出 DiffProposal；**写盘发生在审批 accept 之后**（handler 只在审批通过后执行） |

## 10. editor-gateway（渲染层适配器）

**职责**：在渲染进程实现 `EditorGateway` + 编辑器类 `ContextProvider`（当前文件/选区/诊断）。

- `applyEdit` 尊重 Monaco 撤销栈（用户可 Ctrl+Z）。
- 诊断来源 P1：Monaco 内置 worker；P3：lsp-bridge 归一化为 `Diagnostic`。
- 监听编辑器事件 → 发 `EnvironmentEvent`（经 `EnvironmentEventSource` 端口送达内核，context 据此失效 provider 缓存）。
- **外部修改刷新【规范】**（ADR-0014）：订阅 `toolExecuted.affectedPaths`，对已打开且无未保存修改的 buffer 静默重载；有未保存修改时提示用户——Agent 与用户的并发编辑显性化。

## 11. ipc-bridge（进程总线）

**职责**：main ↔ renderer 的类型化 RPC 与事件桥。P2 插件进程、P3 sidecar 复用同一信封协议（ADR-0005）。

**协议【规范】**：

```
请求/响应：channel = 'rpc/<service>/<method>'，消息 { v, id, channel, payload }
事件流：  channel = 'event/loop' | 'env-event'，消息 = LoopEvent | EnvironmentEvent
安全：    contextIsolation: true, nodeIntegration: false, preload 白名单暴露
大小限制：单消息 > 16MB 拒绝并返回错误（大载荷必须走文件引用）
```

main 侧实现：`ApprovalRequester`（转发到渲染层审批 UI，Promise 等待决策）、`EventSink` 转发、RPC surface。
renderer 侧：editor-gateway 的 RPC stub、审批 UI 的决策回传。

## 12. memory-store（持久化适配器）

- **P1【规范】**：JSON 文件——`userData/sessions/<threadId>.jsonl`（事件日志）+ `userData/memory/facts.json`（长期记忆）。避免原生模块编译成本。
- **P2.0 扩展【规范，ADR-0021/0022】**：本适配器扩为"持久化家族"——任务记忆读模型（`memory/tasks/<id>.json`）、BriefStore（`memory/tasks/<id>.md`，并发写 last-write-wins + rev 递增）、ArtifactStore（`artifacts/` hash 寻址 + index，LRU 封顶）、SkillRegistry（扫描 `userData/skills/` 与 `<ws>/.loomery/skills/`）——**四个仓库一个适配器**，P2 换 SQLite 只动本包。
- **P2（按触发条件，ADR-0023）**：SQLite 替换——范围"三迁三留"（迁：事件日志/事实索引/产物索引；留文件：简报 .md、技能 SKILL.md、产物 blob），JSON 结构已按 ADR-0023 表结构对齐；触发条件（任一命中）：任务数 > 50 / 启动重放 > 2s / 跨线程检索需求 / 插件宿主并发读；引擎优先 node:sqlite，实验标志未解除则退 better-sqlite3（届时 ADR 备案）。端口不变，只动本包。

## 13. shell（组合根）

**职责**：装配一切 + 进程/窗口/安全基线 + 启动恢复 + 优雅退出。业务代码绝不依赖 shell【规范】。

**装配清单【规范】**（`bootstrap()` 内一次性完成）：

| 端口 | 实现 | 位置 |
|---|---|---|
| ModelClient | ai-sdk-adapter | main |
| EventSink | session 持久化 + ipc 转发的扇出 | main |
| ApprovalRequester | ipc-bridge → 渲染层审批 UI | main→renderer |
| EditorGateway | 渲染层 editor-gateway（RPC stub） | renderer |
| ContextProvider×N | 内置 4 个 + 渲染层编辑器 providers | main/renderer |
| MemoryStore | memory-store(JSON) | main |
| Clock | 系统时钟 | main |
| RegisteredTool×5 | fs-tools 注册进 ToolRegistry | main |
| ConfigStore | memory-store 适配器（config.json，03 §11） | main |
| EnvironmentEventSource | ipc-bridge（转发渲染层编辑器事件） | main←renderer |

- 密钥：启动时从 OS keychain 读取，注入模型配置对象，仅在 main 内存传递（07 §3）。
- 启动：加载策略配置 → 装配 → 恢复会话（重放）→ 打开窗口。
- 退出：取消活跃 Turn → pending 审批/提案置 expired → flush 日志。

## 14. ui-renderer

见 [06-ui-layout.md](06-ui-layout.md)。约束：全部视图为谦卑对象——只消费事件归约出的视图模型，禁止业务判断【规范】。

## 15. plugin-sdk / plugin-host（P2）

**plugin-sdk**（对外发布的契约包）：
- manifest 规范：`name / version / publisher / signature(P2 企业预留) / activationEvents / contributes { commands, views, viewsContainers, agentTools, contextProviders }`。
- 宿主 API 白名单：`host.fs.read(path)`（带权限）、`host.workspace`、`host.registerTool(tool)`、`host.registerContextProvider(p)`、`host.ui`（受控组件）。插件**不直接操作 DOM**【规范】。

**plugin-host**（适配器）：
- manifest 扫描 → `activationEvents` 懒激活 → 每插件一个 utilityProcess → 同一 RPC 信封握手。
- 插件 agentTool → 包装为本地 `RegisteredTool { source: 'plugin', handler: RPC 往返 + 超时 }` 注册进 ToolRegistry。
- 权限代理：host API 调用经宿主校验（路径校验、权限表、首调授权 UI）。
- 崩溃隔离：插件进程崩溃自动重启（带退避），已注册贡献者撤销并 `toolsChanged` 通知。

**三种 UI 嵌入模式**【规范】：

| 模式 | 适用 | 隔离 | 实现 |
|---|---|---|---|
| 声明式视图（默认推荐） | 设置、列表、树、简单工具窗 | 无风险 | 插件传数据/schema，宿主组件渲染 |
| iframe / Webview | 自定义布局、图表、复杂表单 | sandbox + postMessage 白名单 | 插件提供 HTML 入口，宿主嵌入 |
| 富面板 | Markdown 所见即所得、图片/表编辑器 | 宿主管边框，插件填内容 | 仅可信插件 |

## 16. pty-adapter / task-adapter / sidecar-stub（P3）

- **pty-adapter**：实现 `TerminalProvider`（node-pty）；终端视图以**系统内置插件**身份走 P2 槽位机制（对 P2 架构的终极验收）。
- **task-adapter**：实现 `TaskProvider`；项目类型检测（package.json / pyproject.toml / go.mod / Cargo.toml）；任务输出解析器 → 结构化 `Diagnostic[]`。
- **sidecar-stub**：gRPC/JSON-RPC 接口桩（大文件索引），仅编译通过。

## 17. 关键时序

### 17.1 一轮对话主链路

```
用户         Chat视图(渲染层)        IPC总线           Main(agent-core)            外部
 │ 输入请求        │                   │                   │                       │
 ├───────────────►│                   │                   │                       │
 │                ├── chat.send ─────►│── openTurn+run ──►│                       │
 │                │                   │                   ├── context.assemble    │
 │                │                   │                   ├── ModelClient.stream ─►│ LLM API
 │                │◄═ textDelta 事件 ═╪══════════════════╡◄──────流式─────────────┤
 │                │                   │                   │◄─ finish: tool_calls ──┤
 │                │                   │                   ├── toolRuntime.execute  │
 │                │                   │                   │    ├ 护栏(纯函数)        │
 │                │◄═ 审批请求+diff ══╪══════════════════╡    ├ ApprovalRequester │
 │ 接受/拒绝       ├── decision ──────►│──────────────────►│    │                  │
 │                │                   │                   │    ├ handler(fs适配器)  │
 │                │◄═ observation ═══╪══════════════════╡    └ 截断→observation   │
 │                │                   │                   ├── 回灌 → 下一轮 while    │
 │                │◄═ loopTerminated ═╪══════════════════╡ (自然/预算/死循环→降级)  │
```

### 17.2 审批 + Diff + checkpoint

```
apply_diff 请求 → 管道护栏 → 审批门(ask)
  → approvalRequired { diffProposal } ──► Chat 审批卡 + Diff 面板
  → 用户 Accept
      → checkpoint 懒快照原文件（首次触碰该路径时）
      → fs 写盘 → toolExecuted → observationAdded
  → 用户 Reject
      → 不写盘 → observation 回灌"用户拒绝了此修改[原因]"
```

### 17.3 会话恢复

```
启动 → shell.bootstrap → MemoryStore.loadEvents(threadId)
     → session.rebuild（重放重建 Thread/Turn/消息）
     → 运行中 Turn 置 interrupted；pending 审批置 rejected+说明
     → checkpointCreated 历史 → 状态栏恢复"可回滚"横幅
     → UI reducer 消费重放事件 → 界面还原
```

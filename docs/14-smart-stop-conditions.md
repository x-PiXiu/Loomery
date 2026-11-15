# 14 智能停止条件设计（StopPolicy）

> 状态：**被 docs/15 取代为主判定方案**——用户定稿"agent 自行决定任务是否结束，步数/Token 只作保底"。本文的信号驱动 steer（§5 决策表）降为后续可选增强；三闸保底逻辑（§1/§3）继续有效。
> 关联：ADR-0025（分级信任）、ADR-0026（计划分解）、docs/12 §循环治理、`domain/constants.ts` 三闸
> 方法论：architect-handbook 整洁架构四层 + "先简单后复杂"防过度设计

## 1. 现状（三闸静态阈值）

| 闸 | 值 | 位置 | 触发后 |
|---|---|---|---|
| maxSteps | 40 步/轮 | `checkBudget` | BudgetExceededError → degrade（cheap 模型总结收尾） |
| maxTurnTokens | 1M tokens/轮 | 同上 | 同上 |
| maxWallMs | 600s 活跃时间 | 同上 | 同上 |
| 预警 | 单次 budgetWarning（80%） | `warn()` | 事件通知 UI，不改行为 |
| 收尾提醒 | 剩余 ≤6 步注入提示 | budgetHint | 只看步数，文案固定 |
| 死循环 | 上下文哈希连击 + 重复调用软(3)硬(5)阈值 | 主循环 | 熔断 |

## 2. 四个盲区（为什么不"智能"）

1. **不看产出，只看消耗**：38 步全在写文件的高效任务与 38 步反复 list_dir 的空转任务，撞同一条 40 步线。前者被冤杀，后者被养到熔断才杀。
2. **提醒与形态无关**：研究型任务在 70% 时最该听到"别再探查了"，产出型任务在 70% 时最该听到"留步数做验证收尾"——现在两者收到同一句话。
3. **计划进度未被利用**：ADR-0026 的 plan_write 全量快照（planUpdated 侧通道）已经携带"任务完成度"，但停止决策完全没有消费它——计划全完成就该主动收尾，不必等步数耗尽。
4. **Token 闸形同虚设**：1M 上限在压缩（0.9×contextWindow）面前几乎不可能触发，真正先到线的永远是步数——Token 数据没有参与任何决策。

## 3. 设计原则（整洁架构映射）

> 依赖规则：外层知道内层，内层不知道外层。"什么时候该停"是业务规则 → 实体层；"如何采集信号"是细节 → 外层。

```
frameworks(agent-loop) ──消费──▶ use-cases(LoopStopAdvisor) ──调用──▶ entities(evaluateStop 纯函数)
      │                                  │
      └─ 信号采集（LoopState/repeatCounts/toolExecuted/planUpdated） 全部已存在，零新增 I/O
```

- **Domain**（`packages/domain/src/stop-policy.ts`）：`StopSignals` 进、`StopAdvice` 出的**纯函数**。策略即数据、即代码可测——不依赖模型、事件总线、存储。
- **Use cases**（agent-core 内装配）：`LoopStopAdvisor` 组装信号 → 调用纯函数 → 把 advice 转译为动作（注入提醒/提示收尾）。**硬闸保留**：`checkBudget` 的三闸永不删除（防御纵深——智能层判断失误时安全网兜底）。
- **Frameworks**：assembler 的 `budgetHint` 是现成注入点，只消费 advice 生成的字符串；pipeline 的 `planUpdated` 侧通道是现成信号源。内核主干逻辑不动。
- **不需要新 Port**：全部信号在循环内已有；若 v3 要做跨任务统计学习，才引入 MetricsPort——现在不做（YAGNI）。

## 4. 领域模型（核心契约）

```ts
/** 循环每步采集一次的信号快照（全部零新增 I/O） */
export interface StopSignals {
  stepsUsed: number; maxSteps: number;
  tokensUsed: number; maxTokens: number;
  wallMsUsed: number; maxWallMs: number;
  /** 边际产出：最近 K 步滚动窗口 */
  marginal: {
    windowK: number;            // 窗口大小（默认 5）
    filesTouched: number;       // 窗口内 write 类工具成功次数
    observationGrowth: number;  // 窗口内观察新增字节（有新信息≠原地打转）
    distinctCalls: number;      // 窗口内不同"工具+参数指纹"数（repeatCounts 指纹复用）
  };
  /** 计划进度（planUpdated 全量快照，ADR-0026；无计划为 undefined） */
  plan?: { done: number; total: number };
  /** 工具形态比：判定任务形态（产出型 write 占比高 / 研究型 read 占比高） */
  toolMix: { writes: number; reads: number };
  /** 循环 strikes（现有软阈值计数） */
  loopStrikes: number;
}

export type StopAdvice =
  | 'continue'          // 正常
  | 'steer'             // 注入差异化提醒（带剩余量 + 已产出统计）
  | 'graceful-finish'   // 建议立即收尾（下一步注入"只许总结/收尾"指令）
  | 'hard-stop';        // 触发现有熔断（安全网仍保留原抛错路径）

/** 纯函数：策略即数据，表驱动可测 */
export function evaluateStop(s: StopSignals): { advice: StopAdvice; hint?: string };
```

## 5. 决策规则（v1，表驱动）

| 条件（按优先级） | advice | 依据 |
|---|---|---|
| 任一硬闸命中 | hard-stop | 原三闸不变 |
| loopStrikes ≥ 硬阈值 / 哈希连击 | hard-stop | 现有死循环熔断 |
| plan 全完成（done===total>0） | graceful-finish | 完成度信号优先于消耗 |
| 边际产出 ≈0（windowK 步 filesTouched=0 且 observationGrowth<阈值 且 distinctCalls≤2） | graceful-finish | 边际递减：原地打转不必养到 40 步 |
| 步数 ≥85% **或**（研究型且 ≥70% 且 filesTouched===0） | steer | 差异化文案：带"已写 N 文件/M 步探查"统计 |
| Token 速率外推：预计用完步数时 tokens > maxTokens×0.9 | steer | Token 参与决策（大输出模型提前收） |
| 其余 | continue | — |

**滚动续期（P2，产出型宽限）**：`maxSteps` 到线时，若最近窗口仍在持续产出（filesTouched>0），预算弹性 +N 步续期——"40 步"从死线变成"40 步无产出才死线"。防失控护栏：续期最多 3 次、总步数封顶 80。

## 6. 分阶段实施

- **P1（本设计核心，~150 行+单测）**：`domain/stop-policy.ts` 纯函数 + 表驱动单测；agent-loop 采集信号（~20 行：write 类名单判定、观察字节累计、窗口指纹数）+ budgetHint 改为 advice 驱动（steer/graceful-finish 两种文案，含统计数字）。
- **P2**：滚动续期预算；degrade 文案携带产出统计（"已写 12 文件，剩 3 计划项未完成"）；soft 提醒与 StopPolicy 合流（repeatCounts 软阈值并入 marginal 判定）。
- **P3（可选）**：胶囊显示"本轮剩余预算"；跨任务步数分布统计（需 MetricsPort，先不做）。

## 7. 明确不做（防过度设计）

- ❌ 模型自评估"我完成了吗"打分——额外调用成本高且自评不可靠
- ❌ 跨任务学习型阈值——单用户数据量不足，规则可解释性优先
- ❌ 复杂多臂策略对象——v1 一个纯函数 + 一张表，够用

## 8. 测试策略

- `evaluateStop` 表驱动单测：每信号维度 × 每 advice 分支（含边界：恰好 85%、窗口恰满 K 步、plan done=total-1）
- agent-loop 集成（FakeModel 脚本）：①研究型 0 产出任务在第 K 步收到 steer 而非等到 38 步；②plan_write 全完成 → graceful-finish 提示注入；③硬闸命中路径回归不变
- 回归红线：现有 245 测试不动语义（budgetWarning 事件、BudgetExceededError、degrade 链保持原契约）

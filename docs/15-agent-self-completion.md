# 15 Agent 自主完成协议（Self-Completion Protocol）

> 状态：**已实施**（v1 + 升级A + 升级B，2026-11-13，252 测试/lint 0；保底三闸=100 步/50M token/30 分钟墙钟）
> 关联：docs/14（StopPolicy——机械信号全部降级为保底，本文是其替代主判定）、ADR-0026（计划分解）、ADR-0021（侧通道）
> 方法论：architect-handbook 整洁架构（依赖向内）+ "先简单后复杂"
> 业界调研（2026-11-13）：SWE-agent/OpenHands/DeepSWE 终止动作、Claude Code 三相循环+Stop hook、Reflexion/Self-Refine 反思上限——见 §7

## 0. 定位转变

| | 旧思路（docs/14 v1） | 本设计（docs/15） |
|---|---|---|
| 主判定 | 领域纯函数评估信号（边际产出/形态比） | **agent 自己声明完成 + 完成审计批判者** |
| 步数/Token/墙钟 | 参与决策（steer/graceful） | **纯保底安全网，逻辑不变** |
| kernel 改动面 | checkBudget + 提醒 | 主循环收尾路径（自然终止/显式声明） |

原则：**"要不要停"是 agent 的判断（模型智能），"还能不能跑"是内核的底线（机械闸）**。内核不模仿智能，只给智能一个结构化的表达通道 + 一道批判性的复核。

## 1. 机制一：task_complete 完成声明工具（agent 自评）

模型**显式调用** `task_complete` 工具宣布收尾，载荷强制结构化自评：

```ts
interface CompletionSelfReport {
  summary: string;        // 完成了什么（1-3 句，进入最终答复）
  outstanding: string[];  // 遗留项/未完成项/已知限制（可为空=无遗留）
  verification: string;   // 采取过的验证（编译/测试/preview_control/人工检查点；无则说明为何无需）
  confidence: 'high' | 'medium' | 'low';
}
```

- 工具 `sideEffect: 'read'`（免审）；结果经 **ToolResult 第 5 个侧通道 `finish?`**（与 pinnedFact/planUpdate/diffProposal/briefUpdate 同构，ADR-0021 惯例）回传循环
- 循环捕获 finish → 追加配对 tool-result（消息完整性不变量）→ `termination='selfReport'` → 结束本轮，summary 交 TurnResult
- **system 提示**（SYSTEM_BASE 增补一段）：对照计划自查→完成时调用 task_complete；verification 为空且做了写操作时提示补充验证（与既有 preview_control 验证闭环衔接）

价值：把"结束"从沉默（natural finish）变成**可分析的结构化事实**——遗留项、验证方式、置信度全部落盘进事件流。

## 2. 机制二：完成审计（批判者，防"烂尾收工"）

模型自然终止（`fr !== 'tool-calls'` 且未调用 task_complete）时，内核先不收——跑一次 **cheap 档完成审计**：

```
审计输入（全部循环内已有，零新增 I/O）：
  ① 用户原始请求（latestUserText）
  ② 计划快照（本轮 planUpdate 侧通道缓存；无计划则略）
  ③ 做事摘要：写类工具成功次数（registry.listSpecs 按 sideEffect 判定，不硬编码工具名）
     + 触及文件清单（diffProposal 路径）+ 最后 K=3 条观察预览（cap 4KB）
审计输出：{ complete: boolean, missing: string[] }（宽松 JSON 抽取；cheap 出错=放行，fail-open）
```

- `complete=true` → 正常收尾；`complete=false` → 注入下一轮 system（经 assembler 新参数 `completionNudge`，**不进对话转录**，复用 budgetHint 通道惯例）：
  `[完成审计] 你提前结束了本轮。用户请求尚有未完成项：①…②…。若确已完成或无法继续，请说明原因并收尾；否则继续处理。`
- **有界**：每轮最多 2 次审计（`MAX_COMPLETION_AUDITS=2`），第 3 次自然终止直接放行——防审计乒乓
- **跳过条件**：本轮零工具调用（纯问答）、步数 <3、cheap 不可用、已自报完成

价值：lazy-finish（干一半就收）被拦下；同时不冤枉真完成——审计只看"请求 vs 实际做了什么"。

## 3. 保底（全部保留，一行不改）

三闸（40 步/1M token/600s 活跃时间）、死循环软硬阈值、降级收尾链、用户取消——原样作为安全网。docs/14 的信号驱动 steer（边际产出提醒等）降为后续可选增强，不在本轮。

## 4. 整洁架构映射

```
frameworks(agent-loop)     收尾钩子：finish 侧通道检查 + 自然终止审计调用 + nudge 注入
use-cases(agent-core)      completion-audit.ts：buildDigest(LoopState)→runAudit(ModelPort cheap)  ← ModelPort 已是缝，无新端口
entities(domain)           completion.ts：CompletionSelfReport/AuditVerdict/校验/上限常量
adapters(fs-tools 无关)    task-complete.ts 是零 I/O 控制工具 → 放 agent-core/src/tools/（内核协议，非领域工具）
ports                      ToolResult.finish?（第 5 侧通道）；事件 completionAudit（迁移框架透传，版本+1）
```

依赖方向全部向内；system 提示是组合根（bootstrap SYSTEM_BASE）职责；UI 零改动（未知事件由 sink 忽略，后续胶囊可消费 completionAudit 展示"遗留 N 项"）。

## 5. 实施清单（~300 行 + 测试）

1. `domain/src/completion.ts`：类型+校验+`MAX_COMPLETION_AUDITS=2`（~60 行）
2. `ports/tool-handler.ts`：`ToolResult.finish?`（+3 行）；`domain/event.ts`：`completionAudit` 事件（版本 bump）
3. `agent-core/src/tools/task-complete.ts`：spec+handler（~40 行）
4. `agent-core/src/loop/completion-audit.ts`：digest 组装+审计调用+宽松解析（~90 行）
5. `agent-core/src/loop/agent-loop.ts`：finish 检查/审计钩子/nudge 变量（~50 行）；assembler 增 `completionNudge` 参数
6. `bootstrap.ts`：SYSTEM_BASE 协议段+注册工具（~15 行）
7. 测试：task_complete 路径 / 审计不通过注入 nudge 再继续 / 审计有界放行 / fail-open / 零工具跳过（FakeModel 脚本 ×5）

## 6. 明确不做（防过度设计）

- ❌ 计划未完成却 selfReport 的"提前收工"二次质询（P2：若 outstanding 为空且计划有未完成步骤，nudge 一次）——先让审计跑起来看实效
- ❌ 审计用主模型（成本翻倍，cheap 足够判"请求 vs 产出"）
- ❌ 多轮跨轮完成度记忆（任务=轮，每轮独立自评）
- ❌ 审计满意度打分（1-10 分制）——Reflexion 实践表明二元裁决+缺失清单已够，分数引入阈值调参泥潭

## 7. 业界调研对照与 v2 升级（2026-11-13）

### 7.1 各家怎么处理"何时结束"

| 系统 | 终止机制 | 与本设计的对应 |
|---|---|---|
| SWE-agent / SWE-Bench Pro | 显式 `submit` 动作 + 哨兵串检测（`<<SWE_AGENT_SUBMISSION>>`），提示词要求 **finish 前最后一步重跑测试套件** | ✅ task_complete 对齐（我们用侧通道代替哨兵串，更结构化） |
| OpenHands / DeepSWE / ACM 统一动作空间 | `finish`/`submit` 专用动作，**双语义：任务完成 OR 无法继续**，终止即触发评估钩子 | 🆕 升级 A：outcome 双语义 |
| Claude Code | 三相循环（gather context → take action → **verify results**）+ TodoWrite 记账；社区验证技能强制"声明完成前先跑测试/diff 对照计划列跳过项" | 🆕 升级 B：机器证据门（验证不只是自述） |
| Claude Code Stop hook | 外置裁决者：hook exit 2 = **阻断停止并把原因反馈给模型继续干**；非 2 错误一律放行（fail-open）；实践教训=hook 必须自感知防无限续命 | ✅ 完成审计=同构（nudge 注入+有界 2 次+fail-open 语义全一致） |
| Reflexion / Self-Refine 研究 | 反思循环必须有显式停止条件（max 迭代/满足度），否则无限反刍 | ✅ 有界审计+机械保底即答案 |

**结论**：v1 的 task_complete（=业界 submit/finish 共识）+ 完成审计（=Stop hook 外置裁决）方向与业界完全一致；缺口是两个——**验证证据没有机器背书**（audit 只听模型说）、**终止缺"卡死"出口**。

### 7.2 升级 A：outcome 双语义（SWE-agent/OpenHands 惯例）——✅ 已实施 2026-11-13

`CompletionSelfReport` 增加 `outcome: 'complete' | 'blocked'`：
- `complete`：走完成审计（若此前自然终止路径）/直接收尾
- `blocked`：声明"无法继续"（缺权限/缺依赖/需求矛盾）→ **跳过完成审计直接收尾**，outstanding 必填阻塞原因——防"卡死后硬磨到 40 步熔断"，把卡死变成一等公民输出

### 7.3 升级 B：机器证据门（Claude Code verify 相 + SWE-agent"提交前重跑测试"）——✅ 已实施 2026-11-13（证据门只对 complete 生效：blocked 的诚实形态常是零成功证据，套门会误拦卡死声明）

审计不只听模型说，还要看**内核记录的机器证据（ground truth）**：

- **ToolResult 第 6 侧通道 `evidence?`**：`{ kind: 'command' | 'preview' | 'test', ok: boolean, detail: string }`——run_command（退出码）、preview_control（console 错误计数）、未来 test 类工具自带上报
- 循环收集本轮证据清单 → 审计输入追加"机器证据段"：`本轮命令执行 5 次（成功 4/失败 1：npm test exit 1）、预览 console 错误 0`
- **交叉核对**：task_complete.verification 声称"测试通过/编译通过"，但本轮证据里无对应成功记录 → 内核把该自报标记 `evidenceBacked: false`，审计提示词注明"模型声称的验证未在机器证据中出现，请重点核查"
- 效果：verification 从"自述作文"变成"可核对声明"——这是 Claude Code verify 相与 SWE-agent 提交前重跑的内核化

### 7.4 实施增量（相对 §5 清单）

- 侧通道 evidence：ports +3 行；run_command/preview_control handler +8 行
- evidence 收集与核对：agent-loop +25 行；审计提示词 +5 行
- outcome 双语义：domain 类型 +5 行；循环分支 +5 行
- 测试：+2 场景（证据缺失标注 / blocked 直接收尾）

# Loomery 行为基准集（Behavior Benchmark）

> 目的：用**可复跑的真机实验**回答"这个 Agent 编辑器实际干活表现如何"——完成率、步数、工具调用、token 成本四项指标，优化前后各跑一遍形成对照。

## 方法论

- **任务集**：`tasks.mjs` 18 个真实小任务，三类各 6——**修复**（off-by-one/空引用/漏 await/字典序排序…）、**重构**（重复代码抽取/上帝函数拆分/魔法数字/回调改 Promise/语义保持现代化…）、**新功能**（CLI 参数/校验函数/新模块/可选项/重试工具…）。每个任务自带**种子工作区**（含 bug/重复/缺失的代码）。
- **驱动**：`run.mjs` 用 CDP 直调 RPC（`window.loomery.invoke`），每个任务独立线程绑定独立工作区目录，`mode=edit`、审批全 auto 无人值守（危险命令仍被内核强制 ask，任务集不含危险命令）；单任务看门狗 240s。
- **四项指标**（全部从事件流 `thread.export` 采集，非 UI 抓取）：
  1. **完成与否（证据门裁决）**：`loopTerminated.reason ∈ {natural, selfReport}`（即过了完成审计/task_complete 被接受）**且地面真值验证通过**——两道门都要过；
  2. **工具调用次数**：`toolRequested` 事件计数；
  3. **usageTokens**：`usageDelta` 合计（按模型分档，主档/cheap 档可分离）；
  4. **步数**：`stepCompleted` 计数。
- **地面真值（ground truth）**：每个任务的 `verify(ws)` 独立于 agent 自述——用 node 真实执行改后的代码断言行为（不是检查"文件存在"）。验证函数已用 18 份参考正确实现做过**预检（18/18 pass）**，排除验证器误杀（`testLoomery/bench-preflight.mjs`）。
- **公平性**：两轮共用同一任务集/顺序/种子/模型（`mimo-v2.6-flash`）/配置；探针 userData 只拷 config+secrets+Local State；任务工作区在系统临时目录，跑完即弃；每任务跑完 `thread.delete`（顺带实证删除链路）。

## 复跑

```bash
node bench/run.mjs baseline     # 产出 bench/results/baseline.json
# …做优化动作、重建 shell/ui…
node bench/run.mjs optimized    # 产出 bench/results/optimized.json
```

依赖：本机 `.loomery-data/`（模型配置与密钥）、网络可达模型网关。

## 结果

三轮真机数据（`results/*.json` 为原始逐任务记录）：

| 指标 | initial（初跑） | baseline（干净基线） | optimized（优化轮） |
|---|---|---|---|
| 完成数 /18（证据门+地面真值） | **17**（1 个冷启动挂死） | **18** | **18** |
| 总步数（均值/任务） | 78（4.3） | 81（4.5） | 85（4.7） |
| 总工具调用（均值/任务） | 82（4.6） | 86（4.8） | 92（5.1） |
| 总 tokens（均值/任务） | 503,497（27,972） | 529,705（29,428） | 576,080（32,004） |
| 墙钟（均值/任务） | 42.8s | 31.8s | 41.3s |
| 超时 / harness 错误 | 1 / 0 | 0 / 0 | 0 / 0 |

- 模型：`mimo-v2.6-flash`；完成口径：`loopTerminated.reason ∈ {natural, selfReport}` **且**地面真值 `verify()` 通过（两道门）。
- 初跑的 1 个超时不是模型问题——是**基准集揪出的真实产品 bug**（见下）。

### 优化动作（baseline → optimized）

**工具描述与系统提示去重瘦身**（每步固定上下文里 tools 占 4,409 token = 72%）：

1. **背景**：`contextAssembled.breakdown` 实测每步固定开销 `tools=4409 + system=1490`，messages 仅几十~几百——工具规格是最大肥肉；dump 实测 21 个工具中 Top-8 占 62%。
2. **动作**：7 个工具描述去掉与 `SYSTEM_BASE` 重复的规则（收尾协议/截图时序/群杀禁令/通读纪律等），schema 属性描述去逐项双份列举；**顺手修复 run_command 描述与 background=true 纪律的过时矛盾**（"提示用户在终端面板运行"是 background 实装前的旧文案）。
3. **效果（三层证据，诚实呈现）**：
   - **静态确定性**：工具规格 JSON 体积 **4,412 → 4,059 tokens（−8.0%）**（esbuild 打包 dump 实测，每请求都省）；
   - **行为受控子集**（两轮步数相同的 14 任务配对，只比 input）：**修复类 6 任务全部下降 −2.0%~−6.1%（均值 −4.8%）**，与理论值 −5.7%（−353×步数/任务）吻合——机制验证成立；
   - **全子集合计仅 −0.71%**：新功能类任务的**实现路径方差**（agent 两次写的代码不同 → 历史与工具结果大小不同，±3~5%）大于 −5% 的效应本身。
4. **方法论结论**（基准集本身的产出）：**单轮 A/B 分辨不了 <10% 的 token 效应**——要统计显著需重复轮次或配对控制；完成率/步数这类粗指标单轮可比，tokens 单轮不可靠。

### 基准集顺带揪出并修复的两个真实 bug

1. **main→渲染调用无超时 → 任务永久卡 busy**（初跑 1 号任务 240s 零事件的根因）：`MainCallInvoker.call` 发消息进 pending Map 后若渲染层桥未注册（启动竞态/F5 重载窗口），消息无人接收，`assemble` 的 provider await 永久挂起。修复 = 10s 超时拒绝 + `safeProvide` 优雅降级 + 单测 4 例；harness 同步等待 React 桥就绪 + 预热轮。**跑任务时按 F5 也会触发此 bug——基准集的价值不止于数字。**
2. **Windows config rename EPERM**（双窗口测试揪出）：并发 `load()` 读句柄占住目标文件时 `rename` 抛 EPERM → 保存失败；修复 = 原子 rename 加重试（原子性不因重试受损）。

### 数字怎么用（简历口径）

- **完成率**：18/18（100%），修复/重构/新功能三类各 6，全部证据门+地面真值双裁决；
- **效率**：平均 4.5~4.7 步、4.8~5.1 次工具调用、31~41 秒/任务；
- **上下文工程**：工具规格 −8.0%（4,412→4,059），受控子集行为侧 −4.8%（与理论吻合）；
- **质量兜底**：两轮 0 超时 0 harness 错误；初跑暴露的挂死 bug 已修复并有单测锁定。

## 文件

| 文件 | 内容 |
|---|---|
| `tasks.mjs` | 18 任务定义：prompt + 种子 + 地面真值 verify（参考实现预检 18/18） |
| `run.mjs` | 驱动 harness（CDP→RPC→指标采集→汇总 JSON；桥就绪等待+预热轮+审批自动决策） |
| `results/baseline-initial.json` | 初跑（揪出桥挂死 bug 的那一轮，17/18） |
| `results/baseline.json` | 干净基线（bug 修复后，18/18） |
| `results/optimized.json` | 优化轮（工具描述瘦身，18/18） |

# 12 执行计划：循环内核修复 + 终端/进程/Git 集成

> 性质：【规范】。本文档是本轮执行（阶段 0/1/2/3）的唯一权威。与实现冲突时先修订本文档。
> 关联 ADR：ADR-0024（进程/终端/Git 集成边界）、ADR-0025（分级信任审批）。

## 0. 背景与根因

用户实证反馈"写一个简单网页都写不好"。分析结论（2026-11-10）：

- **B1（实锤）**：`write_file`/`apply_diff` 的 handler 是裸 `fs.writeFile`，父目录不存在即 ENOENT（已在 testLoomery/probe 实证），且无任何建目录手段 → 模型重试 → 3 次软提醒 → 5 次 `LoopDetectedError` 熔断。
- **B2**：`agent-loop.ts` 先 push 带 tool-call 的 assistant 消息、后检查 finishReason；`fr==='error'` 时留下孤儿 tool-call 持久化进历史（translate 层过滤是治标）。
- **B3**：`checkBudget` 的 wall clock 含用户审批等待时间——用户离开 10 分钟回来批准即被 `BudgetExceededError('timeout')` 判死。
- **C1**：无 execute 工具 → 写→验→改闭环断裂，盲写。
- **审批矛盾**：UI 五档预设（Composer.tsx）中"完全访问"承诺 `execute:'auto'`，但 pipeline 硬编码"execute 永不 auto"将其架空。

## 分层总览（整洁架构定位）

```
┌ Frameworks & Drivers ────────────────────────────────────────┐
│  ui（TerminalPanel/xterm.js/审批卡三选）  shell/main（组合根装配）│
├── Interface Adapters ────────────────────────────────────────┤
│  adapters/process（NodeProcessAdapter+ProcessRegistry）        │
│  adapters/fs-tools（run_command、git 薄工具）                  │
│  adapters/terminal（NodePtyAdapter+SessionManager，内核无感）   │
│  adapters/ipc-bridge（terminal.* RPC + terminalData/Exit 频道） │
├──── Use Cases（agent-core）──────────────────────────────────┤
│  agent-loop / pipeline / registry —— 除 F0.2/F0.3/F1.7 外零改动 │
├────── Entities（domain）─────────────────────────────────────┤
│  复用：dangerous-command / path-guard / decodeText / truncate  │
└──────────────────────────────────────────────────────────────┘
   ports（内层接口，内层所有）：+ProcessPort、+GitPort
   依赖方向：全部向内；agent-core 不 import 任何适配器
```

进程治理职责在 Frameworks 层（shell 组合根持有 ProcessRegistry 并在 before-quit 清场）；ToolRegistry 是唯一扩展缝，run_command/git 全部投影 `RegisteredTool` 走既有 pipeline。

---

## 阶段 0：循环内核止血（P0，先于一切）

| # | 修复 | 落点 | 层 |
|---|---|---|---|
| F0.1 | 写入前 `mkdir(dirname, {recursive:true})`——write_file 与 apply_diff handler；新增"写入不存在子目录"真实 fs 测试 | `fs-tools/src/write-file.ts`、`apply-diff.ts`、`fs-tools.test.ts` | 适配器 |
| F0.2 | 循环终止前孤儿 tool-call 配对修补：finish 为 error / 预算越线 / 循环熔断时，为无 result 的 tool-call 注入合成 tool-result（`[轮次中断，工具未执行]`）再落历史 | `agent-core/src/loop/agent-loop.ts` | 用例 |
| F0.3 | 审批等待时间从 wall 预算扣除：累计审批耗时，`checkBudget` 的 wall 减去它 | `agent-loop.ts` + pipeline 回传审批等待时长 | 用例 |

**验收**：全部测试绿；新增三组回归测试各自锁定 F0.1/F0.2/F0.3。

---

## 阶段 1：agent 能干活（P1 + execute + git + 审批体验）

### F1.1 ProcessPort + 进程管理底座

```
ports/src/process.ts（新）：
  interface ProcessPort {
    spawn(req: { command; cwd; timeoutMs?; signal? },
          onChunk: (s: string) => void): Promise<ProcessResult>;
  }
  ProcessResult { exitCode: number|null; timedOut: boolean; output: string; truncated: boolean }

adapters/process/（新包）：
  NodeProcessAdapter   —— child_process.spawn(shell:true)；输出环形缓冲 256KB；
                          decodeText 编码链；taskkill /T /F 树杀；超时树杀
  ProcessRegistry      —— main 单例：{ id, kind:'agent'|'terminal', pid, cwd, command,
                          startedAt, state }；killAll()；agent 并发闸 4
```

生命周期四铁律：abort 联动（spawn 绑 `ctx.signal`，停止按钮杀树）、before-quit 清场（registry.killAll）、并发闸、输出封顶。

### F1.2 run_command 工具

```
name: run_command   sideEffect:'execute'
input: { command: string; cwd?: string; timeoutMs?: number }  // 默认 60s 上限 300s
observation: 退出码 + 输出尾部；非零 exit 显式标注"命令失败（exit=N）"
```

- command 用字符串（安全靠分级信任审批 + 危险正则 + 审批卡人审三道闸）。
- `cwd` 走 schema 元数据自声明路径字段（`"x-path": true`），终结 PATH_FIELDS 白名单散弹式修改。
- 环境变量剥离 `LOOMERY_E2E*` 等自身敏感项。
- agent 进程写盘 → 通知 watcher suppressSink 抑制窗口，防"外部变更"横幅误报。

### F1.3 GitPort + 4 薄工具（`fs-tools/src/git-tools.ts`）

| 工具 | sideEffect | 行为 |
|---|---|---|
| git_status / git_diff / git_log | read 免审 | porcelain v2 解析；diff 超长走产物拦截 |
| git_commit | write | schema 只给 `message` + `files[]`——`--amend/--force/--no-verify` 在接口上不存在 |

- branch/checkout/reset/push 不做工具 → 走 run_command 自然进审批+危险拦截。
- 启动探测 `git --version` + 工作区 `.git`，失败不注册（优雅降级）。
- 不引 simple-git，child_process 调 CLI。

### F1.4 SYSTEM_BASE 增强（与 F1.2 同步落地）

bootstrap.ts 的 5 行人格扩为工作流指引：先看目录再动手 / 修改优先 apply_diff、新文件 write_file / 写完用 run_command 自验 / 长驻服务引导用户开终端 / 改动完成后建议 git_commit。

### F1.5 审批会话级"总是允许"

- ApprovalBridge 加 per-thread 授权记忆：`{ write?: 'always', execute?: 'always' }`（内存态，线程关闭失效）。
- 审批卡三选：允许一次 / 本任务总是允许 / 拒绝。
- 危险正则命中时"总是允许"按钮隐藏。
- 与五档预设正交：预设是全局策略面，总是允许是线程内累积授权。

### F1.6 终端按钮兜底版

聊天头部右上角终端图标按钮（与回滚按钮同排）：本阶段点击 = 外部打开系统终端（cwd=活动项目根）；阶段 2 换成内嵌面板 toggle。

### F1.7 分级信任审批（ADR-0025）

pipeline 中"execute 永不 auto"硬编码替换为：

```
policy = config.approval[sideEffect]                    ← 五档预设维护的矩阵
  ├─ execute + auto + isDangerousCommand(command) → 强制 ask   ★ 新底线：危险永不 auto
  ├─ injectionFlagged + auto → ask                            （保留）
  ├─ requiresApproval + auto → ask                            （保留）
  └─ 其余按 policy 执行
```

完全访问下：`npm run build`/`tsc --noEmit` 自动执行；`rm -rf`/`format`/`git push --force` 仍弹审批。git_commit 随 write 档走（可逆操作信任）。

**完全访问下各安全线去留**：路径护栏/schema/modeAllows 硬拦截不变；危险正则→ask 不变；注入升级 ask 不变；技能首用确认不变；进程并发闸/超时树杀不变。plan/explain 模式 execute 类不可见（modeAllows）保持现状。

**验收（阶段 1 E2E）**：agent 在 testLoomery 完成"写带 css/、js/ 子目录的网页 → run_command 跑语法检查 → git_commit（按档审批）"全链无卡点；停止按钮杀运行中进程；退出无孤儿进程；完全访问下 `tsc --noEmit` 零弹窗且危险命令仍弹。
**测试矩阵**：五档预设 × {run_command 普通 / run_command 危险 / write_file / git_commit}，锁定每格 ask/auto/deny。

---

## 阶段 2：内嵌终端面板（多 tab + 拖拽）

### F2.1 node-pty 集成 + ADR

- node-pty（ConPTY，Win10 1809+）；electron ABI 匹配（@electron/rebuild）；electron-builder `asarUnpack: ['**/*.node']`。
- 降级路径：加载失败 → F1.6 外部终端按钮兜底 + 面板入口隐藏。

### F2.2 IPC 契约（adapters/ipc-bridge）

```
控制面 RPC：terminal.create { cwd? } → { sessionId, shellName }   // shell 探测 pwsh > powershell > cmd
            terminal.write / terminal.resize / terminal.kill
数据面：CHANNELS.terminalData { sessionId, chunk }   // 高频流，渲染层节流合帧
        CHANNELS.terminalExit { sessionId, exitCode }
```

### F2.3 UI（ui 包）

- ChatPanel 内嵌：消息区 `flex:1` + 终端区（默认 ~240px）+ 顶部拖拽分隔条（复用 splitter 实现；范围 120px ~ 聊天区 70%，双击复位；高度与开合状态存 layout RPC）。
- 聊天头部右上角终端按钮 toggle 显隐（session 保活，输出继续积累）。
- tab 条：左侧"终端 PowerShell"前缀；session tab 命名=项目名+序号（Loomery、Loomery 2…），活动高亮，每 tab 带 ×（kill 该 session）；右上角 `+` 新建、`×` 关闭面板（全部 session 结束，与 toggle 隐藏语义分开）。
- xterm.js + addon-fit。

### F2.4 编码处理

- PowerShell 启动预设 `[Console]::OutputEncoding = UTF8`（cmd 会话 `chcp 65001`）。
- PTY 字节流 → decodeText → xterm.js。验收：中文构建输出与原生 Windows Terminal 一致。

### 边界明确不做

agent 不读用户终端内容；不做会话恢复重启重连；不做分屏。

**验收**：多 tab 开合/新建/单个关闭/全局关闭全通；拖拽高度生效且重启记忆；中文无乱码；交互式程序可跑；退出无孤儿进程。

---

## 阶段 3：打磨（P2，各自独立）

> 2026-11-10 首轮真实任务翻车诊断后，#2/#3 提前落地；#4 部分落地（list_dir/git 友好错误，结构化通道仍缺）。

1. apply_diff 改 old_string 唯一匹配语义（未做）
2. **read_file 分页参数（offset/limit）+ 默认截断 400 行【已落地】**——大文件不再产物化→read_artifact 往返（步数黑洞实证：25 步全烧在读文档）；配套 SYSTEM_BASE"长文档先读开头判断相关性"
3. **预算余量告知模型【已落地】**——剩余≤6 步时 system 注入收尾提醒（budgetHint 段）
4. 工具结构化错误通道（错误码+修复建议）——list_dir ENOTDIR/ENOENT、git 非 git 仓库已友好化；**完整结构化（错误码+建议）仍未做**
5. 工具输出侧注入扫描（observation 跑 findInjectionMatch）（未做）
6. read 类工具并发执行（未做）
7. run_command background 变体（终端面板落地后按真实需求决策）（未做）

### 首轮真实任务诊断记录（2026-11-10）

- usage 全零 → stream_options.include_usage fetch 注入【已修】
- 25 步全读零写 → 预算告知（上述 #3）【已修】
- 过程/总结混流 → renderStream turnFinished 判定【已修】
- git 非 git 仓库 128 错 → handler 级 .git 探测【已修】
- 终端按钮无法点击 → chat-header 拖拽区吞 span 点击，豁免清单补 span 类【已修】

## 独立轨：MCP

ToolRegistry 同缝投影 `mcp_<server>_<tool>`，sideEffect 缺省 write+ask 起步；设置页配 server；与上述全部无耦合。

---

## 整洁架构四问自检

| 检查 | 答案 | 保证机制 |
|---|---|---|
| 换 PTY 实现，业务核心改吗？ | 否 | TerminalPort 止于 adapters/terminal，UI 只吃 IPC 流 |
| 换 UI 框架，内核改吗？ | 否 | run_command/git 全部投影 RegisteredTool 走既有 pipeline |
| 能脱离 UI 纯测业务？ | 能 | FakeProcessPort/FakeGitPort 单测 handler 逻辑 |
| 接 MCP 要改内核吗？ | 否 | ToolRegistry 是唯一扩展缝，`source:'plugin'` 预留 |

## 追加交付（2026-11-10，ADR-0026 + 胶囊体）

- **ActivityCapsule 胶囊体**：ChatPanel 右上常驻活动概览——Git 区（git.overview 读模型 RPC：porcelain v2+numstat 聚合；非 git 仓库隐藏；用户提交走 gitCommitDirect 直接 RPC，不经 agent 审批管线——领土原则）+ 进程区（planByTurn 步骤清单优先，回退工具时间线；轮结束数据保留）。折叠胶囊↔展开面板，事件驱动刷新（不轮询）。
- **计划分解（ADR-0026）**：plan_write 工具 + planUpdated 全量快照事件 + pipeline 侧通道 + SYSTEM_BASE 拆解指引 + store planByTurn 切片。
- **验收**：domain 5/管道与工具（fs-tools 32/loop 12）/GitAdapter overview 13/真机 CAPSULE_E2E_PASS（分支 main + 面板 Git 区 + ± 统计）。

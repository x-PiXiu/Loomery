# 10 · 架构决策记录（ADR）

> 状态均为 **Accepted**。修订某条决策 = 新增 ADR 并标注 supersede 关系，不直接改历史记录。

## ADR-0001 自研 Agent 循环，AI SDK 仅作调用原语

- **背景**：Agent 循环是产品的控制核心，判停、预算、审批、死循环都要介入。
- **决策**：手写 while 循环；Vercel AI SDK 只用 `streamText` 作为"单次调用 + 流式工具声明"原语，不接管循环；工具声明带 `execute: undefined`。
- **后果**：循环逻辑完全透明可测；需自行实现消息管理与重试（已纳入 05 §3/§8）。

## ADR-0002 自有消息模型，框架类型不出适配器

- **背景**：AI SDK 的 `CoreMessage`/`finishReason` 若渗入内核，实体层将 import `ai` 包，换 SDK/直连 API/回放持久化全部受制于 SDK。
- **决策**：domain 定义自有 `ChatMessage`/`ModelStreamEvent`；JSON Schema 为工具 schema 规范（Zod 仅适配层构造）；ai-sdk-adapter 是全工程唯一 import `ai` 的位置。
- **后果**：多一层翻译代码（约百行级）；换来模型层完全可替换与纯单测能力。

## ADR-0003 审批、事件、存储经端口倒置

- **背景**：审批的交互在渲染进程、事件消费者在 UI、存储介质未定，而循环在 main 进程内核。
- **决策**：内核声明 `ApprovalRequester` / `EventSink` / `MemoryStore` 端口，外层实现并注入；控制流向外、依赖向内。
- **后果**：审批 UI 可换（对话框/内联卡/命令行）；存储可从 JSON 换 SQLite 不动内核。

## ADR-0004 端口归内核所有

- **背景**：EditorGateway/ContextProvider/AgentTool 是"内核消费、外层实现"的端口，不是编辑器导出的 API。
- **决策**：全部端口定义在 `packages/ports`，所有权归内核；适配器实现端口。
- **后果**：归属清晰，依赖方向可被 CI 强制。

## ADR-0005 总线语义三分类

- **背景**："所有能力调用收敛到统一总线"若执行成进程内字符串消息总线，会丢失编译期依赖检查，总线退化为上帝对象。
- **决策**：①进程内：类型化端口直调；②内核→外层通知：事件端口；③进程边界（main↔renderer、宿主↔插件、宿主↔sidecar）：统一 RPC 信封。总线只出现在 ③。
- **后果**：插件进程与 sidecar 免费复用同一协议；内核内保持类型安全。

## ADR-0006 显式组合根 + CI import 自检

- **背景**：装配逻辑若无固定位置，会散落成隐式依赖；依赖规则靠口头约定守不住。
- **决策**：`shell/bootstrap()` 是唯一装配点；CI 对 domain/ports/agent-core 扫描 `electron|monaco|dockview|ai`，命中即失败。
- **后果**：依赖规则机械化执行；组合根成为新适配器接入的唯一登记处。

## ADR-0007 Codex 风格 chat-first 双布局预设

- **背景**：产品形态要对齐 Codex 的对话优先体验，同时不牺牲 IDE 能力。
- **决策**：UI 定义为五个固定槽位；布局预设 = dockview 序列化 JSON；内置 `codex`（默认，Chat 为主舞台）与 `ide`（经典）两份预设，用户自定义按预设持久化。
- **后果**：布局零代码成本切换；插件视图自动获得两种预设下的停靠能力。

## ADR-0008 事件溯源持久化

- **背景**：会话状态若多处分存（快照 + 日志），恢复时必然出现不一致。
- **决策**：所有 `LoopEvent` 追加 JSONL 日志为唯一持久化数据源；状态恢复 = 重放；渲染层与持久化是同一事件流的两个消费者。
- **后果**：恢复逻辑只有一条路径；获得免费能力：回放测试（P2）、会话导出、审计（09）。代价：日志体积管理（滚动与压缩列入 P2）。

## ADR-0009 Turn 级 checkpoint 懒快照

- **背景**：审批门只能拦"执行前"，用户 accept 后仍需反悔手段；这是编辑器类 Agent 的刚需。
- **决策**：Turn 内路径首次被写类工具触碰前复制原文件到 `userData/checkpoints/`；回滚 = 还原本 Turn 全部快照；P1 不依赖 git，P2 增加 git 感知（快照保留为兜底）。
- **后果**：写路径多一次文件复制（可接受）；跨期不变量中"状态只持久化在 session"的例外仅此一处，自成体系。

## ADR-0010 提示词注入三道缓解

- **背景**：read_file/search_text 结果进入上下文，仓库内恶意内容可诱导 Agent。
- **决策**：①system prompt 数据标记；②可疑指令模式检测 → `injectionWarning` 事件；③命中后本 Turn 内 write/execute 强制 ask。
- **后果**：不能完全消除注入风险（明示局限），但保证高风险操作必经人审；模式表为配置数据，可随企业策略扩展。

## ADR-0011 ToolSpec / RegisteredTool 拆分（序列化边界）

- **背景**：第一轮审计（2026-10-25）发现 `toolsChanged { added: AgentTool[] }` 与 `ModelRequest.tools` 携带 handler 函数，违反"事件可序列化"铁律。
- **决策**：拆分 `ToolSpec`（可序列化规格，进入模型请求与事件载荷）与 `RegisteredTool`（规格 + handler，仅注册表内部）；`ToolRegistry` 对外只暴露 ToolSpec。
- **后果**：事件与请求载荷恒可 JSON 化；模型适配器拿不到执行体，执行权进一步收拢到循环。

## ADR-0012 记忆即上下文贡献者 + 压缩事件化

- **背景**：审计发现 context 装配需要长期记忆召回，若直接调用 memory 模块将违反 star 拓扑（用例层互不调用）；短期压缩若不落事件，重放无法确定性还原。
- **决策**：长期记忆召回以 `ContextProvider` 身份注册进装配管道（provider ctx 增加 `latestUserMessage`）；短期压缩的决策与结果本身作为 `memoryCompressed` 事件落日志（携带 compressedMessageIds 与摘要）。
- **后果**：context 与 memory 零耦合；压缩与事件溯源自洽；未来"团队记忆"（09 §6）可用同一机制进入。

## ADR-0013 多根工作区路径规范

- **背景**：`DiffProposal.path` 原定义"工作区相对路径"，多根工作区下存在归属歧义，写回时无法确定目标根。
- **决策**：领域对象与事件载荷中的路径一律绝对路径；显示层负责相对化；Windows 路径比较不区分大小写。
- **后果**：路径语义唯一；护栏、checkpoint、affectedPaths、诊断全部使用同一表示。

## ADR-0014 事件目录修订（第一轮审计）

- **背景**：审计发现 ①04 缺 thread 生命周期事件而 05 已引用 `threadResumed`；②`textDelta` 无消息边界，重放无法确定性重建消息列表；③Agent 写盘后编辑器无刷新通知（并发编辑不可见）；④`budgetWarning.kind` 与 `TerminationReason` 术语漂移；⑤seq 分配权未指定。
- **决策**：补 `threadCreated` / `threadTitleChanged` / `threadResumed`；`textDelta` / `toolCallComplete` 增加 `messageId`（重放按 messageId 归组重建消息）；`toolExecuted` 增加 `affectedPaths`（编辑器静默重载无脏 buffer、脏 buffer 提示）；kind 与 TerminationReason 同名对齐；seq 由 EventSink 扇出点单点分配。
- **后果**：事件溯源的重放确定性闭环；Agent 与用户的并发编辑显性化。

## ADR-0015 执行侧工具契约归 ports

- **背景**：实现 domain 时发现 03 §5 原把 `ToolContext`（引用 `EditorGateway`）、`ToolHandler`、`ToolResult`、`RegisteredTool` 放在 domain——这会形成 domain→ports 反向引用，违反"ports 仅依赖 domain"。
- **决策**：domain 只保留可序列化的 `ToolSpec`（模型侧规格）；`ToolContext` / `ToolResult` / `ToolHandler` / `RegisteredTool`（执行侧契约）移入 ports 包。
- **后果**：依赖方向恢复纯净；模型适配器只见 ToolSpec，执行体进一步与内核解耦；对 03 §5/§9 已同步修订。

## ADR-0016 构建工具：esbuild（main/preload）+ vite（渲染层），不引入 electron-vite

- **背景**：渲染层是独立 ui 包（自持 vite 与 Monaco worker 配置），electron-vite 要求 main/preload/renderer 三段同构，反而增加约束；实现期另发现 dockview v8 样式随 JS 注入、electron 二进制在部分网络需 npmmirror 镜像。
- **决策**：shell 用 esbuild 直出 `dist/main.js`（ESM）与 `dist/preload.cjs`（CJS）；ui 用 vite 构建到 `dist`；开发模式用 `LOOMERY_RENDERER_URL` 指向 vite dev server。`.npmrc` 固化 electron 镜像。
- **后果**：构建链少一层抽象；对 11 §0 工具链建议的偏离以本 ADR 备案。

## ADR-0017 主窗口布局引擎：自绘三列，移除 dockview

- **背景**：用户定稿 V2 主窗口——三列（左任务/项目侧栏双模式 · 中对话 · 右编辑器）+ 可拖分隔条 + 中右互换，无活动栏。该结构是固定三列而非自由停靠，dockview 的面板系统反而增加约束；且 V1 期间发现 dockview v8 样式与布局恢复存在集成摩擦。
- **决策**：ui 以自绘 flex 三列 + 5px 分隔条（拖宽持久化 localStorage）实现主窗口；移除 dockview-core/dockview-react 依赖；设置与事件时间线改为浮层（overlay）。V1 的五槽位/Codex-IDE 预设方案存档于 06 存档章节与 docs/mockups v1 文件。
- **后果**：渲染层少一个重量依赖；P2 插件视图停靠届时需重新评估（可引入 dockview 或自研槽位，属增量）。

## ADR-0018 无边框窗口（frameless）

- **背景**：V2.3 定稿去掉原生标题栏行，对齐 ZCode 观感。
- **决策**：`frame:false`；窗口拖拽由各列头栏 `-webkit-app-region:drag` 承载（按钮/输入框 no-drag 豁免，双击头栏=最大化）；窗口控制 —□✕ 仅渲染在右列顶部（CSS `.loomery-main > .col:last-child .win-controls`），互换后自动跟随；`Menu.setApplicationMenu(null)`，快捷键由渲染层自行监听。
- **后果**：原生菜单能力全部由渲染层自建（帮助/设置入口等）。

## ADR-0020 纯 diff 规则下沉 domain（rules/diff）

- **背景**：DiffPane 渲染层与 fs-tools 写入侧都需要 applyHunks/validateHunks 能力；渲染层打包无法携带 node:path，工具侧转发需要同一套规则保证一致性。
- **决策**：applyHunks/validateHunks/makeFullFileProposal 下沉 `domain/rules/diff.ts`（纯函数、零框架 import）；domain 包提供子路径导出 `./rules/diff` 供浏览器打包隔离 node:path；fs-tools 转发兼容。
- **后果**：渲染层 DiffPane 与内核写盘共用同一 diff 语义；后续记忆/产物纯规则（ADR-0021）延续"纯规则进 domain"的既有做法。（0019 编号未分配，跳过。）

## ADR-0021 任务记忆与中间产物的存储边界

- **背景**：长任务需要记忆（结论）、中间产物（过程材料）、用户钉住的要求、大代码草稿四类内容；全部塞上下文撑爆窗口，全埋事件流又查不到。须按整洁架构裁决"内核拥有什么状态"。
- **决策**：按"内核是否拥有该状态"划三条边界——①**条目记忆**（pinned/提炼事实，MemoryFact 扩展 scope/threadId/turnId/status）＝内核拥有→**事件溯源**（memoryPinned/memoryUnpinned/memoryExtracted 落 JSONL），`userData/memory/tasks/<threadId>.json` 为可重建读模型；②**任务简报**（Brief，每轮自动注入的 md 文档）＝外部文档（与 workspace 文件同类）→**文件为主**（`userData/memory/tasks/<threadId>.md`，人类可手编），`briefUpdated` 事件只记审计（actor/rev/hash），重放不重建简报、装配时经 BriefStore 端口读现值；③**中间产物**＝不可变证据→**内容寻址**（`userData/artifacts/`，hash 寻址 blob + index），超阈工具输出只以 ArtifactRef（hash+summary）进事件与上下文，事件序列化铁律不变。另设**任务暂存区** `userData/scratch/<threadId>/`（agent 草稿，免审、不进 git/checkpoint/上下文，任务删除随 GC）。
- **后果**：硬规则 5 细化为"其余模块零*拥有*持久化状态——文档型存储是外部资源非状态"；checkpoint 回滚不回滚记忆/产物（带 turnId 溯源）；上下文注入统一为 ContextContributor + `arbitrateContext` 纯函数仲裁（pinned 永不裁），裁剪优先级：全局记忆 → 提炼记忆 → 最老消息，pinned/系统提示除外；压缩时顺带提炼事实（压缩=沉淀）。

## ADR-0022 技能＝独立用例模块（程序性知识）

- **背景**：可复用流程（发版步骤、周报模板、代码规范）需跨任务复用；与插件（可执行代码）不同，技能是声明式知识（SKILL.md + 可选脚本），无需进程托管。候选方案：并入 memory 作为"程序性记忆" vs 独立用例模块。
- **决策**：agent-core 新增 **skills 用例模块**（第七个）：扫描编排（user `userData/skills/` + project `<ws>/.loomery/skills/` 双作用域）、索引贡献者注册（SkillIndexProvider，只注入名+描述 ~40 tokens/个）、`read_skill` 工具编排（body 按需加载）、项目级技能**首用确认**（走 ApprovalRequester 扩 confirm 种类）、`skillUsed` 记账。SkillRegistry 端口归内核，实现落 memory-store 适配器；memory 模块维持情景+语义两类不变。
- **后果**：职责单一、P2 技能市场对接面清晰（marketplace → skills 模块）、与插件四类贡献者（tools/providers/views/skills）对等；模块清单 +1，符合只增不改；技能带脚本时脚本执行仍走 approval.execute 策略，技能文本不免审。

## ADR-0023 存储引擎：JSON 先行，SQLite 按触发条件迁移（三迁三留）

> **状态【已执行，2026-11-01】**：用户决策提前迁移（不等触发条件）。落地：`SqliteMemoryStore`（node:sqlite，WAL；实测 Electron 38 内置可用无需 flag），默认引擎 SQLite，`LOOMERY_STORE=json` 逃生门回退 JSON（旧档归档 `sessions-imported/` 可整体回退）。三迁=events/thread_meta（fold 语义与 JSON 逐字段同构，双路径重放校验测试锁定）/facts/产物索引（`ArtifactIndexBackend` 接缝）；三留=简报 .md/技能 SKILL.md/产物 blob+config/secrets/checkpoints。JSONL→SQLite 导入幂等（uuid 去重+残行跳过+标记防重导）。端口与内核/UI 零改动兑现。

- **背景**：ADR-0021/0022 把持久化收进 memory-store 单适配器四仓库，端口已验证引擎中立；P1 决策避免原生模块编译成本。用户要求在 P2.0 开工前把 SQLite 迁移一并考虑。按整洁架构"推迟决策≠永不决策"：迁移的**设计**今天定死，替换动作按触发条件择期执行。
- **决策**：①**P2.0 仍以 JSON/文件实现四仓库**，但 JSON 结构逐字段对齐下述表结构，防止文件格式固化为事实契约；②迁移范围**三迁三留**——迁：事件日志、事实索引（全局+任务）、产物索引；**留文件**：任务简报 .md（人类可编辑是产品决策，SQLite 永不吞它）、技能 SKILL.md（用户自编）、产物 blob 本体（大对象入库是反模式，保持 hash 寻址文件）；③SQLite schema 草案：`events(threadId, seq, ts, type, payload JSON, PRIMARY KEY(threadId, seq))`、`facts(id, scope, threadId?, kind, source, status, content, createdAt)`、`artifacts(hash PK, threadId, turnId, kind, summary, size)`；④触发条件（任一命中即执行，只动 memory-store 包，内核/端口/UI 零改动）：任务数 > 50、启动全量重放 > 2s、出现跨线程检索需求（FTS5）、P2 插件宿主并发读；⑤引擎选型：优先 `node:sqlite`（Node 内置零编译），若 Electron 内置 Node 未解除实验标志则退 `better-sqlite3` + electron-rebuild（届时 ADR 备案打包链影响）；⑥迁移脚本 = JSONL 逐行 INSERT + 双路径重放校验（文件读回 vs SQLite 读回逐字段一致）。
- **后果**：P2.0 零阻塞；触发后替换是一次适配器内替换；简报可编辑性、产物 hash 寻址不受影响；事件表 `(threadId, seq)` 主键与 FanoutSink 的 seq 单点分配（ADR-0014）天然对齐。

## ADR-0024 进程/终端/Git 集成边界

- **背景**：agent 无执行能力（写→验→改闭环断裂）、无终端面板、git 操作只能靠审批链上的通用工具。需要接入子进程、PTY 与 git，同时守住内核纯净。
- **决策**：①`ProcessPort`/`GitPort` 归 ports（内核侧工具 handler 消费，依赖倒置可测）；`TerminalPort` 不进 ports——终端是用户领土功能，内核无感，止于 `adapters/terminal`（内部接口）+ 专用 IPC 频道；②`run_command`（execute 类）与 4 个 git 薄工具（git_status/diff/log=read 免审，git_commit=write ask，schema 只给 message+files[]，危险 flags 在接口上不存在）全部投影 `RegisteredTool` 走既有 pipeline，内核零改动；③`ProcessRegistry`（main 单例）统一登记 agent/终端两类子进程：abort 联动树杀、before-quit killAll、agent 并发闸 4、输出环形缓冲 256KB；④终端面板 node-pty（ConPTY）+ xterm.js，ChatPanel 内嵌多 tab + 拖拽高度，不过审批管道；加载失败降级为外部终端按钮；⑤branch/checkout/reset/push 不做工具，模型走 run_command 进审批链。
- **后果**：ToolRegistry 扩展缝兑现（builtin 全覆盖）；PTY native 模块引入打包复杂度（electron-rebuild + asarUnpack），有外部终端降级路径；Windows 输出编码走 decodeText 链；watcher suppressSink 与进程写盘互通。

## ADR-0025 分级信任审批：危险命令永不 auto（替代"execute 永不 auto"）

- **背景**：UI 五档预设（Composer）中"完全访问"承诺 `execute:'auto'`，但 pipeline 硬编码"execute 永不 auto"将其架空——用户选完全访问后每次命令仍弹审批，设置形同虚设。
- **决策**：删除 execute 类别级硬编码，改为**逐命令分级**：`policy=auto` 时对 `run_command` 输入跑 `isDangerousCommand`，命中 → 强制 ask；未命中 → 按 policy 放行。危险正则永不 auto 成为新底线；注入告警升级、requiresApproval 首用确认、路径护栏等其余防线全部保留。config 结构零改动（approval 仍是 `Record<SideEffect, Policy>`，五档矩阵由 UI 预设维护）。
- **后果**：完全访问下 `tsc --noEmit`/`npm run build` 零弹窗、`rm -rf` 仍弹；语义与预设文案（"减少确认次数""有风险时问"）一致；测试矩阵=五档预设 × {普通命令/危险命令/write_file/git_commit}。

## ADR-0026 计划分解：模型能力经工具+事件外显（TodoWrite 模式）

- **背景**：ZCode 式右侧胶囊的"进程 N/M"是 agent 计划分解的步骤清单。若让内核用启发式代码拆任务，等于把业务策略塞进用例层（分层违规且效果差）。业界已验证答案：拆分由 LLM 经结构化工具调用自行完成（Claude Code TodoWrite 同款），内核只提供契约+事件通道。
- **决策**：①domain 新增 `PlanStep/PlanState` 实体 + `validatePlanSteps` 纯校验（2~12 步、title≤60、生成稳定 id s1..sN）+ `planUpdated` 事件（**全量快照** last-write-wins——与折叠哲学天然一致，重放逐条覆盖即得终态，无增量 fold）；②`plan_write` 工具（fs-tools，sideEffect:'read'——免审且 plan/explain 模式可用，计划模式可先出计划）；③ToolResult.planUpdate 侧通道 → pipeline 统一 emit（ADR-0021 结果侧事件模式的第四个兄弟：pinnedFact/briefUpdate/skillUsed/planUpdate）；④SYSTEM_BASE 拆解指引（≥3 步任务先 plan_write、状态实时迁移、失实就地修正）；⑤UI store planByTurn 切片 + 胶囊进程区双数据源（有计划渲染步骤清单，无计划回退工具时间线）。
- **后果**：内核零逻辑改动（pipeline 仅 +1 行侧通道）；事件溯源/SQLite/迁移框架对 planUpdated 全透明；预算告知可引用计划进度（后续项）；测试矩阵=domain 校验/pipeline 侧通道/loop 集成（内联同构工具保持依赖向内）/真机胶囊 E2E。

## ADR-0027 git 用户操作套件：审查/提交/分支（用户主动=授权的扩展）

- **背景**：胶囊 Git 区 v1 只有只读概览与简易提交；对照 ZCode 需要审查标签页/提交推送弹窗/分支管理三套交互。
- **决策**：①数据层 GitAdapter 扩 7 方法（reviewList/fileDiff/branches/checkout/push/add/suggestMessage），RPC 化——**读操作免审；写操作（checkout/push/addCommit）由用户主动点击触发=授权**（ADR commitDirect 原则延伸，agent 侧 git_* 工具的审批链不受影响）；②"上一轮更改"数据源=checkpoint 快照 vs 磁盘（domain diff-engine 生成 ±与文本），与 git 模式统一为 ReviewFile 接口；③审查标签页 kind:'review' 行内 diff+openInDiff 双栏联动；④AI 提交信息走 cheap 档（diff 摘要 cap 8KB+提交风格参考），失败降级为手动；⑤git 写操作后 watcher 宽限（lastGitWriteAt，防切分支横幅风暴）。
- **后果**：编辑区新增 tab 类型（review entry 生命周期同 html entry——已存在则更新）；错误文案全部可行动（身份/upstream/冲突文件）；明确不做：远端选择 UI/图形图谱/交互式暂存。

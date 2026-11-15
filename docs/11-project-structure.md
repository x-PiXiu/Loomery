# 11 · 项目文件目录树（预期）

> 本文是 [02-architecture.md](02-architecture.md) §4 目录结构的**文件级展开**【规范】。实现按此树建立文件；P2/P3 标注的目录在对应阶段才创建（P1 阶段不建空目录，`ports/reserved` 除外——接口留白属于 P1 交付物）。

## 0. 工具链【建议】

pnpm workspaces + turbo ｜ electron-vite（main/preload/renderer 三段构建）｜ vitest ｜ eslint + dependency-cruiser ｜ Playwright（Electron e2e）｜ electron-builder。版本以实现时最新稳定版为准（Electron 最新稳定、React 19、TypeScript 5.x）。

## 1. 仓库树

```
Loomery/
├─ package.json                      # 根脚本：turbo run lint/test/build/e2e        [M0]
├─ pnpm-workspace.yaml               # packages/* + packages/adapters/* + e2e       [M0]
├─ turbo.json                        # 任务管线与缓存                                [M0]
├─ tsconfig.base.json                # strict 基线，各包继承                          [M0]
├─ eslint.config.mjs                 # lint + boundaries 依赖方向规则                 [M0]
├─ .dependency-cruiser.cjs           # 分层依赖检查（02 §4 的机械化）                 [M0]
├─ .github/workflows/ci.yml          # import 自检 → lint → test → build             [M0]
├─ scripts/
│  └─ check-imports.mjs              # domain/ports/agent-core 框架 import 自检（ADR-0006）[M0]
├─ resources/                        # 应用图标、许可证页脚                           [M0]
├─ docs/                             # 设计文档（SSOT，本目录）
├─ e2e/                                                                              [M7 末]
│  ├─ playwright.config.ts
│  └─ specs/
│     └─ smoke.spec.ts               # 主链路冒烟：会话→工具→审批→回滚→重启恢复
└─ packages/
   ├─ domain/                        # @loomery/domain —— 宪法层，零 import          [M0]
   │  ├─ package.json
   │  ├─ tsconfig.json
   │  └─ src/
   │     ├─ index.ts                 # 桶导出
   │     ├─ constants.ts             # 03 §1 默认常量表
   │     ├─ message.ts               # Role / MessagePart / ChatMessage
   │     ├─ session.ts               # Session / Thread / Turn / AgentMode / Usage
   │     ├─ loop-state.ts            # LoopState / Budget / TerminationReason
   │     ├─ tool.ts                  # ToolSpec / RegisteredTool / ToolContext / ToolResult
   │     ├─ diff.ts                  # DiffHunk / DiffProposal / ProposalStatus
   │     ├─ diagnostic.ts            # Diagnostic
   │     ├─ memory.ts                # MemoryFact
   │     ├─ config.ts                # AppConfig / ModelConfig
   │     ├─ event.ts                 # LoopEvent 信封 / EventType 联合 / EnvironmentEvent
   │     └─ rules/                   # 纯规则函数（全部表驱动单测）
   │        ├─ index.ts
   │        ├─ mode-filter.ts        # modeAllows
   │        ├─ path-guard.ts         # isPathInsideWorkspace（多根/大小写，ADR-0013）
   │        ├─ dangerous-command.ts  # isDangerousCommand
   │        ├─ injection.ts          # matchesInjectionPattern
   │        ├─ hash.ts               # hashToolCall / canonicalJson
   │        ├─ truncate.ts           # truncateText
   │        └─ token-estimate.ts     # estimateTokens（启发式）
   │
   ├─ ports/                         # @loomery/ports —— 端口契约，仅类型             [M0]
   │  ├─ package.json
   │  └─ src/
   │     ├─ index.ts
   │     ├─ model-client.ts          # ModelRequest / ModelStreamEvent / ModelClient
   │     ├─ approval.ts              # ApprovalSpec / ApprovalDecision / ApprovalRequester
   │     ├─ editor-gateway.ts        # EditorGateway
   │     ├─ context-provider.ts      # ContextChunk / ContextProvider
   │     ├─ event-sink.ts            # EventSink
   │     ├─ memory-store.ts          # MemoryStore
   │     ├─ config-store.ts          # ConfigStore（03 §11）
   │     ├─ environment-source.ts    # EnvironmentEventSource（03 §11）
   │     ├─ clock.ts                 # Clock
   │     ├─ tool-handler.ts          # ToolContext/ToolResult/ToolHandler/RegisteredTool（ADR-0015）
   │     └─ reserved/                # 接口留白：P1 只声明不实现
   │        ├─ terminal.ts           # TerminalProvider / TerminalSession            [P3]
   │        └─ task.ts               # TaskProvider / TaskDef / TaskRun              [P3]
   │
   ├─ agent-core/                    # @loomery/agent-core —— 用例层                  [M0 起]
   │  ├─ package.json
   │  └─ src/
   │     ├─ index.ts
   │     ├─ loop/                    # 执行引擎                                       [M4]
   │     │  ├─ agent-loop.ts         # runTurn 主循环（05 §3 伪代码的实现）
   │     │  ├─ budget.ts             # 预算三闸 + 80% 预警
   │     │  ├─ dead-loop.ts          # 哈希集合 + 上下文哈希连击
   │     │  └─ degrade.ts            # 降级收尾（禁用工具总结）
   │     ├─ tools/                   # 工具运行时                                     [M5]
   │     │  ├─ registry.ts           # ToolRegistry（注册表扩展点）
   │     │  ├─ pipeline.ts           # 执行管道（责任链编排）
   │     │  ├─ pending-proposals.ts  # DiffProposal 挂起表
   │     │  └─ steps/
   │     │     ├─ schema-validate.ts
   │     │     ├─ mode-guard.ts
   │     │     ├─ guards.ts          # 确定性护栏（调 domain/rules）
   │     │     ├─ approval-gate.ts   # 审批门（调 ApprovalRequester 端口）
   │     │     └─ truncate.ts
   │     ├─ context/                 # 上下文装配                                     [M4-M5]
   │     │  ├─ assembler.ts          # system 组装 + provider 扇入
   │     │  └─ budget.ts             # token 预算分配与丢弃
   │     ├─ memory/                  # 记忆策略                                       [M8]
   │     │  ├─ short-term.ts         # 压缩（事件化，ADR-0012）+ 压缩沉淀（ADR-0021）
   │     │  ├─ long-term.ts          # 提炼 + 去重（任务级/全局，ADR-0021）
   │     │  └─ memory-provider.ts    # 长期记忆 ContextProvider（ADR-0012）
   │     ├─ skills/                  # 技能（程序性知识，P2.0，ADR-0022）
   │     │  ├─ scanner.ts            # 双作用域扫描编排（user + project）
   │     │  └─ skill-provider.ts     # SkillIndexProvider（只注入索引）+ read_skill 编排
   │     ├─ session/                 # 会话状态                                       [M2/M7]
   │     │  ├─ state-machine.ts      # Session/Thread/Turn/Step 迁移
   │     │  ├─ journal.ts            # 事件溯源 writer（经 MemoryStore 端口）
   │     │  ├─ thread-service.ts     # 编排入口：创建/发送/取消/恢复 + Turn 后记忆管线
   │     │  ├─ restore.ts            # 重放恢复（interrupted/挂起审批语义）
   │     │  └─ usage.ts              # 用量聚合
   │     └─ events/                  # 事件基建                                       [M2]
   │        ├─ fanout-sink.ts        # EventSink 扇出 + seq 单点分配（ADR-0014）
   │        └─ mappers.ts            # ModelStreamEvent → LoopEvent
   │
   ├─ adapters/
   │  ├─ ai-sdk-adapter/             # @loomery/adapter-ai-sdk —— 唯一 import ai      [M3]
   │  │  └─ src/
   │  │     ├─ index.ts              # createAiSdkModelClient(config)
   │  │     ├─ translate.ts          # ChatMessage↔CoreMessage；ToolSpec→SDK tool
   │  │     ├─ stream.ts             # fullStream → ModelStreamEvent 归一化
   │  │     ├─ retry.ts              # 429/5xx 指数退避 + retrying 事件
   │  │     └─ model-registry.ts     # main/cheap 解析；apiKeyRef→密钥值
   │  ├─ fs-tools/                   # @loomery/adapter-fs-tools                      [M4-M5]
   │  │  └─ src/
   │  │     ├─ index.ts              # registerBuiltinTools(registry, ctx)
   │  │     ├─ read-file.ts  list-dir.ts  search-text.ts
   │  │     ├─ write-file.ts  apply-diff.ts
   │  │     ├─ diff-engine.ts        # hunk 匹配校验 + 审批预览 proposal 合成
   │  │     ├─ binary-detect.ts
   │  │     └─ checkpoint/                                                           [M7]
   │  │        ├─ checkpoint.ts      # 懒快照
   │  │        └─ rollback.ts        # 回滚服务（发 checkpointRestored）
   │  ├─ memory-store/               # @loomery/adapter-memory-store                  [M2/M3/M8]
   │  │  └─ src/
   │  │     ├─ index.ts
   │  │     └─ json/
   │  │        ├─ journal-file.ts    # JSONL append/load                              [M2]
   │  │        ├─ facts-file.ts      # 长期记忆                                        [M8]
   │  │        └─ config-file.ts     # ConfigStore 实现                                [M3]
   │  │     └─ sqlite/               #                                                 [P2]
   │  ├─ ipc-bridge/                 # @loomery/adapter-ipc-bridge                     [M2]
   │  │  └─ src/
   │  │     ├─ envelope.ts           # 统一信封 + 16MB 校验（P2/P3 复用）
   │  │     ├─ main/
   │  │     │  ├─ rpc-server.ts
   │  │     │  ├─ event-forwarder.ts # LoopEvent → renderer（EventSink 实现）
   │  │     │  └─ approval-bridge.ts # ApprovalRequester 实现
   │  │     ├─ preload/
   │  │     │  └─ expose.ts          # contextBridge 白名单
   │  │     └─ renderer/
   │  │        ├─ rpc-client.ts
   │  │        └─ env-forwarder.ts   # EnvironmentEvent → main
   │  ├─ editor-gateway/             # @loomery/adapter-editor-gateway                 [M1-M2]
   │  │  └─ src/
   │  │     ├─ main/                 # main 侧 RPC stub
   │  │     │  ├─ gateway-client.ts  # EditorGateway 实现（转发 renderer）
   │  │     │  ├─ provider-remotes.ts# 当前文件/选区/诊断 providers
   │  │     │  └─ env-source.ts      # EnvironmentEventSource 实现
   │  │     └─ renderer/             # renderer 侧 Monaco 实现
   │  │        ├─ gateway-server.ts
   │  │        ├─ monaco-gateway.ts  # openFile/applyEdit/selection/reveal
   │  │        ├─ file-reload.ts     # affectedPaths 刷新（ADR-0014）
   │  │        └─ editor-events.ts   # → EnvironmentEvent
   │  ├─ plugin-host/                #                                                  [P2]
   │  ├─ lsp-bridge/                 #                                                  [P3]
   │  ├─ pty-adapter/                #                                                  [P3]
   │  ├─ task-adapter/               #                                                  [P3]
   │  └─ sidecar-stub/               #                                                  [P3]
   │
   ├─ shell/                         # @loomery/shell —— Electron main + 组合根         [M0/M1]
   │  ├─ package.json
   │  ├─ electron-builder.yml        # 打包/签名                                        [M8 后]
   │  └─ src/
   │     ├─ main/
   │     │  ├─ index.ts              # app 入口：生命周期/安全基线（07 §8）
   │     │  ├─ bootstrap.ts          # 组合根：装配清单（05 §13）                        [M0]
   │     │  ├─ window.ts             # BrowserWindow
   │     │  ├─ menu.ts
   │     │  ├─ secrets.ts            # safeStorage/OS 凭据库（07 §3）                    [M3]
   │     │  └─ policy.ts             # 策略配置加载与合并（企业层预留）                    [M6]
   │     ├─ preload/
   │     │  └─ index.ts              # 引用 ipc-bridge/preload
   │     └─ shared/
   │        └─ channels.ts           # 频道名常量（main↔renderer 共享）
   │
   ├─ ui/                            # @loomery/ui —— renderer                          [M1 起]
   │  ├─ package.json
   │  └─ src/
   │     ├─ main.tsx                 # 渲染入口
   │     ├─ app/
   │     │  ├─ layout/
   │     │  │  ├─ presets/
   │     │  │  │  ├─ codex.json      # codex 预设（默认）                                [M1]
   │     │  │  │  └─ ide.json        # 经典 IDE 预设                                    [M1]
   │     │  │  ├─ LayoutManager.tsx  # 预设应用/持久化/切换                              [M1]
   │     │  │  └─ slots.tsx          # 五槽位容器                                       [M1]
   │     │  └─ stores/               # 事件 reducer → 视图模型（唯一状态来源）            [M2]
   │     │     ├─ event-reducer.ts
   │     │     ├─ chat-store.ts
   │     │     ├─ threads-store.ts
   │     │     └─ status-store.ts
   │     ├─ views/
   │     │  ├─ chat/                                                                  [M3-M7]
   │     │  │  ├─ ChatPanel.tsx  Composer.tsx  MessageStream.tsx
   │     │  │  ├─ ToolCard.tsx [M4]  ApprovalCard.tsx [M6]  DiffCard.tsx [M6]
   │     │  │  ├─ CheckpointBanner.tsx [M7]  TurnFooter.tsx [M4]
   │     │  ├─ threads/
   │     │  │  └─ ThreadList.tsx     #                                                  [M2]
   │     │  ├─ editor/
   │     │  │  ├─ EditorArea.tsx  MonacoPane.tsx  FileTree.tsx                        [M1]
   │     │  │  └─ DiffPane.tsx       #                                                  [M6]
   │     │  ├─ status/
   │     │  │  └─ StatusBar.tsx      #                                                  [M2]
   │     │  ├─ settings/
   │     │  │  └─ SettingsView.tsx   #                                                  [M3]
   │     │  └─ debug/
   │     │     └─ EventTimeline.tsx  #                                                  [M2]
   │     ├─ gateway/
   │  │     └─ mount.ts              # 挂载 editor-gateway renderer 侧                   [M2]
   │     ├─ rpc/
   │     │  └─ client.ts             # 渲染层 RPC 封装                                   [M2]
   │     └─ theme/
   │        ├─ tokens.css  dark.css  #                                                  [M1]
   │
   └─ plugin-sdk/                    # @loomery/plugin-sdk                              [P2]
      └─ src/
         ├─ manifest.ts              # manifest schema（contributes 五项）
         ├─ host-api.ts              # host.* 白名单 API 类型
         └─ index.ts
```

## 2. 阶段标记说明

- `[M0]`~`[M8]`：P1 内里程碑（见 08-roadmap.md），标注该文件**首次落地**的里程碑；后续里程碑会继续修改这些文件。
- `[P2]` / `[P3]`：对应阶段才创建的目录与文件；P1 期间不建空目录。
- `[M7 末]` 等复合标注表示在指定时点之后。

## 3. 运行时目录（Electron userData，不入仓库）【规范】

**位置解析优先级**（便携默认，数据随程序所在盘，不进 C 盘 AppData）：

1. `LOOMERY_USER_DATA` 环境变量（探针/多实例隔离/显式覆盖）；
2. 指路条 `data-dir.txt`（存在默认位置根，记录用户在设置页选择的自定义目录——设置页"更改数据目录"自动迁移现有数据后写入，重启生效）；
3. 默认：打包版 `<安装目录>\data`；开发期 `<仓库根>\.loomery-data`（已 gitignore）；
4. 兜底：默认位置不可写（如 Program Files 无权限）→ `%APPDATA%\@loomery\shell`。

以下树以默认位置为根（历史上曾默认 %APPDATA%，2026-10-28 起改为便携默认，用户选择重定向后以指路条为准）：

```
<UserData>\                    # 解析优先级见上；打包=安装目录\data，开发=仓库\.loomery-data
├─ config.json                  # AppConfig（只含 apiKeyRef，不含密钥本体）      [M3]
├─ secrets.enc                  # safeStorage 加密的密钥本体（07 §3）            [M3]
├─ loomery.db          # SQLite 事件库（ADR-0023：events/thread_meta/facts/artifact_index；WAL）
  sessions-imported/  # JSONL 迁入 SQLite 后的原始档（保留可回退）
  sessions/
│  └─ <threadId>.jsonl          # 事件溯源日志（ADR-0008）                       [M2]
├─ memory/
│  ├─ facts.json                # 全局长期记忆                                   [M8]
│  └─ tasks/
│     ├─ <threadId>.json        # 任务条目记忆读模型（事件重建，ADR-0021）
│     └─ <threadId>.md          # 任务简报（文件为主，装配时经 BriefStore 读，ADR-0021）
├─ scratch/
│  └─ <threadId>/...            # 任务暂存区（agent 草稿，免审，任务删除随 GC，ADR-0021）
├─ artifacts/
│  ├─ index.json                # hash → {threadId, turnId, kind, summary, size}
│  └─ <hash[:2]>/<hash>         # 内容寻址 blob（LRU 封顶，ADR-0021）
├─ skills/
│  └─ <name>/SKILL.md           # 用户级技能（项目级在 <ws>/.loomery/skills/，ADR-0022）
├─ checkpoints/
│  └─ <threadId>/<turnId>/...   # 懒快照（07 §5，滚动保留最近 20 Turn）           [M7]
└─ layout/
   ├─ codex.json  ide.json      # 用户自定义布局（按预设持久化）                   [M1]
```

**领土原则**（ADR-0021）：workspace＝用户领土（审批 + checkpoint 管辖，进 git）；userData＝agent 工作台（免审，但每次操作经事件/审计留痕）。审批策略按物理位置自动分流，无需逐文件判断。

## 4. 与依赖规则的对应

- `packages/domain`：package.json **不得声明任何 dependencies**（物理强制零依赖；devDependencies 仅允许工具链 typescript/vitest/@types/node）。
- `packages/ports`：dependencies 仅允许 `@loomery/domain`。
- `packages/agent-core`：dependencies 仅允许 `@loomery/domain`、`@loomery/ports`。
- `packages/adapters/*`：允许依赖 domain/ports/agent-core + 各自的第三方（ai-sdk-adapter 才能有 `ai`，ui 之外不得出现 `monaco-editor`/`dockview`）。
- `packages/shell`、`packages/ui`：最外层；shell 依赖几乎所有包并完成装配。
- 以上全部由 `.dependency-cruiser.cjs` + `scripts/check-imports.mjs` 在 CI 强制（ADR-0006）。

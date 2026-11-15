# 02 · 架构总设计

## 1. 四层同心圆【规范】

依赖方向**永远向内**，这是本项目的架构宪法（ADR-0004、ADR-0006）。

```
┌─ L3 框架与驱动 ──────────────────────────────────────────────────────┐
│  shell(组合根/Electron main)     ui-renderer(React+Monaco+dockview)  │
│  plugin-sdk(P2, 对外契约)                                            │
└───────────────△──────────────────────────△──────────────────────────┘
        实现端口│                  消费事件│
┌───────────────┴──────────────────────────┴──────────────────────────┐
│  L2 接口适配器                                                        │
│  ai-sdk-adapter   fs-tools      editor-gateway    memory-store       │
│  ipc-bridge       lsp-bridge    plugin-host(P2)                      │
│  pty-adapter(P3)  task-adapter(P3)  sidecar-stub(P3)                 │
└───────────────△──────────────────────────△──────────────────────────┘
        调用用例│                  注入端口│
┌───────────────┴──────────────────────────┴──────────────────────────┐
│  L1 用例层                                                            │
│  agent-loop ──► tool-runtime    agent-loop ──► context               │
│  agent-loop ──► memory          agent-loop ──► session               │
│  skills（技能，P2.0，ADR-0022）                                       │
└───────────────△─────────────────────────────────────────────────────┘
                │只依赖
┌───────────────┴─────────────────────────────────────────────────────┐
│  L0 domain(消息/LoopState/工具契约/模式/护栏规则/事件/DiffProposal)   │
│      ports(ModelClient/ApprovalRequester/EditorGateway/ContextProvider│
│            /EventSink/MemoryStore/Clock | P3: TerminalProvider/Task…) │
└──────────────────────────────────────────────────────────────────────┘
```

## 2. 模块清单【规范】

| # | 模块 | 层 | 一句话职责 | 交付期 |
|---|---|---|---|---|
| 1 | **domain** 领域模型 | 实体 | 纯类型 + 纯规则函数，零框架 import | P1 |
| 2 | **ports** 端口契约 | 实体 | 内核所有的接口集合 | P1，P2/P3 只增不改 |
| 3 | **agent-loop** 执行引擎 | 用例 | while 循环、预算、死循环、降级收尾 | P1 |
| 4 | **tool-runtime** 工具运行时 | 用例 | 工具注册表 + 执行管道 | P1，P2/P3 只注册不改 |
| 5 | **context** 上下文装配 | 用例 | prompt 组装、Provider 扇入、token 预算分配 | P1，P2 扩贡献者 |
| 6 | **memory** 记忆策略 | 用例 | 三级记忆（瞬时/短期压缩/长期提炼召回） | P1 |
| 6A | **skills** 技能 | 用例 | 程序性知识：双作用域扫描、索引注入、read_skill 按需加载、首用确认（ADR-0022） | P2.0 |
| 7 | **session** 会话状态 | 用例 | Thread/Turn/Step 状态机 + 事件溯源持久化 | P1 |
| 8 | **ai-sdk-adapter** | 适配 | ModelClient 实现（唯一 import `ai` 包的位置） | P1 |
| 9 | **fs-tools** | 适配 | 内置文件工具 handler | P1 |
| 10 | **editor-gateway** | 适配 | 在渲染层用 Monaco 实现端口 | P1 |
| 11 | **ipc-bridge** | 适配 | 主↔渲染进程类型化总线 + 审批通道 | P1 |
| 12 | **memory-store** | 适配 | 记忆/日志持久化：P1 JSON 文件 → P2 SQLite | P1/P2 |
| 13 | **shell** 组合根 | 驱动 | Electron main：装配一切、恢复会话、策略配置、密钥 | P1 |
| 14 | **ui-renderer** | 驱动 | dockview 双布局预设 + 谦卑视图 | P1 |
| 15 | **plugin-sdk / plugin-host** | 驱动/适配 | 插件契约 + 进程托管 + 三种嵌入模式宿主 | P2 |
| 16 | **pty-adapter / task-adapter / sidecar-stub** | 适配 | 终端、任务系统、重型服务预留 | P3 |

## 3. 六条协调硬规则【规范】

1. **star 拓扑，不网状**：agent-loop 编排其余用例模块；context/memory/tools/session 彼此不互相调用，只通过 domain 类型交流。共享纯函数（截断、哈希）下沉到 domain。
2. **控制流可以出去，依赖必须进来**：审批、编辑器命令都是"内核发起、外层实现、端口隔离"（依赖倒置）。
3. **事件是唯一广播，命令是唯一请求**：类型定义在 domain/ports；UI 永不反查内核状态。
4. **注册表是唯一扩展点**：工具、上下文 Provider、视图、任务四类注册表。二三阶段的一切演进 = 向注册表注册新贡献者。
5. **状态只写在 session**（事件溯源持久化），其余模块零持久化——细化为"零*拥有*持久化状态"（ADR-0021）：条目记忆属内核状态走事件溯源；任务简报是外部文档（文件为主，经端口读写，事件仅审计）；产物是内容寻址外部证据。
6. **总线只出现在进程边界**：主↔渲染、宿主↔插件、宿主↔sidecar 共用同一套 RPC 信封；内核内部是类型化直调（ADR-0005）。

## 4. 目录结构【规范】

```
Loomery/
├─ package.json / pnpm-workspace.yaml / turbo.json
├─ packages/
│  ├─ domain/            # 实体层：类型 + 纯函数（零 import）
│  ├─ ports/             # 端口契约（仅依赖 domain）
│  ├─ agent-core/        # 用例层：loop / tools / context / memory / session
│  ├─ adapters/
│  │  ├─ ai-sdk-adapter/  fs-tools/  memory-store/  ipc-bridge/
│  │  ├─ editor-gateway/  lsp-bridge(P3)
│  │  └─ plugin-host(P2)  pty-adapter(P3)  task-adapter(P3)
│  ├─ shell/             # Electron main + bootstrap 组合根
│  ├─ ui/                # renderer：dockview + 视图 + Monaco
│  └─ plugin-sdk/        # P2 对外发布的契约包
├─ docs/                 # 本文档
└─ e2e/                  # 端到端验收脚本（P1 后期）
```

- domain / ports 必须是独立 package，用物理隔离强制零 import【规范】。
- agent-core 与各适配器之间用 dependency-cruiser / eslint-boundaries 声明依赖方向【规范】。
- CI import 自检：对 `packages/domain`、`packages/ports`、`packages/agent-core` 扫描 `electron | monaco | dockview | ai`，命中即失败（ADR-0006）。
- **文件级目录树与运行时目录见 [11-project-structure.md](11-project-structure.md)【规范】，M0 按此建树。**

## 5. 进程视图【规范】

```
┌─ Electron Main ────────────────────────────┐    ┌─ Renderer ──────────────────────┐
│ shell 组合根                                │    │ ui-renderer                     │
│  ├ agent-core(loop/tools/context/memory/   │    │  ├ dockview 五槽位 + 双布局预设  │
│  │  session/domain/ports)                  │IPC │  ├ Monaco + editor-gateway 实现  │
│  ├ ai-sdk-adapter ─────────────────────────┼─┼─►│  ├ Chat/Diff/审批/状态栏谦卑视图 │
│  ├ fs-tools(node:fs)   memory-store(JSON)  │总线│  └ 事件→视图模型 reducer         │
│  └ lsp-bridge(P3)→Language Server          │    └─────────────────────────────────┘
└────────────┬───────────────────┬───────────┘
       RPC(P2)│             RPC(P3)│  ← 同一套信封协议
   ┌──────────▼────────┐   ┌───────▼────────┐
   │ 插件进程(每插件一个)│   │ sidecar Go/Rust │
   │ agentTools/视图/上下文│  │ (三阶段预留)     │
   └───────────────────┘   └────────────────┘
```

- P1 时 agent-core 运行在 Electron main 进程【规范】。迁移到 utilityProcess 只是总线传输层替换，不是重设计【建议，需 ADR】。
- Agent 对文件的所有访问发生在 main 进程；渲染层通过 editor-gateway 提供编辑器状态。
- 密钥只在 main 进程内存中出现（见 07 §3）。

## 6. 跨期不变量【规范】

1. domain/ports/agent-core 的框架 import 为零（CI 强制）。
2. 事件与类型契约只增不改不删，事件信封携带 `schemaVersion`。
3. 端口归内核所有；新增能力 = 新端口 + 新适配器 + 组合根一行装配。
4. UI 只消费事件与视图模型，不查内核状态。
5. 所有进程边界走同一套 RPC 信封。
6. 状态只持久化在 session（事件溯源），checkpoint 快照是唯一的例外且自成体系（07 §5）。

## 7. 架构体检（每阶段末执行）

整洁架构四问（任一"不能"即返工）：

1. 换 LLM SDK/供应商，核心代码要不要改？——必须：否。
2. 换 UI 框架（Electron→Tauri、Monaco→CodeMirror），核心逻辑要不要改？——必须：否。
3. 能否脱离框架对 LoopState/终止/死循环/护栏/模式过滤做纯单元测试？——必须：能。
4. 接入新外部系统（插件、终端、编译）要不要改业务代码？——必须：否。

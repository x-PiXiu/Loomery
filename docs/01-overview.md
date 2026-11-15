# 01 · 产品定位与总体路线

## 1. 定位

Loomery 是一个**分阶段演进的 Agent 原生桌面代码编辑器**：

- **第一阶段**：能接入 LLM、能安全读写代码的最小 Agent 编辑器；
- **第二阶段**：插件系统扩展能力半径，Agent 直接调度插件贡献的工具与视图；
- **第三阶段**：终端、编译、调试等系统级能力。

### 贯穿三阶段的核心原则【规范】

> **宿主始终掌控产品形态与架构边界。Agent 与插件都是挂载在统一总线上的贡献者，而不是侵入内核的寄生者。**

这条原则决定所有技术选型与模块划分（详见 02-architecture.md）。

## 2. 三阶段范围

| 阶段 | 主题 | 关键能力 |
|---|---|---|
| P1 | 最小闭环 | 编辑器基座、Agent 循环、工具管道、审批门 + Diff、模式隔离、会话恢复、记忆、checkpoint 回滚 |
| P2 | 插件系统 | manifest 与懒激活、插件进程托管、声明式/iframe 视图、agentTools 与 contextProviders 动态注册、插件权限模型、SQLite 记忆存储、回放测试 |
| P3 | 系统能力 | 终端（内置插件身份）、任务系统与结构化诊断、run_command/run_task/get_build_diagnostics、正式 LSP、sidecar 接口预留、DAP（可选） |

三阶段演进方式【规范】：**每一阶段只往总线上加贡献者（新工具、新 Provider、新视图），不重写内核。**

## 3. 技术栈决策【规范】

| 层 | 选型 | 理由与边界 |
|---|---|---|
| 桌面壳 | Electron | 生态成熟、Monaco 集成经验丰富、插件 UI 嵌入方案最丰富（iframe / WebContentsView）。Tauri 会把插件隔离收窄到 iframe，不适合 P2 |
| 主语言 | TypeScript 全栈主干 | Agent 循环、插件宿主、UI 全部 TS。放弃 Go 主体（Go plugin 不支持 Windows、纯 Go UI 无法复用 Monaco） |
| 编辑器组件 | Monaco Editor | 显式配置 language worker；LSP 走 WebSocket + JSON-RPC Bridge，与 Agent 通道是两条独立管道 |
| 布局引擎 | dockview | IDE 式停靠面板，原生支持 tab/group 拖拽停靠、布局 JSON 序列化/反序列化——双布局预设的实现基础 |
| LLM 调用层 | Vercel AI SDK | 只用 `streamText` 作为"单次模型调用 + 流式工具声明"原语，**不接管循环**（ADR-0001、ADR-0002） |
| Agent 循环 | 完全自研 | 手写 while 循环，消息构建、工具执行、判停全部显式编码 |
| 重型能力预留 | Go/Rust sidecar + RPC | PTY、编译任务、大文件索引预留 gRPC/JSON-RPC 接口，P1/P2 不实现但接口留白 |
| 插件加载 | WASM（wazero）或独立进程 RPC | 跨平台、可隔离；P2 起步用 utilityProcess RPC，WASM 作为后续选项 |
| UI 形态 | Codex 风格 chat-first + 经典 IDE 双布局预设 | 见 06-ui-layout.md；同一套槽位，布局即预设 |

## 4. 明确放弃的方案【规范】

| 方案 | 放弃理由 |
|---|---|
| 纯 Go UI（Fyne/Gio） | 无法复用 Monaco，插件隔离方案受限 |
| trpc-agent-go 作为主循环引擎 | 控制权转移到 Go 侧，违背核心原则 |
| LangChain/LangGraph 在 P1 接管工具循环 | 图框架接管用例层；复杂化后可选 LangGraph.js 做"阶段流转"层（见 09-enterprise.md 预留） |
| 插件传任意 React 组件 | 锁死技术栈并破坏隔离；只承诺三种嵌入模式（见 05 §15） |

## 5. 术语表【规范】

| 术语 | 定义 |
|---|---|
| Session | 应用级工作会话（工作区 + 配置 + 线程集合） |
| Thread | 一条对话线程（消息历史 + 记忆 + 事件日志） |
| Turn | 一次用户请求触发的完整 Agent 循环 |
| Step | Turn 内一次"模型调用 + 工具执行"迭代 |
| LoopState | 单次 Turn 的显式循环状态（消息、步数、哈希集合、预算、终止原因） |
| ToolSpec / RegisteredTool | 工具契约：可序列化规格 / 规格 + handler 注册条目（ADR-0011） |
| DiffProposal | 一次待审批的文件修改提案（hunks + 状态机） |
| Checkpoint | Turn 级文件快照，支持一键回滚本轮 Agent 改动 |
| 槽位 | UI 固定区域：活动栏 / 侧栏 / 编辑区 / 辅助区 / 状态栏 |

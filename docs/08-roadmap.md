# 08 · 路线图：三期里程碑与验收

> 里程碑顺序即实现顺序；每个里程碑有明确验收标准，未达标不进入下一个。跨期不变量见 02 §6。

## 1. 第一期：最小闭环（P1）

| 里程碑 | 交付内容 | 验收标准 |
|---|---|---|
| **M0 工程骨架** | monorepo 分包（02 §4）；domain/ports 全类型编译通过；dependency-cruiser 依赖方向规则；CI import 自检；20 行手工组合根跑通空窗口；**密钥走 keychain 的读取通道** | `packages/{domain,ports,agent-core}` 扫描 `electron\|monaco\|dockview\|ai` 命中数为 0 |
| **M1 编辑器基座** | Electron 壳（07 §8 安全基线）；dockview 五槽位 + `codex`/`ide` 双布局预设 + 序列化恢复；文件树/标签页/保存/脏标记；Monaco 内置 worker 高亮与基础补全 | 拖拽布局重启后按预设还原；纯编辑功能不依赖 Agent 可独立使用 |
| **M2 事件管道** | LoopEvent 全集（04 引入期 P1 的全部事件）；EventSink 扇出（渲染层 + JSONL 持久化）；状态栏（模式/模型/token）；调试时间线 | UI 上一切可见数据能指出来源事件；杀进程重启后重放还原界面 |
| **M3 模型接入** | ModelClient 端口 + ai-sdk-adapter（消息翻译、finishReason 映射、429 重试事件化）；main/cheap 配置；**AppConfig + ConfigStore + 设置视图基础版（06 §4.6）**；Chat 流式渲染 + 停止按钮 + composer | 用"脚本化假 ModelClient"替换单测全部通过（端口有效性的直接证明）；密钥不出 main 进程；设置页修改模型配置即时生效 |
| **M4 循环最小闭环** | while 循环 + LoopState；自然终止 + 最大步数熔断；五个内置工具注册（read_file/list_dir/search_text/write_file/apply_diff）；turn 页脚用量统计 | 端到端演示"读文件→改文件→回复"；单测覆盖终止判定优先级矩阵 |
| **M5 工具管道与截断** | 责任链管道全序；JSON Schema 校验；护栏五规则（07 §4）；注入告警；工具结果硬截断 + 二进制探测 | 越界路径 100% 拦截；10MB 日志读入不撑爆上下文；注入样例文件触发告警并升级审批 |
| **M6 审批门与 Diff** | 策略表（配置加载）；审批三态（含 modified 重校验）；DiffProposal 生命周期；Chat 审批卡 + Diff 面板（inline/side）；plan/edit/explain 模式过滤 | plan 模式下修改类工具在 schema 中不可见；reject 后文件零改动；modified 输入重过校验 |
| **M7 韧性** | 死循环检测（哈希阈值 + 上下文哈希连续不变）；三预算 + 80% 预警 + 降级收尾；取消传播三段；checkpoint 懒快照 + 回滚 UI；会话持久化与恢复（interrupted 标记、pending 审批默认拒绝+说明） | 构造死循环场景 ≤3 步被拦截；运行中杀进程重启可续聊且界面一致；回滚后文件与快照前逐字节一致 |
| **M8 记忆一期** | 短期压缩（配对完整性保证）；长期记忆提炼/召回 + JSON 实现 | 压缩后 API 无配对错误；跨会话偏好可演示召回 |

**P1 期末体检**：02 §7 四问全部通过；grep 自检为零命中。

## 2. 第二期：插件系统（P2）

| 模块 | 本期功能 | 验收标准 |
|---|---|---|
| plugin-sdk | manifest 规范（含 publisher/signature 预留字段、activationEvents、contributes 五项）；类型包 + 脚手架模板 | 第三方不读内核源码即可开发插件 |
| plugin-host | manifest 扫描；懒激活；utilityProcess 托管 + 同一 RPC 信封握手/心跳/崩溃自动重启（退避）；host API 权限代理 + 首调授权 UI + 可撤销 | 杀插件进程，宿主与其余插件不受影响；授权撤销后调用被拒 |
| tool-runtime | 插件 agentTools 并入注册表（来源标记；策略可加严不可放宽）；会话中途安装 → 下一轮生效 | 会话中途装载插件工具并成功调用一次；卸载后 toolsChanged 正确撤销 |
| context | 插件 contextProvider 并入扇入与 token 预算 | 插件 provider 超配额被截断，不影响内置上下文 |
| ui-renderer | viewsContainers（活动栏图标）+ 声明式视图渲染器 + iframe 宿主（sandbox + postMessage 白名单）；插件视图纳入两套布局预设的持久化 | 插件视图可拖拽停靠且重启还原 |
| memory-store | 同端口换 SQLite + 数据搬迁脚本 | 切换存储时 agent-core 零改动 |
| 回放测试 | 用真实 JSONL 会话日志做回归：新 prompt/模型配置重放对比工具调用序列 | CI 中跑通一条回放基线 |

**P2 期末验收**：卸载全部插件 P1 功能无损；装一个示例插件同时演示 agentTools + 视图 + contextProvider 三种贡献，内核一行不改。

## 3. 第三期：系统能力（P3）

| 模块 | 本期功能 | 验收标准 |
|---|---|---|
| pty-adapter + 终端视图 | TerminalProvider 实现（node-pty）；xterm 视图走 P2 槽位机制，**以系统内置插件身份进入**；多会话、resize/kill | 终端不享受任何特权，全程走插件通道 |
| task-adapter | 项目类型检测；编译/测试/运行任务模板；输出解析器 → 结构化 Diagnostic | go build/tsc 报错解析为 file+line+severity 的结构化对象 |
| Agent 新工具 | `run_command`（白名单 + 默认 deny + 受限环境 + Agent/人类终端分离）；`run_task`；`get_build_diagnostics`（结构化） | 演示"编译失败 → Agent 读结构化诊断 → 定位行号 → apply_diff 修复 → 再编译通过"闭环 |
| lsp-bridge | 对接真实 Language Server（tsserver/pyright/gopls）；补全/跳转/重命名/诊断全走 LSP；诊断入 ContextProvider | Agent 对话中能引用实时诊断 |
| 外部终端 | "在外部终端打开当前目录"命令 | — |
| sidecar-stub | gRPC/JSON-RPC 接口桩（大文件索引），仅编译通过 | 接口编译通过（接口留白） |
| DAP（可选） | 断点/单步/变量查看 | 优先级最低，可延后 |

**P3 期末验收**：`git diff --stat` 证明 P1/P2 的 domain/ports/agent-core 接口目录零修改——"第三阶段不侵入前两阶段"用 diff 兑现。

## 4. 测试策略【规范】

| 层 | 对象 | 方法 |
|---|---|---|
| 纯单测 | domain 全部纯函数与类型 | 表驱动用例（护栏规则、模式过滤、哈希、截断） |
| 端口替换单测 | agent-core（loop/tools/context/memory/session） | 假 ModelClient（脚本化事件序列）、假 MemoryStore、假 Clock、假 ApprovalRequester |
| 适配器契约测试 | 各适配器 | 对端口契约的最小行为断言（如 ai-sdk-adapter 的事件归一化） |
| 回放测试 | 全链路 | 真实 JSONL 日志重放对比（P2 进 CI，ADR-0008 红利） |
| e2e 冒烟 | 打包产物 | 打开工作区 → 发起会话 → 工具执行 → 审批 → 回滚 主链路 |

## 5. 阶段体检清单（每期结束执行）

1. 整洁架构四问（02 §7）。
2. import 自检零命中。
3. 事件目录勾稽：04 中"引入期 ≤ 本期"的事件全部有生产者与消费者。
4. 验收标准逐条勾稽，失败的条目写整改清单后再收官。

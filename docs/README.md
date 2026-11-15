# Loomery 设计文档

Loomery：Agent 原生桌面代码编辑器。

**本文档是实现的唯一权威依据（Single Source of Truth）。后续实现严格按照本文档执行；文档与实现冲突时以文档为准，除非先修订文档。**

## 文档地图

| 文件 | 内容 | 性质 |
|---|---|---|
| [01-overview.md](01-overview.md) | 产品定位、三阶段路线、技术栈决策 | 规范 |
| [02-architecture.md](02-architecture.md) | 分层、模块清单、依赖规则、目录结构、进程视图 | 规范 |
| [03-core-contracts.md](03-core-contracts.md) | 领域模型与端口契约（TS 定义） | 规范（最强约束） |
| [04-event-pipeline.md](04-event-pipeline.md) | 事件信封与完整事件目录 | 规范（最强约束） |
| [05-modules.md](05-modules.md) | 各模块详细设计与关键时序 | 规范 |
| [06-ui-layout.md](06-ui-layout.md) | Codex 风格 UI 与双布局预设 | 规范（视觉细节为参考） |
| [07-security.md](07-security.md) | 审批门、护栏、密钥、注入防护、checkpoint、取消 | 规范 |
| [08-roadmap.md](08-roadmap.md) | 三期里程碑、验收标准、跨期不变量 | 规范 |
| [09-enterprise.md](09-enterprise.md) | 企业化预留设计 | 预留 |
| [10-adr.md](10-adr.md) | 架构决策记录（ADR） | 记录 |
| [11-project-structure.md](11-project-structure.md) | 仓库与运行时文件目录树（预期） | 规范 |
| [12-execution-plan-loop-terminal-git.md](12-execution-plan-loop-terminal-git.md) | 循环内核修复 + 终端/进程/Git 集成执行计划（阶段 0/1/2/3） | 规范 |
| [13-git-tool-suite.md](13-git-tool-suite.md) | Git 工具套件：审查标签页/提交推送弹窗/分支弹窗（含遗漏增补 L1-L10） | 规范 |

## 规范等级约定

- **【规范】**：实现必须遵守，违反即缺陷。
- **【建议】**：默认做法；偏离时必须先新增或修订 ADR。
- **【参考】**：背景知识或后续细化项，不构成约束。

## 修改规则

1. 修改 `03-core-contracts.md` 或 `04-event-pipeline.md` 中的任何类型/事件，必须新增或修订 ADR，并同步检查所有消费者模块的文档。
2. 事件与类型**只增不改不删**，版本演进规则见 04 §5。
3. 每个里程碑完成后，对照 `08-roadmap.md` 的验收标准逐条勾稽；未达标不进入下一里程碑。
4. 每个 P1/P2/P3 阶段结束时执行 08 §4 的"架构体检"（整洁架构四问 + import 自检）。

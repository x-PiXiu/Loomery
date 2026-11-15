// ADR-0015：执行侧契约归 ports —— domain 若持有 handler 将形成 domain→ports 反向依赖
import type { CompletionSelfReport, DiffProposal, ImageRef, MemoryFact, PlanStep, ToolEvidence, ToolSpec } from '@loomery/domain';
import type { EditorGateway } from './editor-gateway';

export interface ToolContext {
  workspaceRoots: string[];
  /** 取消传播到工具内部（07 §6） */
  signal: AbortSignal;
  /** 需要编辑器能力的工具使用（经 RPC 跨进程） */
  editor?: EditorGateway;
  /** 当前工具调用 ID（prepareApproval 产出 DiffProposal 时需要） */
  toolCallId?: string;
  /** 当前 Turn ID（checkpoint 懒快照按 Turn 归档，07 §5） */
  turnId?: string;
  /** 当前 Thread ID（memory_pin 等任务级工具按任务归档，ADR-0021） */
  threadId?: string;
  /** 本任务暂存区根（scratch 写免审的合法域，ADR-0021） */
  scratchRoot?: string;
  /** 本次调用目标全部位于暂存区（管道判定；handler 据此跳过 checkpoint，ADR-0021） */
  inScratch?: boolean;
  /** docs/16 P2：长驻命令的输出流式回调（run_command 用）——管道节流后转 observationAdded */
  onChunk?: (text: string) => void;
  /**
   * 领土实勘（symlink/junction 防线，ADR-0013 补全）：内核字符串护栏只看见路径文本，
   * workspace 内指向域外的符号链接可让写操作穿透审批门。适配器注入实现：对绝对路径做
   * realpath 解析（最近存在祖先），解析结果不在 workspace ∪ scratch 内时抛错。
   * 缺省时跳过（内核单测等无文件系统场景）。
   */
  verifyTerritory?: (absPath: string) => Promise<void>;
}

export interface ToolResult {
  ok: boolean;
  /** 原始内容；截断在管道内完成 */
  content: string;
  /** P3 结构化诊断等 */
  structured?: unknown;
  /** 本次执行影响的文件（绝对路径，ADR-0014 编辑器刷新依据） */
  affectedPaths?: string[];
  /** 本次新建的 checkpoint 快照文件（由管道统一发射 checkpointCreated 事件） */
  checkpointCreated?: string[];
  /** ADR-0021：以下三类由管道统一发射对应事件（handler 不持有 emit 通道，与 checkpointCreated 同模式） */
  /** memory_pin 成功 → memoryPinned */
  pinnedFact?: MemoryFact;
  /** brief_write 成功 → briefUpdated（仅审计） */
  briefUpdate?: { threadId: string; rev: number; hash: string };
  /** read_skill 成功 → skillUsed（记账，ADR-0022） */
  skillUsed?: { name: string; scope: 'user' | 'project' };
  /** ADR-0021 修复：结果必须内联返回（read_artifact/read_skill 等"取回内容"类工具）——管道跳过产物捕获，否则模型陷入指针死循环 */
  inline?: boolean;
  /** 12 UI：写工具自带 diff 提案（完全访问档跳过审批时，统计与 diff 视图的数据源）——管道转发进 toolExecuted */
  diffProposal?: DiffProposal;
  /** ADR-0026：计划步骤快照（plan_write 自报）——管道转发 planUpdated 事件（与 pinnedFact 同构） */
  planUpdate?: PlanStep[];
  /** docs/15 升级 B：机器证据（run_command/preview_control 自带）——不发事件，循环记账进证据账本 */
  evidence?: ToolEvidence;
  /** docs/15 机制一：task_complete 完成自评——循环捕获后收尾（termination='selfReport'） */
  finish?: CompletionSelfReport;
  /** docs/16 P2：工具产生的图像（截图）——loop 落进 tool-result part，translate 层按 vision 裁决 */
  images?: ImageRef[];
}

export type ToolHandler = (input: unknown, ctx: ToolContext) => Promise<ToolResult>;

/** 注册表内部条目 = 可序列化规格 + 执行体；handler 不进入任何序列化边界（ADR-0011） */
export interface RegisteredTool extends ToolSpec {
  handler?: ToolHandler;
  /** 审批前准备钩子：校验输入并产出 DiffProposal（apply_diff 的 hunk 校验、write_file 的旧新对比） */
  prepareApproval?: (input: unknown, ctx: ToolContext) => Promise<DiffProposal | undefined>;
  /** ADR-0022 首用确认：read 类工具按需要求审批（如项目级技能首次被 agent 读取）。返回 true 时该次调用走审批门 */
  requiresApproval?: (input: unknown, ctx: ToolContext) => boolean;
}

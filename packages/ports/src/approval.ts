// ADR-0003：审批控制流出内核、依赖进内核的倒置点
import type { DiffProposal, SideEffect } from '@loomery/domain';

export interface ApprovalSpec {
  approvalId: string;
  toolName: string;
  input: unknown;
  sideEffect: SideEffect;
  /** 修改类工具的 diff 预览（apply_diff 真实提案；write_file 合成提案） */
  diffProposal?: DiffProposal;
}

export type ApprovalDecision =
  | { kind: 'approved'; /** 12 §F1.5 会话级"总是允许"：本线程内同类 sideEffect 后续跳过审批（危险命令除外） */ always?: boolean }
  | { kind: 'rejected'; message?: string }
  | { kind: 'modified'; input: unknown; message?: string };

export interface ApprovalRequester {
  /** 挂起不限时（07 §1.3）；signal 取消时以 rejected/aborted 收尾 */
  request(spec: ApprovalSpec, signal: AbortSignal): Promise<ApprovalDecision>;
}

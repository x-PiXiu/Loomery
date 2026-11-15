// 03 §6 DiffProposal：一次待审批的文件修改提案
export interface DiffHunk {
  oldStart: number;
  oldLines: string[];
  newStart: number;
  newLines: string[];
}

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

export interface DiffProposal {
  id: string;
  /** 绝对路径（ADR-0013：领域对象与事件中的路径一律绝对路径） */
  path: string;
  hunks: DiffHunk[];
  status: ProposalStatus;
  toolCallId: string;
  createdAt: number;
  resolvedAt?: number;
}

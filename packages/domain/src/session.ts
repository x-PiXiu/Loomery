// 03 §3 会话四级状态：Session ⊃ Thread ⊃ Turn ⊃ Step
export type AgentMode = 'plan' | 'edit' | 'explain';

export type TurnStatus =
  | 'running'
  | 'awaiting-approval'
  | 'completed'
  | 'degraded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costEstimate: number;
}

export interface Session {
  id: string;
  workspaceRoots: string[];
  threadIds: string[];
}

export interface Thread {
  id: string;
  title: string;
  turnIds: string[];
  createdAt: number;
  /** 所属项目（工作区根）；P2 多项目，路径护栏/文件工具按线程归域 */
  workspaceRoot?: string;
  /** 累计 token 用量（usageDelta 折叠；使用统计页） */
  usageTokens?: number;
  /** 最大事件 seq（种子阶段回灌 FanoutSink，防元数据事件主键碰撞被静默丢弃） */
  maxSeq?: number;
}

export interface Turn {
  id: string;
  threadId: string;
  mode: AgentMode;
  status: TurnStatus;
  usage: Usage;
  startedAt: number;
  endedAt?: number;
}

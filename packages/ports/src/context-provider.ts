// 唯一扩展点之一：P2 插件从这里贡献上下文
import type { AgentMode } from '@loomery/domain';

export interface ContextChunk {
  providerId: string;
  text: string;
  /** 越小越优先保留（token 预算分配依据） */
  priority: number;
  tokens: number;
  /** ADR-0021：pinned 贡献者（用户钉住的事实/系统基础段）在预算仲裁中永不裁 */
  pinned?: boolean;
}

/** 贡献者上报通道（弱类型：ports 不依赖 agent-core 的 EmitFn，组装方负责适配） */
export interface ContributionReport {
  type: string;
  payload: unknown;
}

export interface ContextProviderCtx {
  threadId: string;
  mode: AgentMode;
  /** 最近一条用户消息，供相关性查询（如长期记忆召回，ADR-0012） */
  latestUserMessage?: string;
  /** 本线程路径域（多项目；loop 传入，项目级贡献者如 AGENTS.md 据此定位根） */
  workspaceRoots?: string[];
  /** ADR-0021 召回可解释性：贡献者借此上报 side-channel 事件（如 memoryRecalled），组装方接事件总线 */
  report?: (draft: ContributionReport) => void;
}

export interface ContextProvider {
  /** 全局唯一 */
  id: string;
  priority: number;
  provide(ctx: ContextProviderCtx): Promise<ContextChunk | null>;
}

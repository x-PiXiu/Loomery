// 03 §4 LoopState：单次 Turn 的显式循环状态
import type { ChatMessage } from './message';

export interface Budget {
  maxSteps: number;
  maxTurnTokens: number;
  maxWallMs: number;
}

export interface BudgetSpent {
  steps: number;
  tokens: number;
  wallMs: number;
}

export type TerminationReason =
  | 'natural'
  | 'selfReport'
  | 'maxSteps'
  | 'maxTurnTokens'
  | 'timeout'
  | 'loopDetected'
  | 'userCancelled'
  | 'modelError'
  | 'fatal';

export interface LoopState {
  threadId: string;
  turnId: string;
  messages: ChatMessage[];
  stepCount: number;
  /** hashToolCall(name, input) 集合（死循环检测） */
  seenToolCalls: Set<string>;
  /** 连续上下文哈希不变轮数 */
  contextHashStreak: number;
  budget: Budget;
  spent: BudgetSpent;
  /** 取消传播入口（07 §6） */
  abort: AbortSignal;
}

// ADR-0001/0002：循环唯一认得的"模型"端口；AI SDK 类型不得出现在此签名之外
import type { ChatMessage, ToolSpec } from '@loomery/domain';

export interface ModelRequest {
  modelTier: 'main' | 'cheap';
  system: string;
  messages: ChatMessage[];
  /** 已按模式过滤的工具规格（仅可序列化规格，不含 handler） */
  tools: ToolSpec[];
  /** 取消传播（07 §6） */
  signal: AbortSignal;
}

export type ModelFinishReason = 'stop' | 'tool-calls' | 'length' | 'error';

export type ModelStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call-delta'; toolCallId: string; argsDelta: string }
  | { type: 'tool-call-complete'; toolCallId: string; name: string; args: string }
  | { type: 'usage'; delta: { inputTokens: number; outputTokens: number } }
  /** 适配器内重试（429/5xx），事件化让 UI 有感知 */
  | { type: 'retrying'; attempt: number; reason: string }
  | { type: 'finish'; finishReason: ModelFinishReason; errorMessage?: string };

export interface ModelClient {
  stream(req: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

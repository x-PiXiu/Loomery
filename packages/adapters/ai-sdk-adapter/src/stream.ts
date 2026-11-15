// ModelClient 实现：streamText（maxRetries=0）→ 归一化 ModelStreamEvent + 外层重试
import { streamText, type FinishReason } from 'ai';
import type { LanguageModelUsage } from 'ai';
import type { ModelClient, ModelRequest, ModelStreamEvent } from '@loomery/ports';
import { resolveModel, type AiSdkClientConfig } from './model-registry';
import { backoffMs, errorMessage, isRetryable, delay } from './retry';
import { mapFinishReason, toModelMessages, toSdkTools } from './translate';
import { Semaphore } from './semaphore';

/** 全局并发上限（#8）：跨任务/跨档位共享，防 N 任务并发时打爆 API（429 靠上限而非只靠 backoff） */
export const DEFAULT_MODEL_CONCURRENCY = 4;

export class AiSdkModelClient implements ModelClient {
  private readonly models: Record<'main' | 'cheap', ReturnType<typeof resolveModel>>;
  /** docs/16：各档位模型的视觉能力（ModelConfig.capabilities.input 含 'image'）——translate 层据此裁决图像发送 */
  private readonly vision: Record<'main' | 'cheap', boolean>;
  private readonly maxRetries: number;
  private readonly gate: Semaphore;

  constructor(config: AiSdkClientConfig) {
    this.models = {
      main: resolveModel(config.main),
      cheap: resolveModel(config.cheap),
    };
    this.vision = {
      main: config.main.capabilities?.input.includes('image') === true,
      cheap: config.cheap.capabilities?.input.includes('image') === true,
    };
    this.maxRetries = config.maxRetries ?? 3;
    this.gate = new Semaphore(config.maxConcurrency ?? DEFAULT_MODEL_CONCURRENCY);
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const release = await this.gate.acquire(req.signal); // 排队中被取消 → AbortError 上抛（07 §6）
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          yield* this.attemptOnce(req);
          return;
        } catch (err) {
          if (req.signal.aborted) throw err; // 取消直接上抛（07 §6）
          if (attempt >= this.maxRetries || !isRetryable(err)) {
            yield { type: 'finish', finishReason: 'error', errorMessage: errorMessage(err) };
            return;
          }
          yield { type: 'retrying', attempt: attempt + 1, reason: errorMessage(err) };
          await delay(backoffMs(attempt), req.signal);
        }
      }
    } finally {
      release();
    }
  }

  private async *attemptOnce(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const result = streamText({
      model: this.models[req.modelTier],
      system: req.system,
      messages: toModelMessages(req.messages, { vision: this.vision[req.modelTier] }),
      tools: toSdkTools(req.tools),
      abortSignal: req.signal,
      maxRetries: 0, // 重试由本适配器统一处理以便事件化
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          yield { type: 'text-delta', text: part.text };
          break;
        case 'reasoning-delta':
          yield { type: 'reasoning-delta', text: part.text };
          break;
        case 'tool-input-delta':
          yield { type: 'tool-call-delta', toolCallId: part.id, argsDelta: part.delta };
          break;
        case 'tool-call':
          yield {
            type: 'tool-call-complete',
            toolCallId: part.toolCallId,
            name: part.toolName,
            args: JSON.stringify(part.input ?? {}),
          };
          break;
        case 'finish': {
          const usage = part.totalUsage as LanguageModelUsage | undefined;
          yield {
            type: 'usage',
            delta: {
              inputTokens: usage?.inputTokens ?? 0,
              outputTokens: usage?.outputTokens ?? 0,
            },
          };
          yield {
            type: 'finish',
            finishReason: mapFinishReason((part.finishReason ?? 'unknown') as FinishReason),
          };
          break;
        }
        case 'error':
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
        default:
          // start / text-start / text-end / tool-input-start / tool-input-end / source / file / abort
          break;
      }
    }
  }
}

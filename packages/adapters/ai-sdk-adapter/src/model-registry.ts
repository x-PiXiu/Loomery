// 模型注册：按 provider 协议分支解析 SDK 模型实例（多供应商，ADR-0019）
// 内核只认 ModelClient 端口；协议差异全部收拢在本包
import type { LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { ModelConfig } from '@loomery/domain';

export interface ResolvedModelConfig extends ModelConfig {
  /** 已由 shell 从 keychain 解析出的密钥明文（只在 main 进程内存传递，07 §3） */
  apiKey?: string;
}

export interface AiSdkClientConfig {
  main: ResolvedModelConfig;
  cheap: ResolvedModelConfig;
  /** 适配器内重试次数（05 §8），默认 3 */
  maxRetries?: number;
  /** 全局并发上限（#8）：同时打模型 API 的流数，默认 4 */
  maxConcurrency?: number;
}

const SUPPORTED = new Set(['openai-compatible', 'anthropic']);

/**
 * OpenAI 协议流式默认不返回用量——必须请求侧带 stream_options.include_usage=true
 * （实证：网关响应无 usage → 每步 usageDelta 全零，任务统计全空）。
 * 用 fetch 包装注入，网关不支持时忽略该字段（OpenAI 标准字段，无害）。
 */
function withStreamUsage(next: typeof fetch): typeof fetch {
  type FetchInput = Parameters<typeof fetch>[0];
  type FetchInit = Parameters<typeof fetch>[1];
  return (async (input: FetchInput, init?: FetchInit) => {
    if (init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body) as { stream?: boolean; stream_options?: unknown };
        if (body.stream === true && body.stream_options === undefined) {
          body.stream_options = { include_usage: true };
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch { /* 非 JSON body：透传 */ }
    }
    return next(input, init);
  }) as typeof fetch;
}

/** 按 provider 分支：协议差异由 AI SDK 官方包消化，归一化在 stream.ts 完成 */
export function resolveModel(cfg: ResolvedModelConfig): LanguageModel {
  const apiKey = cfg.apiKey;
  switch (cfg.provider) {
    case 'anthropic':
      return createAnthropic({
        baseURL: cfg.baseURL ?? 'https://api.anthropic.com/v1',
        ...(apiKey ? { apiKey } : {}),
      })(cfg.modelId) as unknown as LanguageModel;
    case 'openai-compatible':
    case undefined:
    case '':
      return createOpenAICompatible({
        name: cfg.provider || 'openai-compatible',
        baseURL: cfg.baseURL ?? 'https://api.openai.com/v1',
        ...(apiKey ? { apiKey } : {}),
        fetch: withStreamUsage(fetch),
      })(cfg.modelId) as unknown as LanguageModel;
    default:
      throw new Error(
        `不支持的供应商协议 "${cfg.provider}"（已支持: ${[...SUPPORTED].join(', ')}）`,
      );
  }
}

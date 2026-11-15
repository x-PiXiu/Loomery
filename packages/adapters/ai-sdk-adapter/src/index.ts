// ai-sdk-adapter：全工程唯一 import 'ai' 包的位置（ADR-0002）
import type { ModelClient } from '@loomery/ports';
import { AiSdkModelClient } from './stream';
import type { AiSdkClientConfig } from './model-registry';

export { toModelMessages, toSdkTools, mapFinishReason } from './translate';
export { isRetryable, backoffMs, errorMessage, delay } from './retry';
export { resolveModel, type AiSdkClientConfig, type ResolvedModelConfig } from './model-registry';
export { AiSdkModelClient } from './stream';

export function createAiSdkModelClient(config: AiSdkClientConfig): ModelClient {
  return new AiSdkModelClient(config);
}

/** 在线拉取供应商可用模型清单（设置页刷新按钮；超时 10s） */
export async function fetchProviderModels(opts: { provider: string; baseURL: string; apiKey?: string }): Promise<{ id: string }[]> {
  const { provider, baseURL, apiKey } = opts;
  const url = provider === 'anthropic'
    ? `${(baseURL || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/models`
    : `${(baseURL || 'https://api.openai.com/v1').replace(/\/$/, '')}/models`;
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (provider === 'anthropic') {
    headers['x-api-key'] = apiKey ?? '';
    headers['anthropic-version'] = '2023-06-01';
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { id?: string }[]; models?: { id?: string }[] };
  const items = body.data ?? body.models ?? [];
  return items.map((m) => ({ id: String(m.id ?? '') })).filter((m) => m.id.length > 0);
}

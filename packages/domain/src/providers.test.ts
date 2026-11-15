import { describe, expect, it } from 'vitest';
import { deriveProviders, flattenProviders, visibleModels } from './providers';
import type { AppConfig, ModelEntry } from './config';

const entry = (over: Partial<ModelEntry>): ModelEntry => ({
  id: over.id ?? 'e1',
  provider: 'openai-compatible',
  modelId: 'test-model',
  ...over,
});

const cfg = (entries: ModelEntry[], providers?: AppConfig['models']['providers']): AppConfig => ({
  models: { main: { provider: 'openai-compatible', modelId: 'm' }, cheap: { provider: 'openai-compatible', modelId: 'm' }, entries, ...(providers ? { providers } : {}) },
  approval: { read: 'auto', write: 'ask', execute: 'deny' },
  restorePolicy: 'reject',
  limits: { maxSteps: 1, maxTurnTokens: 1, maxWallMs: 1, toolResultCharCap: 1 },
  guardrails: { dangerousCommandPatterns: [], injectionPatterns: [] },
  workspaceRoots: [],
});

describe('flattenProviders（providers → 内核 entries）', () => {
  it('展平为逐模型 entry，apiFormat/baseURL/keyRef 下放；uid 优先', () => {
    const entries = flattenProviders([
      {
        id: 'p1', name: '小米', baseURL: 'https://x/v1', apiFormat: 'openai-compatible',
        apiKeyRef: 'prov-p1', enabled: true,
        models: [
          { uid: 'e_old', modelId: 'mimo-pro', contextWindow: 1_000_000 },
          { uid: 'e_new', modelId: 'mimo-flash', enabled: false },
        ],
      },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: 'e_old', provider: 'openai-compatible', baseURL: 'https://x/v1', apiKeyRef: 'prov-p1', enabled: true });
    expect(entries[1]!.enabled).toBe(false);
  });
  it('供应商禁用 → 全部模型 entry.enabled=false', () => {
    const entries = flattenProviders([
      { id: 'p1', name: 'x', baseURL: '', apiFormat: 'openai-compatible', enabled: false, models: [{ uid: 'e1', modelId: 'm' }] },
    ]);
    expect(entries[0]!.enabled).toBe(false);
  });
});

describe('deriveProviders（旧配置合成视图）', () => {
  it('按 apiFormat+baseURL 分组，uid=原 entry id（activeId 引用稳定）', () => {
    const config = cfg([
      entry({ id: 'e1', modelId: 'mimo-pro', baseURL: 'https://x/v1', displayName: '小米' }),
      entry({ id: 'e2', modelId: 'mimo-flash', baseURL: 'https://x/v1' }),
      entry({ id: 'e3', modelId: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1' }),
    ]);
    const providers = deriveProviders(config);
    expect(providers).toHaveLength(2);
    const x = providers.find((p) => p.baseURL === 'https://x/v1')!;
    expect(x.models.map((m) => m.uid)).toEqual(['e1', 'e2']);
    expect(x.models[0]!.uid).toBe('e1');
  });
  it('已有 providers 时原样返回（不重复合成）', () => {
    const providers: AppConfig['models']['providers'] = [
      { id: 'p1', name: 'n', baseURL: '', apiFormat: 'openai-compatible', enabled: true, models: [{ uid: 'e1', modelId: 'm' }] },
    ];
    expect(deriveProviders(cfg([], providers))).toBe(providers);
  });
});

describe('visibleModels（聊天选择器过滤）', () => {
  it('disabled 模型不出现在选择器', () => {
    const config = cfg([
      entry({ id: 'e1', modelId: 'on' }),
      entry({ id: 'e2', modelId: 'off', enabled: false }),
    ]);
    expect(visibleModels(config).map((e) => e.id)).toEqual(['e1']);
  });
});

// 设置页供应商为中心的管理（P2）：providers（数据中心结构）与 entries（内核契约）的双向同步纯函数
// flattenProviders：configSave 时由组合根调用——providers 展平生成 entries（内核/ai-sdk-adapter 零改动）
// deriveProviders：设置页读取时调用——无 providers 的旧配置按 entry.provider+baseURL 分组合成视图（兼容迁移）
// 注意：本模块被浏览器端引用（ui 设置页），禁止 node 内置 import（ADR-0020 diff 子路径同例）
import type { AppConfig, ModelEntry, ProviderEntry } from './config';

/** providers → entries 展平（uid 优先作为 entry.id，保持 activeId 引用稳定） */
export function flattenProviders(providers: ProviderEntry[]): ModelEntry[] {
  const out: ModelEntry[] = [];
  for (const p of providers) {
    for (const m of p.models) {
      out.push({
        id: m.uid,
        provider: p.apiFormat,
        modelId: m.modelId,
        baseURL: p.baseURL,
        apiKeyRef: p.apiKeyRef,
        contextWindow: m.contextWindow,
        capabilities: m.capabilities,
        displayName: m.displayName,
        enabled: p.enabled && m.enabled !== false,
      });
    }
  }
  return out;
}

/** 旧配置（无 providers）→ 供应商视图合成：按 apiFormat+baseURL 分组，uid=原 entry id（activeId 引用不失效） */
export function deriveProviders(config: AppConfig): ProviderEntry[] {
  if (config.models.providers && config.models.providers.length > 0) return config.models.providers;
  const groups = new Map<string, ProviderEntry>();
  for (const e of config.models.entries ?? []) {
    const key = e.provider + '|' + (e.baseURL ?? '');
    let g = groups.get(key);
    if (!g) {
      g = {
        id: 'prov_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: providerNameOf(e),
        baseURL: e.baseURL ?? '',
        apiFormat: e.provider === 'anthropic' ? 'anthropic' : 'openai-compatible',
        apiKeyRef: e.apiKeyRef ?? 'main-api-key',
        enabled: e.enabled !== false,
        models: [],
      };
      groups.set(key, g);
    }
    g.models.push({ uid: e.id, modelId: e.modelId, contextWindow: e.contextWindow, capabilities: e.capabilities, displayName: e.displayName, enabled: e.enabled !== false });
  }
  return [...groups.values()];
}

function providerNameOf(e: ModelEntry): string {
  if (e.displayName && e.displayName !== e.modelId) return e.displayName;
  if (e.baseURL) {
    try {
      return new URL(e.baseURL).hostname;
    } catch {
      return e.baseURL;
    }
  }
  return e.provider === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容';
}

/** 聊天选择器可见性：供应商启用 && 模型未禁用 */
export function visibleModels(config: AppConfig): ModelEntry[] {
  return (config.models.entries ?? []).filter((e) => e.enabled !== false);
}

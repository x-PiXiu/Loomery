// 设置页（P2 重构，对齐 ZCode）：双栏设置壳 + 供应商为中心的模型管理
// 数据流：deriveProviders(config) 合成视图 → 本地编辑 → configSave({models:{providers}}) → 组合根展平同步 entries
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { X } from 'lucide-react';
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';
import { rpc } from '@loomery/adapter-ipc-bridge/renderer';
import type { AppConfig, ProviderEntry } from '@loomery/domain';
import { deriveProviders, flattenProviders } from '@loomery/domain/providers';
import { runtime, useRuntime } from '../../stores/runtime';
import { PROVIDER_PRESETS, type ProviderPreset } from './presets';
import { BrandIcon } from './brand-icons';
import { DataDirCard } from './DataDirCard';
import { MemorySettings, ShortcutsSettings } from './capability-panels';
import { UsageSettings } from './usage-panel';
import { RunMetrics } from './metrics-panel';
import { SkillsSettings } from './SkillsSettings';

type Section = 'models' | 'appearance' | 'datadir' | 'memory' | 'skills' | 'usage' | 'metrics' | 'persona' | 'shortcuts';

/** 设置整页（对齐 ZCode）：覆盖整个窗口，返回工作区退出 */
export function SettingsPage({ onClose, initialSection }: { onClose: () => void; initialSection?: string }): ReactElement {
  return (
    <div className="settings-page">
      <div className="settings-page-head">
        <button className="mode-btn" onClick={onClose}>← 返回工作区</button>
        <b>设置</b>
        <button className="icon-btn" onClick={onClose}><X size={15} /></button>
      </div>
      <SettingsView initialSection={initialSection} />
    </div>
  );
}

export function SettingsView({ initialSection }: { initialSection?: string }): ReactElement {
  const [section, setSection] = useState<Section>((initialSection as Section) ?? 'models');
  const theme = (document.documentElement.dataset.theme ?? 'dark') as 'dark' | 'light';
  const navItems: { id: Section; label: string; group: string }[] = [
    { id: 'models', label: '模型设置', group: '基础设置' },
    { id: 'appearance', label: '外观', group: '基础设置' },
    { id: 'datadir', label: '数据目录', group: '基础设置' },
    { id: 'shortcuts', label: '键盘快捷键', group: '基础设置' },
    { id: 'memory', label: '记忆', group: 'Agent 能力' },
    { id: 'skills', label: '技能', group: 'Agent 能力' },
    { id: 'persona', label: 'Agent 人格', group: 'Agent 能力' },
    { id: 'usage', label: '使用统计', group: '数据与统计' },
    { id: 'metrics', label: '运行指标', group: '数据与统计' },
  ];
  const setTheme = (next: 'dark' | 'light'): void => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem('loomery.theme', next);
    window.dispatchEvent(new CustomEvent('loomery:theme'));
  };
  return (
    <div className="settings-shell">
      <aside className="settings-nav">
        {['基础设置', 'Agent 能力', '数据与统计'].map((group) => (
          <div key={group} className="settings-nav-group">
            <div className="settings-nav-title">{group}</div>
            {navItems.filter((n) => n.group === group).map((n) => (
              <button key={n.id} className={`settings-nav-item ${section === n.id ? 'active' : ''}`} onClick={() => setSection(n.id)}>
                {n.label}
              </button>
            ))}
          </div>
        ))}

      </aside>
      <section className="settings-content">
        {section === 'models' ? <ModelsSettings /> : null}
        {section === 'appearance' ? (
          <div className="settings-pane">
            <div className="settings-pane-title">外观</div>
            <div className="notice">主题（仅深色 / 浅色两套）</div>
            <div className="theme-cards">
              <button className={`theme-card ${theme === 'dark' ? 'active' : ''}`} onClick={() => setTheme('dark')}>
                <span className="mock dark"><span className="side" /><span className="main"><span className="dot" /></span></span>
                <span className="theme-name">深色{theme === 'dark' ? ' ✓' : ''}</span>
              </button>
              <button className={`theme-card ${theme === 'light' ? 'active' : ''}`} onClick={() => setTheme('light')}>
                <span className="mock light"><span className="side" /><span className="main"><span className="dot" /></span></span>
                <span className="theme-name">浅色{theme === 'light' ? ' ✓' : ''}</span>
              </button>
            </div>
          </div>
        ) : null}
        {section === 'datadir' ? <DataDirCard /> : null}
        {section === 'memory' ? <MemorySettings /> : null}
        {section === 'skills' ? <SkillsSettings /> : null}
        {section === 'usage' ? <UsageSettings /> : null}
        {section === 'metrics' ? <RunMetrics /> : null}
        {section === 'persona' ? <PersonaSettings /> : null}
        {section === 'shortcuts' ? <ShortcutsSettings /> : null}
      </section>
    </div>
  );
}

// ---------- 模型设置（供应商为中心） ----------

function ModelsSettings(): ReactElement {
  const config = useRuntime((s) => s.config);
  const providers = useMemo(() => (config ? deriveProviders(config) : []), [config]);
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [keyStates, setKeyStates] = useState<Record<string, boolean>>({});
  useEffect(() => {
    // 供应商密钥状态（不回读明文，只查存在性）
    for (const p of providers) {
      const ref = p.apiKeyRef;
      if (!ref || keyStates[ref] !== undefined) continue;
      void rpc.call<boolean>(RPC.secretsHas, { key: ref }).then((has) => setKeyStates((prev) => ({ ...prev, [ref]: has })));
    }
  }, [providers, keyStates]);

  const save = (next: ProviderEntry[]): void => {
    if (!config) return;
    // providers 与内核 entries 由组合根展平同步（flattenProviders），activeId 引用 uid 稳定
    void rpc.call(RPC.configSave, { models: { ...config.models, providers: next, entries: flattenProviders(next) } })
      .then(async () => runtime.set({ config: await rpc.call<typeof config>(RPC.configGet) }))
      .catch(() => undefined);
  };
  const update = (pid: string, patch: Partial<ProviderEntry>): void => {
    save(providers.map((p) => (p.id === pid ? { ...p, ...patch } : p)));
  };
  // （在线拉清单已迁入 ProviderDetail：作用于选中供应商详情上下文）
  const addFromPreset = (preset: ProviderPreset): void => {
    const id = 'prov_' + Math.random().toString(36).slice(2, 8);
    const entry: ProviderEntry = {
      id,
      name: preset.name,
      preset: preset.id,
      baseURL: preset.baseURL,
      apiFormat: preset.apiFormat,
      apiKeyRef: preset.requiresKey === false ? undefined : 'key_' + id,
      enabled: true,
      models: preset.models.map((m) => ({ uid: 'e_' + Math.random().toString(36).slice(2, 8), modelId: m.modelId, contextWindow: m.contextWindow ?? 1_000_000, displayName: m.displayName, enabled: true }))
    };
    save([...providers, entry]);
    setSelected(id);
  };

  return (
    <div className="settings-pane models-pane">
      <div className="settings-pane-title">模型设置</div>
      <div className="models-head">
        <span className="models-desc">管理模型供应商，配置后可在聊天时选择使用。</span>
        <span style={{ display: 'inline-flex', gap: 8, marginLeft: 'auto' }}>
          <button className="mode-btn" title="在选中供应商的详情面板内点'⟳ 拉取清单'" onClick={() => { window.dispatchEvent(new CustomEvent('loomery:fetch-models', { detail: selected })); }}>⟳ 拉取模型清单</button>
          <button className="mode-btn active" onClick={() => setSelected('new')}>＋ 添加供应商</button>
        </span>
      </div>
      <div className="models-two-pane">
        <aside className="provider-list">
          <div className="settings-nav-title">自定义供应商</div>
          {providers.length === 0 ? <div className="notice">尚无供应商，点右上角添加。</div> : null}
          {providers.map((p) => {
            const hasKey = keyStates[p.apiKeyRef ?? ''] ?? false;
            const presetDef = PROVIDER_PRESETS.find((x) => x.id === p.preset);
            const ok = p.enabled && (hasKey || presetDef?.requiresKey === false || !p.apiKeyRef);
            return (
              <button key={p.id} className={`provider-item ${selected === p.id ? 'active' : ''}`} onClick={() => setSelected(p.id)}>
                <ProviderIcon preset={presetDef} name={p.name} />
                <span className="provider-item-name">{p.name}</span>
                <span className={`status-dot ${ok ? 'ok' : 'warn'}`} />
              </button>
            );
          })}
        </aside>
        <section className="provider-detail">
          {selected === 'new' ? (
            <PresetGrid onPick={addFromPreset} onBack={() => setSelected(null)} />
          ) : selected && providers.some((p) => p.id === selected) ? (
            <ProviderDetail
              provider={providers.find((p) => p.id === selected)!}
              keyStates={keyStates}
              update={(patch) => update(selected, patch)}
              onKeySaved={(ref) => setKeyStates((prev) => ({ ...prev, [ref]: true }))}
              providers={providers}
              onDelete={() => { save(providers.filter((p) => p.id !== selected)); setSelected(null); }}
            />
          ) : (
            <div className="notice" style={{ margin: 'auto' }}>← 选择或添加一个供应商</div>
          )}
        </section>
      </div>
    </div>
  );
}

function ProviderIcon({ preset }: { preset?: ProviderPreset; name?: string }): ReactElement {
  if (preset) return <BrandIcon id={preset.iconId} />;
  // 自定义/迁移来的供应商：中性圆点标（无品牌可指）
  return <BrandIcon id="custom" />;
}

function PresetGrid({ onPick, onBack }: { onPick: (p: ProviderPreset) => void; onBack: () => void }): ReactElement {
  const groups = ['推荐', '其他'] as const;
  return (
    <div className="preset-grid-pane">
      <div className="preset-grid-head">
        <button className="mode-btn" onClick={onBack}>← 返回</button>
        <b>添加供应商</b>
      </div>
      {groups.map((g) => (
        <div key={g}>
          <div className="settings-nav-title">{g}</div>
          <div className="preset-grid">
            {PROVIDER_PRESETS.filter((p) => p.group === g).map((p) => (
              <button key={p.id} className="preset-card" onClick={() => onPick(p)} title={p.hint ?? p.name}>
                <ProviderIcon preset={p} name={p.name} />
                <span className="preset-card-name">{p.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ProviderDetail({ provider, keyStates: keys, update, providers, onKeySaved, onDelete }: {
  provider: ProviderEntry;
  keyStates: Record<string, boolean>;
  update: (patch: Partial<ProviderEntry>) => void;
  providers: ProviderEntry[];
  onKeySaved: (ref: string) => void;
  onDelete: () => void;
}): ReactElement {
  const ref = provider.apiKeyRef ?? '';
  const [fetchNote, setFetchNote] = useState('');
  const refreshModels = async (): Promise<void> => {
    setFetchNote('拉取中…');
    try {
      const r = await rpc.call<{ ok: boolean; models?: { id: string }[]; error?: string }>(RPC.modelsList, { provider: provider.apiFormat, baseURL: provider.baseURL });
      if (!r.ok) throw new Error(r.error ?? '拉取失败');
      const existing = new Set(provider.models.map((m) => m.modelId));
      const added = (r.models ?? []).filter((m) => !existing.has(m.id)).map((m) => ({ uid: 'e_' + Math.random().toString(36).slice(2, 8), modelId: m.id, contextWindow: 1_000_000, enabled: false }));
      update({ models: [...provider.models, ...added] });
      setFetchNote('拉到 ' + added.length + ' 个新模型（未启用，按需打开）');
    } catch (err) {
      setFetchNote('拉取失败：' + String(err instanceof Error ? err.message : err));
    }
    setTimeout(() => setFetchNote(''), 4000);
  };
  useEffect(() => {
    const onFetch = (): void => { void refreshModels(); };
    window.addEventListener('loomery:fetch-models', onFetch);
    return () => window.removeEventListener('loomery:fetch-models', onFetch);
  });
  const [showKey, setShowKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [tests, setTests] = useState<Record<string, { ok: boolean; ms?: number; error?: string }>>({});
  const hasKey = keys[ref] ?? false;
  const presetDef = PROVIDER_PRESETS.find((x) => x.id === provider.preset);

  const saveKey = (): void => {
    if (keyDraft.trim().length === 0 || !ref) return;
    void rpc.call(RPC.secretsSet, { key: ref, value: keyDraft.trim() }).then(() => {
      setKeyDraft('');
      onKeySaved(ref);
    });
  };
  const testModel = (uid: string): void => {
    setTests((prev) => ({ ...prev, [uid]: { ok: false, error: '测试中…' } }));
    void rpc.call<{ ok: boolean; ms?: number; error?: string }>(RPC.modelTest, { id: uid }).then((r) => setTests((prev) => ({ ...prev, [uid]: r })));
  };
  const updateModel = (uid: string, patch: Partial<ProviderEntry['models'][number]>): void => {
    update({ models: provider.models.map((m) => (m.uid === uid ? { ...m, ...patch } : m)) });
  };
  const addModel = (): void => {
    update({ models: [...provider.models, { uid: 'e_' + Math.random().toString(36).slice(2, 8), modelId: '', contextWindow: 1_000_000, enabled: true }] });
  };

  return (
    <div className="provider-form">
      {fetchNote ? <div className="notice">{fetchNote}</div> : null}
      <div className="provider-form-head">
        <ProviderIcon preset={presetDef} name={provider.name} />
        <input className="provider-name-input" value={provider.name} onChange={(e) => update({ name: e.target.value })} />
        <label className="switch" title={provider.enabled ? '已启用' : '已停用'}>
          <input type="checkbox" checked={provider.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          <span className="switch-slider" />
        </label>
        <button className="mode-btn" onClick={onDelete}>删除</button>
      </div>
      <label className="settings-field">
        Base URL
        <input value={provider.baseURL} onChange={(e) => update({ baseURL: e.target.value })} placeholder="https://api.example.com/v1" />
      </label>
      <label className="settings-field">
        API 格式
        <select value={provider.apiFormat} onChange={(e) => update({ apiFormat: e.target.value as ProviderEntry['apiFormat'] })}>
          <option value="openai-compatible">OpenAI 兼容（/chat/completions）</option>
          <option value="anthropic">Anthropic Messages（/v1/messages）</option>
        </select>
      </label>
      {provider.apiKeyRef ? (
        <label className="settings-field">
          API Key {hasKey ? <span className="key-saved">（已保存，输入新值可覆盖）</span> : null}
          <span className="key-row">
            <input
              type={showKey ? 'text' : 'password'}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              onBlur={saveKey}
              placeholder={hasKey ? '••••••••' : 'sk-...'}
            />
            <button className="mode-btn" onClick={() => setShowKey((v) => !v)}>{showKey ? '隐藏' : '显示'}</button>
          </span>
        </label>
      ) : null}
      <div className="models-list-head">
        <span>模型列表</span>
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <button className="mode-btn" onClick={() => void refreshModels()}>⟳ 拉取清单</button>
          <button className="mode-btn" onClick={addModel}>＋ 添加模型</button>
        </span>
      </div>
      <div className="models-list">
        {provider.models.map((m) => {
          const t = tests[m.uid];
          return (
            <div key={m.uid} className="model-row">
              <input className="model-id-input" value={m.modelId} placeholder="model-id" onChange={(e) => updateModel(m.uid, { modelId: e.target.value })} />
              <span className="model-badge">{Math.round((m.contextWindow ?? 1_000_000) / 10_000) / 100 >= 0.1 ? formatWindow(m.contextWindow) : '?'}</span>
              <button
                className={`mode-btn ${m.capabilities?.input.includes('image') ? 'vision-on' : 'vision-off'}`}
                title={m.capabilities?.input.includes('image') ? '已声明视觉能力（browser_control 截图将以图像喂给模型）——点击取消' : '声明视觉能力（截图以图像喂给模型）——点击开启'}
                onClick={() => {
                  const input: ('text' | 'image')[] = m.capabilities?.input.includes('image') ? ['text'] : ['text', 'image'];
                  updateModel(m.uid, { capabilities: { ...m.capabilities, input } });
                }}
              >
                {m.capabilities?.input.includes('image') ? '👁' : '👁‍🗨'}
              </button>
              <label className="switch small">
                <input type="checkbox" checked={m.enabled !== false} onChange={(e) => updateModel(m.uid, { enabled: e.target.checked })} />
                <span className="switch-slider" />
              </label>
              <button className="mode-btn" title="测试连通性" onClick={() => testModel(m.uid)}>⚡</button>
              <button className="mode-btn" title="删除" onClick={() => update({ models: provider.models.filter((x) => x.uid !== m.uid) })}>✕</button>
              {t ? <span className={`test-result ${t.ok ? 'ok' : 'err'}`}>{t.ok ? `✓ ${t.ms}ms` : `✗ ${t.error}`}</span> : null}
            </div>
          );
        })}
        {provider.models.length === 0 ? <div className="notice">该供应商下暂无模型，点"＋ 添加模型"。</div> : null}
      </div>
      <div className="notice">当前使用的模型在聊天区底部选择器切换；disabled 模型不出现在选择器。共 {flattenProviders(providers).length} 个模型已登记。</div>
    </div>
  );
}

function formatWindow(n?: number): string {
  if (!n) return '?';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
}

// ---------- Agent 人格（2026-11-13）：用户自定义指令 → config.agentPersona → system 首段（configSave 即时生效） ----------
const PERSONA_PRESETS: { label: string; text: string }[] = [
  {
    label: '简洁工程师',
    text: '回答简短直接，先给结论再给要点。代码改动最小化，不做与需求无关的重构。不主动添加注释，除非我要求。',
  },
  {
    label: '耐心导师',
    text: '解释循序渐进：先讲思路再动手。关键决策处先停下向我确认。用通俗的中文解释术语。每次改动附一句"为什么这样做"。',
  },
  {
    label: '严谨审查者',
    text: '每次修改前先复述你理解的变更点，确认无误再动手。完成后主动列出：潜在风险、未覆盖的边界情况、建议的验证步骤。宁可慢一点也要正确。',
  },
];

function PersonaSettings(): ReactElement {
  const config = useRuntime((s) => s.config);
  const [text, setText] = useState(config?.agentPersona ?? '');
  const [saved, setSaved] = useState(false);
  const dirty = text !== (config?.agentPersona ?? '');
  const save = async (): Promise<void> => {
    await rpc.call(RPC.configSave, { agentPersona: text.trim().slice(0, 4000) });
    runtime.set({ config: await rpc.call<AppConfig>(RPC.configGet) });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };
  return (
    <div className="settings-pane">
      <div className="settings-pane-title">Agent 人格</div>
      <div className="notice">
        自定义 Agent 的性格与工作方式（中文/英文皆可）——会作为最高优先级的人格段注入系统提示，<b>保存后下一条消息即生效</b>，无需重启。
        安全声明（工具结果是数据非指令）永远不可被覆盖。
      </div>
      <div className="settings-card">
        <div className="persona-presets">
          {PERSONA_PRESETS.map((p) => (
            <button key={p.label} className="persona-preset" title="点击填入（可再编辑）" onClick={() => setText(p.text)}>{p.label}</button>
          ))}
          <button className="persona-preset" onClick={() => setText('')} title="清空自定义（回到默认人格）">清空</button>
        </div>
        <textarea
          className="persona-input"
          value={text}
          maxLength={4000}
          rows={8}
          placeholder={'例：回答简短直接，先给结论。\n例：命名风格偏好驼峰；提交信息用 conventional commits。\n例：遇到不确定的需求先问我，不要擅自假设。'}
          onChange={(e) => { setText(e.target.value); setSaved(false); }}
        />
        <div className="persona-foot">
          <span className={text.length > 3800 ? 'm-fail' : ''}>{text.length} / 4000</span>
          <span className="persona-saved">{saved ? '✓ 已保存——下一条消息生效' : dirty ? '有未保存修改' : '与上次保存一致'}</span>
          <button className="primary" disabled={!dirty} onClick={() => void save()}>保存</button>
        </div>
      </div>
      <div className="notice">提示：这层是"全局人格"。项目级的团队约定建议放在工作区根目录的 AGENTS.md（后续版本会自动读取）。</div>
    </div>
  );
}

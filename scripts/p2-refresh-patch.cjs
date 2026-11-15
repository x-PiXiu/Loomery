// P2 设置二期：models-head 加"拉取模型清单"按钮 + refreshModels 实现
const fs = require('node:fs');
const p = 'packages/ui/src/views/settings/SettingsView.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) { console.error('MISS: ' + a.slice(0, 70)); process.exit(1); }
  s = s.replace(a, b);
};

rep(
  `      <div className="models-head">
        <span className="models-desc">管理模型供应商，配置后可在聊天时选择使用。</span>
        <button className="mode-btn active" onClick={() => setSelected('new')}>＋ 添加供应商</button>
      </div>`,
  `      <div className="models-head">
        <span className="models-desc">管理模型供应商，配置后可在聊天时选择使用。</span>
        <span style={{ display: 'inline-flex', gap: 8, marginLeft: 'auto' }}>
          <button className="mode-btn" title="在线拉取该供应商可用模型清单" onClick={() => { if (selected && selected !== 'new') refreshModels(selected); }}>⟳ 拉取模型清单</button>
          <button className="mode-btn active" onClick={() => setSelected('new')}>＋ 添加供应商</button>
        </span>
      </div>`,
);
rep(
  `  const update = (pid: string, patch: Partial<ProviderEntry>): void => {
    save(providers.map((p) => (p.id === pid ? { ...p, ...patch } : p)));
  };`,
  `  const update = (pid: string, patch: Partial<ProviderEntry>): void => {
    save(providers.map((p) => (p.id === pid ? { ...p, ...patch } : p)));
  };
  const [fetchNote, setFetchNote] = useState('');
  // ADR-0021：在线拉清单——追加为未启用行（不覆盖已有；key 未填时由供应商端报错提示）
  const refreshModels = async (pid: string): Promise<void> => {
    const p = providers.find((x) => x.id === pid);
    if (!p || !p.baseURL) { setFetchNote('先填写 Base URL'); return; }
    setFetchNote('拉取中…');
    try {
      const { fetchProviderModels } = await import('@loomery/adapter-ai-sdk');
      const list = await fetchProviderModels({ provider: p.apiFormat, baseURL: p.baseURL, apiKey: undefined });
      const existing = new Set(p.models.map((m) => m.modelId));
      const added = list.filter((m) => !existing.has(m.id)).map((m) => ({ uid: 'e_' + Math.random().toString(36).slice(2, 8), modelId: m.id, contextWindow: 1_000_000, enabled: false }));
      update(pid, { models: [...p.models, ...added] });
      setFetchNote('拉到 ' + added.length + ' 个新模型（未启用，按需打开）');
    } catch (err) {
      setFetchNote('拉取失败：' + String(err instanceof Error ? err.message : err));
    }
    setTimeout(() => setFetchNote(''), 4000);
  };`,
);
fs.writeFileSync(p, s);
console.log('refresh wired');

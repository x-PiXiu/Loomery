// P2 设置二期收尾：refreshModels/fetchNote 移入 ProviderDetail（原误放 ModelsSettings 导致跨作用域）
const fs = require('node:fs');
const p = 'packages/ui/src/views/settings/SettingsView.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) { console.error('MISS: ' + a.slice(0, 70)); process.exit(1); }
  s = s.replace(a, b);
};

// 1) 从 ModelsSettings 摘除 fetchNote 状态与 refreshModels 实现
rep(
  `  const [fetchNote, setFetchNote] = useState('');
  // ADR-0021：在线拉清单——填好 key 后拉该供应商可用模型，追加为未启用行（不覆盖已有）
  const refreshModels = async (pid: string): Promise<void> => {
    const p = providers.find((x) => x.id === pid);
    if (!p || !p.baseURL) { setFetchNote('先填写 Base URL'); return; }
    setFetchNote('拉取中…');
    try {
      const r = await rpc.call<{ ok: boolean; models?: { id: string }[]; error?: string }>(RPC.modelsList, { provider: p.apiFormat, baseURL: p.baseURL });
      if (!r.ok) throw new Error(r.error ?? '拉取失败');
      const list = r.models ?? [];
      const existing = new Set(p.models.map((m) => m.modelId));
      const added = list.filter((m) => !existing.has(m.id)).map((m) => ({ uid: 'e_' + Math.random().toString(36).slice(2, 8), modelId: m.id, contextWindow: 1_000_000, enabled: false }));
      update(pid, { models: [...p.models, ...added] });
      setFetchNote('拉到 ' + added.length + ' 个新模型（未启用，按需打开）');
    } catch (err) {
      setFetchNote('拉取失败：' + String(err instanceof Error ? err.message : err));
    }
    setTimeout(() => setFetchNote(''), 4000);
  };`,
  '',
);
// 2) models-head 的按钮改发事件（详情面板自治执行）
rep(
  `          <button className="mode-btn" title="在线拉取该供应商可用模型清单" onClick={() => { if (selected && selected !== 'new') refreshModels(selected); }}>⟳ 拉取模型清单</button>`,
  `          <button className="mode-btn" title="在线拉取该供应商可用模型清单（选中供应商）" onClick={() => { window.dispatchEvent(new CustomEvent('loomery:fetch-models', { detail: selected })); }}>⟳ 拉取模型清单</button>`,
);
// 3) ProviderDetail 内：状态 + 实现 + 事件监听 + 表单按钮
rep(
  `  const [showKey, setShowKey] = useState(false);`,
  `  const [showKey, setShowKey] = useState(false);
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
  });`,
);
rep(
  `      <div className="models-list-head">
        <span>模型列表</span>
        <button className="mode-btn" onClick={addModel}>＋ 添加模型</button>
      </div>`,
  `      <div className="models-list-head">
        <span>模型列表</span>
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <button className="mode-btn" onClick={() => void refreshModels()}>⟳ 拉取清单</button>
          <button className="mode-btn" onClick={addModel}>＋ 添加模型</button>
        </span>
      </div>`,
);
fs.writeFileSync(p, s);
console.log('done');

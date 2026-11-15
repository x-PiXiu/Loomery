// 设置页 Agent 能力 + 数据统计 + 快捷键（谦卑视图：RPC/事件流，不触内核）
import { useEffect, useState, type ReactElement } from 'react';
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';
import { rpc } from '@loomery/adapter-ipc-bridge/renderer';
import type { MemoryFact } from '@loomery/domain';
import { Trash2 } from 'lucide-react';
import { useRuntime } from '../../stores/runtime';

/** 相对时间（条目元信息用） */
function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
  if (diff < 2_592_000_000) return Math.floor(diff / 86_400_000) + ' 天前';
  return new Date(ts).toLocaleDateString();
}

const KIND_LABEL: Record<MemoryFact['kind'], string> = { fact: '事实', convention: '约定', preference: '偏好' };
const SOURCE_LABEL: Record<MemoryFact['source'], string> = { 'user-pinned': '📌 钉住', extracted: '🧠 提炼' };

type MemoryFilter = 'all' | 'pinned' | 'extracted';

/** 任务记忆（自 TaskPanels 迁入设置壳）：卡片化布局 + 来源/类型徽章 + 筛选 + 全局记忆页签 */
export function MemorySettings(): ReactElement {
  const threads = useRuntime((s) => s.threads);
  const activeThreadId = useRuntime((s) => s.activeThreadId);
  const [scope, setScope] = useState<'task' | 'global'>('task');
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [globalFacts, setGlobalFacts] = useState<MemoryFact[]>([]);
  const [selected, setSelected] = useState(activeThreadId ?? threads[0]?.id ?? '');
  const [filter, setFilter] = useState<MemoryFilter>('all');
  useEffect(() => {
    if (scope === 'task' && selected) void rpc.call<MemoryFact[]>(RPC.memoryList, { threadId: selected }).then(setFacts).catch(() => undefined);
  }, [scope, selected]);
  // 全局记忆：跨任务注入的事实（用户偏好等）；环境快照类过时事实在此手动清理
  useEffect(() => {
    if (scope === 'global') void rpc.call<MemoryFact[]>(RPC.memoryGlobalList, {}).then(setGlobalFacts).catch(() => undefined);
  }, [scope]);
  // 任务列表晚于面板挂载到达时自动选中首个任务（否则 selected 空串→面板永远空）
  useEffect(() => {
    if (!selected && threads.length > 0) setSelected(threads[0]!.id);
  }, [threads, selected]);
  const unpin = async (factId: string): Promise<void> => {
    await rpc.call(RPC.memoryUnpin, { threadId: selected, factId }).catch(() => undefined);
    setFacts((prev) => prev.map((f) => (f.id === factId ? { ...f, status: 'superseded' } : f)));
  };
  // 删除提炼/钉住条目（同一机制：置 superseded 留痕，不物理抹）
  const [deleting, setDeleting] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const removeFact = async (factId: string): Promise<void> => {
    await rpc.call(RPC.memoryUnpin, { threadId: selected, factId }).catch(() => undefined);
    setDeleting(null);
    setFacts((prev) => prev.map((f) => (f.id === factId ? { ...f, status: 'superseded' } : f)));
  };
  const activeFacts = facts.filter((f) => f.status !== 'superseded');
  const pinnedCount = activeFacts.filter((f) => f.source === 'user-pinned').length;
  const sorted = [...activeFacts].sort((a, b) => {
    const pa = a.source === 'user-pinned' ? 0 : 1;
    const pb = b.source === 'user-pinned' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return b.createdAt - a.createdAt;
  });
  const shown = sorted.filter((f) => {
    if (filter === 'pinned') return f.source === 'user-pinned';
    if (filter === 'extracted') return f.source !== 'user-pinned';
    return true;
  });
  const selectedTitle = threads.find((t) => t.id === selected)?.title ?? '';
  const removeGlobalFact = async (fact: MemoryFact): Promise<void> => {
    await rpc.call(RPC.memoryGlobalDelete, { fact: { ...fact, status: 'superseded' } }).catch(() => undefined);
    setDeleting(null);
    setGlobalFacts((prev) => prev.map((f) => (f.id === fact.id ? { ...f, status: 'superseded' } : f)));
  };
  const globalActive = globalFacts.filter((f) => f.status !== 'superseded').sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div className="settings-pane memory-pane">
      <div className="settings-pane-title">记忆</div>
      <div className="memory-scope">
        <button className={scope === 'task' ? 'on' : ''} onClick={() => setScope('task')}>任务记忆</button>
        <button className={scope === 'global' ? 'on' : ''} onClick={() => setScope('global')}>全局记忆</button>
      </div>
      {scope === 'global' ? (
        <>
          <div className="notice">
            全局记忆 = 跨任务注入的用户偏好与领域事实（每个任务都会参考）。环境快照类（工作区路径/工具列表等会过时的）建议在此删除——应用已改为不再自动提炼它们。
          </div>
          <div className="memory-toolbar">
            <span className="memory-stats"><span className="stat-chip">🌐 全局 {globalActive.length}</span></span>
          </div>
          {globalActive.length === 0 ? (
            <div className="memory-empty">没有全局记忆。对 agent 说「记住…」（跨任务的偏好/约定）即可产生。</div>
          ) : (
            <div className="memory-facts">
              {globalActive.map((f) => {
                const expanded = expandedId === f.id;
                return (
                  <div key={f.id} className={`memory-fact-card ${expanded ? 'expanded' : ''}`}>
                    <span className="memory-fact-icon">🌐</span>
                    <span className="memory-fact-content" title={f.content + '\n创建于 ' + new Date(f.createdAt).toLocaleString()}>{f.content}</span>
                    <span className="memory-fact-meta">
                      <span className={`kind-badge ${f.kind}`}>{KIND_LABEL[f.kind]}</span>
                      <span className="pin-badge">{SOURCE_LABEL[f.source]}</span>
                      <span>{relTime(f.createdAt)}</span>
                    </span>
                    <span className="fact-actions">
                      <button className="mode-btn" onClick={() => setExpandedId((v) => (v === f.id ? null : f.id))}>
                        {expanded ? '收起' : '详情'}
                      </button>
                      <button
                        className={`mode-btn ${deleting === f.id ? 'danger-active' : ''}`}
                        title={deleting === f.id ? '再次点击确认删除' : '删除（置为已失效，留痕可追溯；不再注入任何任务）'}
                        onClick={() => (deleting === f.id ? void removeGlobalFact(f) : setDeleting(f.id))}
                        onBlur={() => setDeleting(null)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
      <>
      <div className="notice">
        每轮自动注入的钉住/提炼事实（任务级，事件溯源）。📌 钉住的永不裁剪；完整简报在聊天区 ⋯ 菜单。
      </div>
      <div className="memory-toolbar">
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {threads.length === 0 ? <option>（暂无任务）</option> : null}
          {threads.map((t) => (
            <option key={t.id} value={t.id}>{t.title}</option>
          ))}
        </select>
        <span className="memory-stats">
          <span className="stat-chip">📌 钉住 {pinnedCount}</span>
          <span className="stat-chip">🧠 提炼 {activeFacts.length - pinnedCount}</span>
        </span>
        <span className="memory-filter">
          {(['all', 'pinned', 'extracted'] as const).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? '全部' : f === 'pinned' ? '📌 钉住' : '提炼'}
            </button>
          ))}
        </span>
      </div>
      {selectedTitle ? <div className="memory-task-line">任务：{selectedTitle}</div> : null}
      {shown.length === 0 ? (
        <div className="memory-empty">
          {filter === 'pinned' ? '该任务没有钉住的记忆——对 agent 说"记住…"即可钉住。' : '该任务暂无此类记忆。'}
        </div>
      ) : (
        <div className="memory-facts">
          {shown.map((f) => {
            const pinned = f.source === 'user-pinned';
            const expanded = expandedId === f.id;
            return (
              <div key={f.id} className={`memory-fact-card ${pinned ? 'pinned' : ''} ${expanded ? 'expanded' : ''}`}>
                <span className="memory-fact-icon">{pinned ? '📌' : '🧠'}</span>
                <span className="memory-fact-content" title={f.content + '\n创建于 ' + new Date(f.createdAt).toLocaleString() + (f.turnId ? '\n来源轮次：' + f.turnId : '')}>{f.content}</span>
                <span className="memory-fact-meta">
                  <span className={`kind-badge ${f.kind}`}>{KIND_LABEL[f.kind]}</span>
                  <span className="pin-badge">{SOURCE_LABEL[f.source]}</span>
                  <span>{relTime(f.createdAt)}</span>
                </span>
                <span className="fact-actions">
                  {pinned ? (
                    <button className="mode-btn" onClick={() => void unpin(f.id)}>取消钉住</button>
                  ) : null}
                  <button className="mode-btn" onClick={() => setExpandedId((v) => (v === f.id ? null : f.id))}>
                    {expanded ? '收起' : '详情'}
                  </button>
                  <button
                    className={`mode-btn ${deleting === f.id ? 'danger-active' : ''}`}
                    title={deleting === f.id ? '再次点击确认删除' : '删除（置为已失效，留痕可追溯）'}
                    onClick={() => (deleting === f.id ? void removeFact(f.id) : setDeleting(f.id))}
                    onBlur={() => setDeleting(null)}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
      </>
      )}
    </div>
  );
}

/** 键盘快捷键：查看 + 覆盖自定义（localStorage keymap；消费者读 loomery.keymap.<id>） */
export function ShortcutsSettings(): ReactElement {
  const [overrides, setOverrides] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('loomery.keymap') ?? '{}') as Record<string, string>; } catch { return {}; }
  });
  const [capturing, setCapturing] = useState<string | null>(null);
  const SHORTCUTS: { id: string; label: string; def: string }[] = [
    { id: 'new', label: '新建项目', def: 'Ctrl+N' },
    { id: 'approval.accept', label: '接受审批', def: 'Ctrl+Enter' },
    { id: 'approval.reject', label: '拒绝/关闭', def: 'Esc' },
    { id: 'file.save', label: '保存当前文件', def: 'Ctrl+S' },
  ];
  const current = (sc: { id: string; def: string }): string => overrides[sc.id] ?? sc.def;
  const capture = (id: string): void => {
    setCapturing(id);
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      const parts = [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.shiftKey ? 'Shift' : '', e.altKey ? 'Alt' : '', e.key === ' ' ? 'Space' : e.key].filter(Boolean);
      const combo = parts.join('+');
      const next = { ...overrides, [id]: combo };
      setOverrides(next);
      localStorage.setItem('loomery.keymap', JSON.stringify(next));
      setCapturing(null);
      window.removeEventListener('keydown', onKey, true);
    };
    window.addEventListener('keydown', onKey, true);
  };
  return (
    <div className="settings-pane">
      <div className="settings-pane-title">键盘快捷键</div>
      <div className="notice">点击"自定义"后按下新组合。当前消费者按 localStorage loomery.keymap.* 读取（新建项目/审批快捷键已接入，其余陆续接入）。</div>
      <div className="datadir-rows">
        {SHORTCUTS.map((sc) => (
          <div key={sc.id} className="datadir-row">
            <span className="k">{sc.label}</span>
            <span style={{ flex: 1 }} />
            <kbd>{current(sc)}</kbd>
            {capturing === sc.id ? (
              <span className="test-result err">按键中…（Esc 取消）</span>
            ) : (
              <button className="mode-btn" onClick={() => capture(sc.id)}>自定义</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

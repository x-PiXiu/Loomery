// Composer（单卡片）：autosize 输入 + 预设菜单（四合一）+ 容量圈 + 模型菜单 + 发送
import { Children, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ArrowUp, ChevronDown, Check, Plus, CircleHelp, Copy, CopyPlus, Eraser, File as FileIcon, FileCode2, FileText, FolderClosed, FolderOpen, Image as ImageIcon, MoreHorizontal, PanelRight, Pencil, Pin, ThumbsDown, ThumbsUp, Trash2, Undo2, Upload, X, AppWindow, Settings2, SquareTerminal } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';
import { rpc } from '@loomery/adapter-ipc-bridge/renderer';
import type { AgentMode, AppConfig, SkillManifest } from '@loomery/domain';
import { balanceFences } from '../../utils/markdown';
import type { ThreadRow } from '../../stores/runtime';
import { runtime, useRuntime, type ApprovalItem, type ChatItem, type MessageItem, type ToolItem } from '../../stores/runtime';
import { getComposerDraft, openInEditor, openInDiff, registerComposerInserter, registerComposerReplacer, replaceComposerText, resolveOriginalContent, setComposerDraft, unregisterComposerInserter, unregisterComposerReplacer } from '../../gateway/editorBus';
import { SidebarNavCluster } from '../sidebar/Sidebar';
import { TerminalPanel, TERMINAL_HEIGHT_KEY, readStoredHeight } from './TerminalPanel';
import { ActivityCapsule } from './ActivityCapsule';
import { applyHunks } from '@loomery/domain/rules/diff';
import type { DiffProposal } from '@loomery/domain';
import { WinControls } from '../common/WinControls';
import { ArtifactsPanel, BriefPanel, MemoryPanel } from './TaskPanels';
import { BrandIcon } from '../settings/brand-icons';
import { PROVIDER_PRESETS } from '../settings/presets';
import { ChevronRight } from 'lucide-react';

const MODES: { value: AgentMode; label: string }[] = [
  { value: 'plan', label: '计划' },
  { value: 'edit', label: '编辑' },
  { value: 'explain', label: '解释' },
];

/** 绝对路径 → loomery-file:// 链接，点击进编辑器 */
function linkifyFilePaths(text: string): string {
  return text.replace(/([A-Za-z]:\\[^\s`"']+)/g, (m) => {
    const name = m.split('\\').pop() ?? m;
    return `[${name}](loomery-file://${encodeURIComponent(m)})`;
  });
}

/** 从提案打开 DiffPane：原始=快照/当前文件，修改=applyHunks（domain 纯规则） */
async function openProposalDiff(turnId: string | undefined, proposal: DiffProposal): Promise<void> {
  try {
    const original = await resolveOriginalContent(turnId, proposal.path);
    if (original === null) {
      console.error('[drag-log][diff] original resolve failed for ' + proposal.path);
      return;
    }
    const modified = applyHunks(original, proposal.hunks);
    openInDiff(proposal.path, original, modified);
    console.log('[drag-log][diff] opened for ' + proposal.path);
  } catch (err) {
    console.error('[drag-log][diff] failed: ' + String(err));
  }
}

function copyText(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => undefined);
}

// ---------- 总结卡（每文件行）辅助 ----------
function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
}

/** 目录段展示：工作区内则显示相对路径目录，否则显示完整目录 */
function dirOf(p: string, wsRoot?: string): string {
  const segs = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  const dir = segs.slice(0, -1).join('/');
  if (wsRoot && (p === wsRoot || p.startsWith(wsRoot))) {
    const rel = p.slice(wsRoot.length).replace(/^[\\/]+/, '');
    const relDir = rel.split(/[\\/]/).slice(0, -1).join('/');
    return relDir ? `${relDir}/` : '';
  }
  return dir ? `${dir}/` : '';
}

function fileIconOf(path: string): ReactElement {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext)) return <ImageIcon size={13} />;
  if (['md', 'txt'].includes(ext)) return <FileText size={13} />;
  if (['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'go', 'rs', 'css', 'html', 'yml', 'yaml', 'mjs', 'cjs'].includes(ext)) return <FileCode2 size={13} />;
  return <FileIcon size={13} />;
}

/** 单文件审查：有提案走提案 hunks；无提案（自主模式写入）用 checkpoint 快照对照当前文件 */
async function reviewTurnFile(turnId: string | undefined, path: string, proposal: DiffProposal | undefined): Promise<void> {
  if (proposal) {
    await openProposalDiff(turnId, proposal);
    return;
  }
  try {
    const res = await rpc.call<{ content?: string; binary?: boolean }>(RPC.fsReadFile, { path });
    if (res.binary) {
      await openInEditor(path);
      return;
    }
    let original: string | null = null;
    if (turnId) {
      try {
        const snap = await rpc.call<string | null>(RPC.checkpointRead, { turnId, path });
        if (typeof snap === 'string') original = snap;
      } catch { /* 无快照 */ }
    }
    if (original === null) {
      await openInEditor(path); // 没有可对照的快照：退化为直接打开
      return;
    }
    openInDiff(path, original, res.content ?? '');
  } catch { /* ignore */ }
}

// ---------- 预设（四合一：模式 × 审批） ----------
type PresetId = 'plan' | 'confirm' | 'auto' | 'full' | 'explain';
const PRESETS: { id: PresetId; icon: string; title: string; desc: string; apply: (c: AppConfig) => { mode: AgentMode; approval: AppConfig['approval'] } }[] = [
  { id: 'plan', icon: '💡', title: '计划模式', desc: '编辑前先出计划（只读）。', apply: () => ({ mode: 'plan', approval: { read: 'auto', write: 'ask', execute: 'deny' } }) },
  { id: 'confirm', icon: '✋', title: '变更前确认', desc: '改文件前先问我。', apply: () => ({ mode: 'edit', approval: { read: 'auto', write: 'ask', execute: 'deny' } }) },
  { id: 'auto', icon: '🛡', title: '自主模式', desc: '写操作自动执行，有风险时问。', apply: () => ({ mode: 'edit', approval: { read: 'auto', write: 'auto', execute: 'deny' } }) },
  { id: 'full', icon: '⚠️', title: '完全访问', desc: '减少确认次数。', apply: () => ({ mode: 'edit', approval: { read: 'auto', write: 'auto', execute: 'auto' } }) },
  { id: 'explain', icon: '🔮', title: '解释模式', desc: '只读解释代码，不做修改。', apply: () => ({ mode: 'explain', approval: { read: 'auto', write: 'ask', execute: 'deny' } }) },
]

function presetOf(config: AppConfig | null): { id: PresetId; mode: AgentMode } {
  // 全局记忆优先（决策 A）；无记忆时从 approval 配置推导，缺省"变更前确认"
  const saved = localStorage.getItem('loomery.preset') as PresetId | null;
  if (saved) {
    const def = PRESETS.find((p) => p.id === saved);
    if (def) return { id: saved, mode: def.apply(config ?? { approval: { read: 'auto', write: 'ask', execute: 'deny' } } as AppConfig).mode };
  }
  if (!config) return { id: 'confirm', mode: 'edit' };
  if (config.approval.write === 'ask') return { id: 'confirm', mode: 'edit' };
  return { id: config.approval.execute === 'auto' ? 'full' : 'auto', mode: 'edit' };
}

// ---------- 容量圈 ----------
function fmtTokens(n: number): string {
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  if (n > 0) return String(n);
  return '0';
}

function ContextRing({ threadId, busy }: { threadId?: string | null; busy: boolean }): ReactElement {
  const lastInputTokens = useRuntime((s) => s.lastInputTokens);
  const config = useRuntime((s) => s.config);
  const [open, setOpen] = useState(false);
  const [compactNote, setCompactNote] = useState('');
  const [compacting, setCompacting] = useState(false);
  const events = useRuntime((s) => s.events);
  const last = [...events].reverse().find((e) => e.type === 'contextAssembled');
  const breakdown = last && last.type === 'contextAssembled' ? (last.payload.breakdown ?? { messages: 0, system: 0, tools: 0, other: 0 }) : { messages: 0, system: 0, tools: 0, other: 0 };
  const used = lastInputTokens;
  const activeEntry = config?.models.entries?.find((e) => e.id === config.models.activeId);
  const window_ = activeEntry?.contextWindow ?? config?.models.main.contextWindow ?? 1_000_000;
  const ratio = Math.min(1, used / window_);
  const warn = ratio > 0.8;
  const C = 2 * Math.PI * 8;
  const rows = [
    { label: '消息', value: breakdown.messages, color: 'var(--accent)' },
    { label: '系统提示词', value: breakdown.system, color: '#8b5cf6' },
    { label: '系统工具', value: breakdown.tools, color: '#0ea5e9' },
    { label: '其他', value: breakdown.other, color: 'var(--text-faint)' },
  ].filter((r) => r.value > 0);
  // docs/16：明细是启发式估算（对厂商精确值系统性偏高 ~15%，曾出现"消息 48.3万 > 已用 42.6万"的自相矛盾）
  // 修法：用厂商精确总量校准明细到同一口径——校准后明细绝对值之和 = 头部"已用"，占比在明细内自洽；
  // "≈" 前缀保留估算性质标记（精确总量才是权威）
  const estTotal = Math.max(1, rows.reduce((acc, r) => acc + r.value, 0));
  const calib = used > 0 ? used / estTotal : 1;

  return (
    <span className="ctx-ring-wrap">
      <span
        className={`ctx-ring ${warn ? 'warn' : ''}`}
        title={`上下文 ${fmtTokens(used)} / ${fmtTokens(window_)}（${Math.round(ratio * 100)}%）`}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="18" height="18" viewBox="0 0 20 20">
          <circle cx="10" cy="10" r="8" fill="none" stroke="var(--border-strong)" strokeWidth="2.5" />
          <circle
            cx="10" cy="10" r="8" fill="none"
            stroke={warn ? 'var(--err)' : 'var(--accent)'}
            strokeWidth="2.5" strokeLinecap="round"
            strokeDasharray={`${C * ratio} ${C}`}
            transform="rotate(-90 10 10)"
          />
        </svg>
      </span>
      {open ? (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="dropdown ctx-panel">
            <div className="ctx-head">
              <span>上下文容量</span>
              <span className="ctx-total">{fmtTokens(used)}/{fmtTokens(window_)}（{Math.round(ratio * 100)}%）</span>
            </div>
            <div className="ctx-bar"><span style={{ width: `${ratio * 100}%` }} /></div>
            {rows.map((r) => (
              <div key={r.label} className="ctx-row">
                <span className="ctx-dot" style={{ background: r.color }} />
                <span className="ctx-label">{r.label}</span>
                <span className="ctx-val">≈ {fmtTokens(Math.round(r.value * calib))} · {Math.max(1, Math.round((r.value / estTotal) * 100))}%</span>
              </div>
            ))}
            {rows.length === 0 ? <div className="dd-empty">发起一轮对话后显示占用</div> : null}
            {compactNote ? <div className="dd-empty ctx-compact-note">{compactNote}</div> : null}
            <div className="dd-sep" />
            <button
              disabled={busy || !threadId || compacting}
              onClick={() => {
                if (!threadId || compacting) return;
                setCompacting(true);
                setCompactNote('压缩中…');
                void rpc.call<{ ok: boolean; tokensSaved?: number; reason?: string }>(RPC.threadCompact, { threadId })
                  .then((r) => {
                    if (r.ok) {
                      setCompactNote(r.tokensSaved != null ? `已压缩，节省 ${fmtTokens(r.tokensSaved)} tokens` : '已压缩');
                    } else {
                      setCompactNote(`无法压缩：${r.reason ?? '未知原因'}`);
                    }
                  })
                  .catch((err: unknown) => setCompactNote(`压缩失败：${String(err instanceof Error ? err.message : err).slice(0, 120)}`))
                  .finally(() => setCompacting(false));
              }}
            >
              <Eraser size={13} /> {compacting ? '压缩中…' : '立即压缩历史'}
            </button>
            <button onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('loomery:open-settings')); }}>
              <Settings2 size={13} /> 设置模型上下文窗口
            </button>
          </div>
        </>
      ) : null}
    </span>
  );
}

// ---------- 模型面板（ZCode 式：供应商头 + 模型清单 + 供应商切换 + 管理模型） ----------
type ProviderT = NonNullable<AppConfig['models']>['providers'] extends (infer T)[] | undefined ? T : never;
type ProviderModelT = ProviderT['models'] extends (infer M)[] ? M : never;

function fmtWindow(v?: number): string {
  if (!v) return '?';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1) + 'M';
  if (v >= 1000) return Math.round(v / 1000) + 'K';
  return String(v);
}

function ModelMenu(): ReactElement {
  const config = useRuntime((s) => s.config);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'models' | 'providers'>('models');
  const providers = (config?.models.providers ?? []) as ProviderT[];
  const activeId = config?.models.activeId;
  // 活动模型归属的供应商（entry id 即 provider.models[].uid）
  const activeProvider = providers.find((p) => p.models.some((m) => m.uid === activeId)) ?? null;
  const current = activeId ? providers.flatMap((p) => p.models).find((m) => m.uid === activeId)?.modelId ?? '' : config?.models.main.modelId ?? '';

  const applyModel = async (provider: ProviderT, model: ProviderModelT): Promise<void> => {
    if (!config || model.uid === activeId) return;
    // main = 供应商连接信息 + 模型字段（内核按 main 直连）
    await rpc.call(RPC.configSave, {
      models: {
        ...config.models,
        activeId: model.uid,
        main: { provider: provider.apiFormat, modelId: model.modelId, baseURL: provider.baseURL, apiKeyRef: provider.apiKeyRef, contextWindow: model.contextWindow },
      },
    });
    runtime.set({ config: await rpc.call<AppConfig>(RPC.configGet) });
    setOpen(false);
  };

  const iconFor = (p: ProviderT): ReactElement => {
    const preset = PROVIDER_PRESETS.find((x) => x.id === p.preset);
    return <BrandIcon id={preset?.iconId ?? 'custom'} size={18} />;
  };

  const openSettings = (): void => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent('loomery:open-settings', { detail: 'models' }));
  };

  const viewModels = (activeProvider?.models ?? []).filter((m) => m.enabled !== false).map((m) => (
    <button key={m.uid} className="mm-row" onClick={() => void applyModel(activeProvider!, m)}>
      <span className="mm-name">{m.displayName ?? m.modelId}</span>
      <span className="mm-badge">{fmtWindow(m.contextWindow)}</span>
      {m.uid === activeId ? <Check size={14} className="dd-check" /> : null}
    </button>
  ));

  const viewProviders = providers.map((p) => {
    const count = p.models.filter((m) => m.enabled !== false).length;
    const isActive = activeProvider?.id === p.id;
    return (
      <button
        key={p.id}
        className="mm-row"
        onClick={() => {
          // 切供应商 = 切到其首个启用模型（ZCode 语义：选计划即切模型）
          const first = p.models.find((m) => m.enabled !== false);
          if (first) void applyModel(p, first);
          setView('models');
        }}
      >
        {iconFor(p)}
        <span className="mm-name">{p.name}</span>
        <span className="mm-badge">{count} 模型</span>
        {isActive ? <Check size={14} className="dd-check" /> : null}
      </button>
    );
  });

  return (
    <span className="model-menu-wrap">
      <button className="model-btn" onClick={() => { setOpen((v) => !v); setView('models'); }} title="切换模型">
        {current || '未配置模型'} <ChevronDown size={13} />
      </button>
      {open ? (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="dropdown model-panel">
            {providers.length === 0 ? (
              <button className="mm-row" onClick={openSettings}>
                <Settings2 size={14} /> 未配置模型 · 去设置
              </button>
            ) : view === 'models' && activeProvider ? (
              <>
                <button className="mm-head" onClick={() => setView('providers')} title="切换供应商">
                  {iconFor(activeProvider)}
                  <span className="mm-name">{activeProvider.name}</span>
                  <span className="mm-badge">{viewModels.length} 模型</span>
                  <ChevronRight size={14} className="mm-go" />
                </button>
                <div className="mm-label">模型</div>
                {viewModels}
              </>
            ) : (
              <>
                <div className="mm-label">供应商</div>
                {viewProviders}
              </>
            )}
            <div className="dd-sep" />
            <button className="mm-row" onClick={openSettings}>
              <Settings2 size={14} /> 管理模型
            </button>
          </div>
        </>
      ) : null}
    </span>
  );
}

// ---------- 工具卡 / 审批卡 / 消息 ----------
async function decideApproval(approvalId: string, kind: 'approved' | 'rejected', always = false): Promise<void> {
  await rpc.call(RPC.approvalDecide, { approvalId, decision: { kind, ...(always ? { always: true } : {}) } });
}

/** 审批卡正文：diff 类显示 diff 文本；命令类显示"将执行命令"块（含 cwd）；其余显示参数摘要——不再出现空洞的"（无 diff 预览）" */
function ApprovalBody({ approval }: { approval: ApprovalItem }): ReactElement {
  const input = approval.input as Record<string, unknown> | undefined;
  if (approval.diffText) return <pre>{approval.diffText}</pre>;
  const cmd = typeof input?.command === 'string' ? input.command : undefined;
  if (cmd) {
    return (
      <div className="approval-cmd">
        <div className="approval-cmd-label">将执行命令{typeof input?.cwd === 'string' ? ` · cwd: ${input.cwd}` : ''}</div>
        <pre>{cmd}</pre>
      </div>
    );
  }
  if (input && Object.keys(input).length > 0) {
    return <pre>{JSON.stringify(input, null, 2).slice(0, 900)}</pre>;
  }
  return <div className="approval-none">（该操作无预览内容）</div>;
}

function ToolCard({ item, approval }: { item: ToolItem; approval?: ApprovalItem }): ReactElement {
  const meta = TOOL_META[item.name] ?? { icon: '🛠', label: item.name };
  const argText = argsSummary(item.name, item.args);
  const filePath = extractPath(item.name, item.args);
  const [open, setOpen] = useState(false);
  const [apOpen, setApOpen] = useState(false); // 审批内容默认收起，点下拉箭头展开
  const statusLabel: Record<string, string> = {
    requested: '执行中',
    'awaiting-approval': '待审批',
    running: '执行中',
    done: item.durationMs !== undefined ? `完成 · ${item.durationMs}ms` : '完成',
    failed: '失败',
    rejected: '已拒绝',
  };
  const expandable = Boolean(item.preview);
  const hasDiff = item.proposal !== undefined;
  return (
    <div
      className={`tool-line ${item.status} ${filePath ? 'has-file' : ''} ${hasDiff ? 'has-diff' : ''}`}
      title={approval ? (apOpen ? '收起审批内容' : '展开审批内容') : hasDiff ? '查看本次修改的 diff' : filePath ? `在编辑器中打开 ${filePath}` : undefined}
      onClick={() => {
        // 审批优先：整行点击 = 开合审批内容（12px 小箭头难点中，扩大命中区到整行）
        if (approval) { setApOpen((v) => !v); return; }
        // 写工具行：点击直接看本次修改的 diff（行尾红删绿增统计）
        if (hasDiff) { void openProposalDiff(item.turnId, item.proposal!); return; }
        if (filePath) { void openInEditor(filePath); return; }
        if (expandable) setOpen((v) => !v);
      }}
    >
      <span className="tool-line-head">
        <span className="tool-line-icon">{meta.icon}</span>
        <span className="tool-line-label">{meta.label}</span>
        {argText ? <span className="tool-line-arg">{argText}</span> : null}
        {approval ? (
          <span
            className={`tool-ap-wrap${apOpen ? ' open' : ''}`}
            title={apOpen ? '收起审批内容' : '展开审批内容'}
            onClick={(ev) => { ev.stopPropagation(); setApOpen((v) => !v); }}
          >
            <ChevronDown size={12} />
          </span>
        ) : null}
        <span className={`status ${item.status}`}>
          {item.status === 'done' && item.added !== undefined ? (
            <span className="ts-stats"><b className="added">+{item.added}</b> <b className="removed">−{item.removed}</b></span>
          ) : null}
          {statusLabel[item.status] ?? item.status}
        </span>
      </span>
      {(() => {
        const cmd = toolCommand(item.name, item.args);
        // 2026-11-13 用户反馈"执行时看不到执行的命令"：命令块常显（审批前/执行中/完成后都在），
        // 点击行仍可展开看输出（item.preview）；不再依赖 46 字截断的行头参数摘要
        return cmd ? <pre className="tool-cmd">{cmd}</pre> : null;
      })()}
      {open && item.preview ? <pre>{item.preview}</pre> : null}
      {item.images && item.images.length > 0 ? (
        <div className="tool-images">
          {item.images.map((img, k) => (
            <img
              key={k}
              className="tool-thumb"
              src={`data:${img.mime};base64,${img.base64}`}
              alt={`截图 ${k + 1}`}
              title="点击放大查看"
              onClick={() => window.dispatchEvent(new CustomEvent('loomery:lightbox-image', { detail: { name: `截图 ${k + 1}`, mime: img.mime, base64: img.base64 } }))}
            />
          ))}
        </div>
      ) : null}
      {approval ? (
        <div className={`tool-approval${apOpen ? '' : ' collapsed'}`} onClick={(ev) => ev.stopPropagation()}>
          <div className="card approval">
            {approval.resolved !== null ? (
              <div className={`approval-resolved ${approval.resolved === 'approved' || approval.resolved === 'modified' ? 'ok' : 'err'}`}>
                {approval.resolved === 'approved' ? '✓ 已批准——命令执行中/已完成' : approval.resolved === 'modified' ? '已修改执行' : '✗ 已拒绝'}
              </div>
            ) : null}
            <ApprovalBody approval={approval} />
            {approval.proposal ? (
              <div className="actions">
                <button onClick={() => void openProposalDiff(approval.turnId, approval.proposal!)}>查看完整 diff</button>
              </div>
            ) : null}
            {approval.resolved === null ? (
              <div className="actions">
                <button className="primary" onClick={() => void decideApproval(approval.approvalId, 'approved')}>接受 (Ctrl+Enter)</button>
                <button onClick={() => void decideApproval(approval.approvalId, 'approved', true)} title="本任务内同类操作不再询问（危险命令除外）">本任务总是允许</button>
                <button onClick={() => void decideApproval(approval.approvalId, 'rejected')}>拒绝 (Esc)</button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ApprovalCard({ item }: { item: ApprovalItem }): ReactElement {
  const decide = async (kind: 'approved' | 'rejected', always = false): Promise<void> => {
    await rpc.call(RPC.approvalDecide, { approvalId: item.approvalId, decision: { kind, ...(always ? { always: true } : {}) } });
  };
  return (
    <div className="card approval">
      <div className="card-head">
        <span>⏳ 审批：{item.toolName || '写操作'}</span>
        <span className={`status ${item.resolved === null ? 'awaiting-approval' : item.resolved === 'approved' || item.resolved === 'modified' ? 'done' : 'rejected'}`}>
          {item.resolved === null ? '等待你的决定' : item.resolved === 'approved' ? '已批准' : item.resolved === 'modified' ? '已修改' : '已拒绝'}
        </span>
      </div>
      <ApprovalBody approval={item} />
      {item.proposal ? (
        <div className="actions">
          <button onClick={() => void openProposalDiff(item.turnId, item.proposal!)}>查看完整 diff</button>
        </div>
      ) : null}
      {item.resolved === null ? (
        <div className="actions">
          <button className="primary" onClick={() => void decide('approved')}>接受 (Ctrl+Enter)</button>
          <button onClick={() => void decide('approved', true)} title="本任务内同类操作不再询问（危险命令除外）">本任务总是允许</button>
          <button onClick={() => void decide('rejected')}>拒绝 (Esc)</button>
        </div>
      ) : null}
    </div>
  );
}

function UserPill({ text, images }: { text: string; images?: { mime: string; base64: string }[] }): ReactElement {
  return (
    <div className="msg-user-pill-wrap">
      <div className={`msg-user-pill${images && images.length > 0 ? ' with-images' : ''}`}>
        {images && images.length > 0 ? (
          <div className="pill-images">
            {images.map((img, k) => (
              <img
                key={k}
                className="pill-image"
                src={`data:${img.mime};base64,${img.base64}`}
                alt={`附件 ${k + 1}`}
                title="点击放大"
                onClick={() => window.dispatchEvent(new CustomEvent('loomery:lightbox-image', { detail: { name: `附件 ${k + 1}`, mime: img.mime, base64: img.base64 } }))}
              />
            ))}
          </div>
        ) : null}
        <span className="pill-text">{text}</span>
      </div>
      {/* 复制/重新编辑悬浮在气泡外右下角（不占气泡内空间） */}
      <span className="pill-actions">
        <span className="tool-wrap" title="复制"><Copy size={13} className="tool-icon" onClick={() => copyText(text)} /></span>
        <span className="tool-wrap" title="重新编辑（修改后再发送）"><Pencil size={13} className="tool-icon" onClick={() => replaceComposerText(text, images)} /></span>
      </span>
    </div>
  );
}

/** 末段总结：取最后一个非空段落（AI 回复常以结论段收尾，复制按钮默认只复制它） */
function summaryText(t: string): string {
  const blocks = t.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
  return blocks[blocks.length - 1] ?? t;
}

function AssistantMessage({ text, reasoning, reasoningMs }: { text: string; reasoning?: string; reasoningMs?: number }): ReactElement {
  return (
    <div className="msg-assistant">
      {reasoning ? <ReasoningBlock text={reasoning} ms={reasoningMs} /> : null}
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith('loomery-file://')) {
              const path = decodeURIComponent(href.slice('loomery-file://'.length));
              // 2026-11-13：聊天里的图片类文件 → 遮罩弹窗预览（不占编辑区标签）；其余文件 → 编辑区
              return (
                <a
                  className="file-link"
                  onClick={() => {
                    if (isImagePath(path)) window.dispatchEvent(new CustomEvent('loomery:lightbox-image', { detail: { path } }));
                    else void openInEditor(path);
                  }}
                >
                  {children}
                </a>
              );
            }
            return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
          },
          // 代码块壳：从 pre>code 提取语言与原文（折叠/复制用），内部结构不动（样式仍走 .msg-assistant pre）
          pre: ({ children }) => {
            const child = Children.toArray(children)[0] as { props?: { className?: string; children?: unknown } } | undefined;
            const cls = child?.props?.className ?? '';
            const lang = /language-([\w+-]+)/.exec(cls)?.[1] ?? '';
            const rawParts = child?.props?.children;
            const raw = Array.isArray(rawParts) ? rawParts.join('') : String(rawParts ?? '');
            const trimmed = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
            return <CodeShell lang={lang} raw={trimmed}>{children as ReactElement}</CodeShell>;
          },
          // loose list 结构（li 与 p 之间的空白文本节点）在 pre-wrap 容器里渲染成可见空行
          //（实证：序号独占一行、条目间大空隙）——过滤直属空白子节点
          li: ({ children, ...props }) => (
            <li {...props}>
              {Children.toArray(children).filter((c) => !(typeof c === 'string' && c.trim() === ''))}
            </li>
          ),
          blockquote: ({ children, ...props }) => (
            <blockquote {...props}>
              {Children.toArray(children).filter((c) => !(typeof c === 'string' && c.trim() === ''))}
            </blockquote>
          ),
        }}
      >
        {balanceFences(linkifyFilePaths(text))}
      </Markdown>
    </div>
  );
}

/** 代码块壳：语言徽标 + 复制 + 长代码折叠（对齐 ZCode 工具卡体验；streaming 更新时 state 保持） */
function CodeShell({ lang, raw, children }: { lang: string; raw: string; children: ReactElement }): ReactElement {
  const [copied, setCopied] = useState(false);
  const lineCount = raw.length > 0 ? raw.split('\n').length : 0;
  const collapsible = lineCount > 28;
  const [expanded, setExpanded] = useState(false);
  const doCopy = (): void => {
    copyText(raw);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="code-shell">
      <div className="code-shell-bar">
        <span className="code-lang">{lang || 'text'}</span>
        <span className="code-shell-tools">
          <span className="tool-wrap" title="复制代码">{copied ? <Check size={12} className="tool-icon ok" /> : <Copy size={12} className="tool-icon" onClick={doCopy} />}</span>
        </span>
      </div>
      <div className={collapsible && !expanded ? 'code-folded' : ''}>
        {children}
        {collapsible && !expanded ? (
          <button className="code-expand" onClick={() => setExpanded(true)}>展开全部（{lineCount} 行）</button>
        ) : null}
      </div>
    </div>
  );
}

function ReasoningBlock({ text, ms }: { text: string; ms?: number }): ReactElement {
  const secs = ms !== undefined && ms > 0 ? Math.max(1, Math.round(ms / 1000)) : undefined;
  return (
    <details className="reasoning-block">
      <summary>🧠 思考{secs ? ` · 持续了 ${secs} 秒` : ''}</summary>
      <div className="reasoning-body">{text}</div>
    </details>
  );
}

const TOOL_META: Record<string, { icon: string; label: string }> = {
  read_file: { icon: '🔍', label: '查阅' },
  search_text: { icon: '🔍', label: '搜索' },
  list_dir: { icon: '📁', label: '目录' },
  write_file: { icon: '✏️', label: '写入' },
  apply_diff: { icon: '✏️', label: '编辑' },
  run_command: { icon: '⌨️', label: '执行命令' },
  git_status: { icon: '🌿', label: 'git 状态' },
  git_diff: { icon: '🌿', label: 'git 差异' },
  git_log: { icon: '🌿', label: 'git 历史' },
  git_commit: { icon: '🌿', label: 'git 提交' },
  plan_write: { icon: '📋', label: '更新计划' },
  preview_control: { icon: '👁️', label: '控制预览' },
  task_complete: { icon: '🏁', label: '声明完成' },
  editor_diagnostics: { icon: '🔬', label: '查诊断' },
  browser_control: { icon: '🌐', label: '控制浏览器' },
  delete_file: { icon: '🗑️', label: '删除文件' },
  process_list: { icon: '🧾', label: '后台进程' },
  memory_pin: { icon: '📌', label: '记住要点' },
  brief_write: { icon: '📝', label: '写简报' },
  read_artifact: { icon: '📦', label: '读产物' },
  read_skill: { icon: '📚', label: '读技能' },
};

function argsSummary(name: string, argsJson?: string): string {
  if (!argsJson) return '';
  try {
    const a = JSON.parse(argsJson) as Record<string, unknown>;
    const path = typeof a.path === 'string' ? a.path : '';
    const file = path.split(/[\/]/).pop() ?? '';
    if (name === 'search_text' && typeof a.pattern === 'string') return `“${a.pattern.slice(0, 24)}”`;
    if (name === 'run_command' && typeof a.command === 'string') {
      const c = a.command.replace(/\s+/g, ' ').trim();
      return c.length > 46 ? c.slice(0, 46) + '…' : c;
    }
    if (name === 'preview_control' && typeof a.action === 'string') return `${a.action}${file ? ' · ' + file : ''}`;
    if (name === 'plan_write' && Array.isArray(a.steps)) return `${a.steps.length} 步`;
    if (name === 'task_complete' && typeof a.summary === 'string') {
      const t = a.summary.replace(/\s+/g, ' ').trim();
      return t.length > 24 ? t.slice(0, 24) + '…' : t;
    }
    if (name.startsWith('git_') && typeof a.path === 'string' && file) return file;
    if (file) return file;
    return '';
  } catch { return ''; }
}

/** 从工具参数提取命令全文（run_command：命令块常显在工具行下，不再藏进展开区/审批卡） */
function toolCommand(name: string, argsJson?: string): string | null {
  if (name !== 'run_command' || !argsJson) return null;
  try {
    const a = JSON.parse(argsJson) as Record<string, unknown>;
    return typeof a.command === 'string' && a.command.trim().length > 0 ? a.command.trim() : null;
  } catch { return null; }
}

/** docs/16 P2 视频：抽帧（前端 canvas，兼容所有 vision 模型——无需供应商视频输入） */
async function extractVideoFrames(file: File, count = 6): Promise<{ mime: string; base64: string; name: string }[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  try {
    await new Promise<void>((res, rej) => {
      video.onloadedmetadata = () => res();
      video.onerror = () => rej(new Error('视频加载失败'));
    });
    const duration = video.duration || 1;
    const vw = video.videoWidth || 1280;
    const scale = Math.min(1, 1280 / vw);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(vw * scale));
    canvas.height = Math.max(2, Math.round((video.videoHeight || 720) * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 不可用');
    const frames: { mime: string; base64: string; name: string }[] = [];
    for (let i = 0; i < count; i++) {
      const t = Math.min((duration * (i + 0.5)) / count, Math.max(duration - 0.05, 0));
      await new Promise<void>((res) => {
        video.onseeked = () => res();
        video.currentTime = t;
      });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({ mime: 'image/jpeg', base64: canvas.toDataURL('image/jpeg', 0.7).split(',')[1] ?? '', name: `${file.name} 帧 ${i + 1}/${count}` });
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 图片扩展名判定（聊天内点击 → 遮罩弹窗；侧栏文件树不受影响） */
export function isImagePath(p: string): boolean {
  const ext = p.split(/[\/]/).pop()?.split('.').pop()?.toLowerCase() ?? '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext);
}

/** 从工具参数提取文件绝对路径（供点击直达编辑器） */
function extractPath(name: string, argsJson?: string): string | null {
  if (!argsJson) return null;
  try {
    const a = JSON.parse(argsJson) as Record<string, unknown>;
    if (typeof a.path === 'string' && a.path.length > 0) return a.path;
  } catch { /* ignore */ }
  return null;
}

function Item({ item }: { item: ChatItem }): ReactElement {
  switch (item.kind) {
    case 'message':
      return item.role === 'user' ? <UserPill text={item.text} images={item.images} /> : (
        <AssistantMessage text={item.text} reasoning={item.reasoning} reasoningMs={item.reasoningMs} />
      );
    case 'tool':
      return <ToolCard item={item} />;
    case 'approval':
      return <ApprovalCard item={item} />;
    case 'notice':
      return <div className={`notice ${item.tone ?? ''}`}>{item.text}</div>;
  }
}

// ---------- ChatPanel ----------
/** 尾窗渲染（#6）：千条消息任务不再全量铺 DOM——默认只渲染最近 200 条，「加载更早」逐步放开 */
const VISIBLE_STEP = 200;

export function ChatPanel({ sidebarCollapsed, onToggleSidebar }: { sidebarCollapsed?: boolean; onToggleSidebar?: () => void }): ReactElement {
  const items = useRuntime((s) => s.items);
  const phase = useRuntime((s) => s.phase);
  const threadId = useRuntime((s) => s.activeThreadId);
  const threads = useRuntime((s) => s.threads);
  const pinned = useRuntime((s) => s.pinned);
  const terminated = useRuntime((s) => s.terminated);
  const turnChanges = useRuntime((s) => s.turnChanges);
  const proposals = useRuntime((s) => s.proposals);
  const runningTurnId = useRuntime((s) => s.runningTurnId);
  const turnDurations = useRuntime((s) => s.turnDurations);
  const runningTurnAt = useRuntime((s) => s.runningTurnAt);
  const turnEnds = useRuntime((s) => s.turnEnds);
  const turnUsageByTurn = useRuntime((s) => s.turnUsageByTurn);
  const checkpoint = useRuntime((s) => s.checkpoint);
  const config = useRuntime((s) => s.config);
  const title = threads.find((t) => t.id === threadId)?.title;
  const [text, setTextState] = useState(getComposerDraft());
  // 写透式 setter：每次变更同步落外部草稿态（卸载清理的时序在"新实例 render 之后"不可靠）
  const setText = (value: string | ((prev: string) => string)): void => {
    const next = typeof value === 'function' ? value(text) : value;
    setComposerDraft(next);
    setTextState(next);
  };
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 12 §F2.3 内嵌终端：开合/高度持久化；display 切换保活（不卸载 = pty 会话不死）
  // 生成时自动跟随最新内容：
  // 旧实现（渲染时一次性贴底检测）在内容单帧长高超过阈值时误判"用户上滚"而断跟——
  // 改为 scroll 事件维护跟随状态（程序贴底后距底=0 → 状态保持 true；用户上滚 → false；滚回底 → 恢复）
  const followRef = useRef(true);
  useEffect(() => {
    const el = document.getElementById('chat-stream');
    if (!el) return;
    const onScroll = (): void => {
      followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  // 内容/阶段变化 → 跟随（followRef 为真才贴底；用户上滚阅读时不打扰）
  useEffect(() => {
    const el = document.getElementById('chat-stream');
    if (!el || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  });

  // 编辑区开关（右上终端按钮旁）：独立于"编辑器占满"（focusRight）；隐藏 = 聊天占满
  const [editorVisible, setEditorVisible] = useState<boolean>(() => localStorage.getItem('loomery.editorVisible') !== '0');
  const toggleEditor = (): void => {
    const next = !editorVisible;
    setEditorVisible(next);
    localStorage.setItem('loomery.editorVisible', next ? '1' : '0');
    window.dispatchEvent(new CustomEvent('loomery:toggle-editor', { detail: { visible: next } }));
  };

  const [terminalOpen, setTerminalOpen] = useState<boolean>(() => localStorage.getItem('loomery.terminal.open') === '1');
  // docs/16 多模态：粘贴的图片附件（随消息一并发送给 LLM——vision 模型直接看图）
  const [attachments, setAttachments] = useState<{ id: string; name: string; mime: string; base64: string }[]>([]);
  // 聊天内图片类文件点击 → 遮罩弹窗（Lightbox）
  // docs/16：当前生效模型的视觉能力（capabilities.input 含 image = 👁 已开启）
  const activeModelVision = (() => {
    const activeEntry = config?.models.entries?.find((e) => e.id === config.models.activeId);
    return ((activeEntry ?? config?.models.main)?.capabilities?.input ?? []).includes('image');
  })();
  const [lightbox, setLightbox] = useState<{ name: string; mime: string; base64: string } | null>(null);
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const [mediaWarn, setMediaWarn] = useState<string | null>(null);
  useEffect(() => {
    const onLightbox = async (ev: Event): Promise<void> => {
      const d = (ev as CustomEvent<{ path?: string; name?: string; mime?: string; base64?: string }>).detail;
      if (!d) return;
      // 直接数据优先（工具截图/附件——base64 已在手）；path 模式走 RPC 读取
      if (d.base64) {
        setLightbox({ name: d.name ?? '截图', mime: d.mime ?? 'image/jpeg', base64: d.base64 });
        return;
      }
      if (!d.path) return;
      try {
        const res = await rpc.call<{ image?: string; mime?: string }>(RPC.fsReadFile, { path: d.path });
        if (res?.image) setLightbox({ name: d.path.split(/[\/]/).pop() ?? d.path, mime: res.mime ?? 'image/png', base64: res.image });
      } catch { /* 读取失败：忽略（保持现状） */ }
    };
    window.addEventListener('loomery:lightbox-image', onLightbox);
    return () => window.removeEventListener('loomery:lightbox-image', onLightbox);
  }, []);
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setLightbox(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);
  // 2026-11-13：编辑区新标签页的终端入口 → 打开底部终端面板
  useEffect(() => {
    const onShow = (): void => setTerminalOpen(true);
    window.addEventListener('loomery:terminal-show', onShow);
    return () => window.removeEventListener('loomery:terminal-show', onShow);
  }, []);
  const [terminalHeight, setTerminalHeight] = useState<number>(readStoredHeight);
  const toggleTerminal = (): void => {
    const next = !terminalOpen;
    setTerminalOpen(next);
    localStorage.setItem('loomery.terminal.open', next ? '1' : '0');
  };
  const persistTerminalHeight = (h: number): void => {
    setTerminalHeight(h);
    localStorage.setItem(TERMINAL_HEIGHT_KEY, String(h));
  };
  const [taskPanel, setTaskPanel] = useState<'brief' | 'memory' | 'artifacts' | null>(null);
  // / 技能菜单：输入以 / 开头弹出启用的技能，选中插入 read_skill 提示语
  const [slash, setSlash] = useState<{ open: boolean; query: string; idx: number }>({ open: false, query: '', idx: 0 });
  const [slashSkills, setSlashSkills] = useState<SkillManifest[] | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(true);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const currentPreset = presetOf(config);
  const preset = currentPreset.id;
  const presetMeta = PRESETS.find((p) => p.id === preset) ?? PRESETS[1]!;

  const isPinned = threadId !== null && pinned.includes(threadId);

  // 尾窗窗口化（#6）：切任务重置；追加式渲染只发生在窗口尾部，历史按需放开
  const [visibleCount, setVisibleCount] = useState(VISIBLE_STEP);
  useEffect(() => {
    setVisibleCount(VISIBLE_STEP);
  }, [threadId]);

  // #7 外部修改横幅：最近 90s 的外部变更 ∩ 本轮 agent 编辑的文件（绝对路径不区分大小写比较，Windows 语义）
  const externalChanges = useRuntime((s) => s.externalChanges);
  const checkpointFiles = checkpoint?.files ?? [];
  const normPath = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
  const touched = new Set([...(turnChanges?.files ?? []), ...checkpointFiles].map(normPath));
  const extOverlap = Object.entries(externalChanges)
    .filter(([, ts]) => Date.now() - ts < 90_000)
    .filter(([p]) => touched.has(normPath(p)));

  // 检查点回滚（原状态栏入口迁至聊天头；checkpointRestored 事件的通知在 runtime reducer）
  const rollback = (): void => {
    if (!checkpoint || !threadId) return;
    void rpc.call(RPC.checkpointRollback, { threadId, turnId: checkpoint.turnId }).catch(() => undefined);
  };


  // 右键"引用到聊天框"：把引用文本追加进输入区并聚焦；用户消息"重新编辑"：整段替换输入区
  useEffect(() => {
    const inserter = (text: string): void => {
      setText((prev) => (prev.length > 0 ? prev + text : text));
      taRef.current?.focus();
    };
    const replacer = (text: string, images?: { mime: string; base64: string; name?: string }[]): void => {
      setText(text);
      // 2026-11-13：重新编辑回填图片附件（多模态消息编辑不再丢失图像）
      setAttachments((images ?? []).map((img, k) => ({ id: Math.random().toString(36).slice(2, 10), name: img.name ?? `附件 ${k + 1}`, mime: img.mime, base64: img.base64 })));
      autosize();
      taRef.current?.focus();
    };
    registerComposerInserter(inserter);
    registerComposerReplacer(replacer);
    // 卸载注销（focusRight 模式 ChatPanel 不挂载）：否则死回调吞掉引用/重编辑
    return () => {
      unregisterComposerInserter(inserter);
      unregisterComposerReplacer(replacer);
    };
  }, []);

  // 审批快捷键（06 §4.2：Ctrl+Enter 接受 / Esc 拒绝，作用于首个未决审批）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        const el = document.querySelector('.card.approval .actions button:not(.primary)');
        (el as HTMLButtonElement | null)?.click();
        return;
      }
      if (e.ctrlKey && e.key === 'Enter') {
        const el = document.querySelector('.card.approval .actions button.primary');
        (el as HTMLButtonElement | null)?.click();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const autosize = (): void => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  };

  // text 变化统一收缩高度：send 里 setText('') 是异步 state，紧跟的 autosize() 读到旧 DOM（实证：发送后输入框高度不回缩）
  useEffect(() => {
    autosize();
  }, [text]);

  // / 技能菜单：过滤（启用中）+ 选中插入 read_skill 提示语
  const slashList = useMemo(() => {
    if (!slashSkills || !config) return [];
    const disabled = new Set(config.skills?.disabled ?? []);
    const q = slash.query.toLowerCase();
    return slashSkills
      .filter((s) => !disabled.has(s.name))
      .filter((s) => q.length === 0 || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [slashSkills, slash.query, config]);
  const updateSlash = (value: string): void => {
    if (value.startsWith('/')) {
      if (!slashSkills) void rpc.call<SkillManifest[]>(RPC.skillList, {}).then(setSlashSkills);
      setSlash({ open: true, query: value.slice(1), idx: 0 });
    } else if (slash.open) {
      setSlash({ open: false, query: '', idx: 0 });
    }
  };
  // 键盘高亮项滚动跟随：wrap 到顶/底时保持可见（否则容器滚块停在下缘、高亮已回顶）
  useEffect(() => {
    if (!slash.open) return;
    const el = document.querySelector('.slash-menu button.active');
    el?.scrollIntoView({ block: 'nearest' });
  }, [slash.idx, slash.open, slashList.length]);

  const pickSlash = (name: string): void => {
    setText('请使用 read_skill 读取技能「' + name + '」并严格按照其内容执行：');
    setSlash({ open: false, query: '', idx: 0 });
    autosize();
    taRef.current?.focus();
  };

  const send = async (): Promise<void> => {
    const imgs = attachments.map((a) => ({ mime: a.mime, base64: a.base64 }));
    if ((!text.trim() && imgs.length === 0) || phase !== 'idle') return;
    let tid = threadId;
    if (!tid) {
      tid = (await rpc.call<{ threadId: string }>(RPC.threadCreate, {})).threadId;
      // 新线程立刻接管事件流：否则后续事件被视为'别的线程'而不渲染
      runtime.resetForThread(tid, []);
    }
    const r = await rpc.call<{ queued?: boolean }>(RPC.threadSend, { threadId: tid, text, mode: currentPreset.mode, images: imgs });
    if (r?.queued) setMediaWarn('当前轮还在进行中——本条已加入队列，完成后自动发送');
    setText('');
    setAttachments([]);
    autosize();
  };

  const stop = (): void => {
    if (threadId) void rpc.call(RPC.threadCancel, { threadId });
  };

  const applyPreset = async (id: PresetId): Promise<void> => {
    if (!config) return;
    const def = PRESETS.find((p) => p.id === id);
    if (!def) return;
    localStorage.setItem('loomery.preset', id);
    const { mode, approval } = def.apply(config);
    await rpc.call(RPC.configSave, { approval });
    runtime.set({ config: await rpc.call<AppConfig>(RPC.configGet), mode });
    setPresetOpen(false);
  };

  const exportThread = async (): Promise<void> => {
    if (!threadId) return;
    const events = await rpc.call<unknown[]>(RPC.threadExport, { threadId });
    const body = events.map((e) => JSON.stringify(e)).join('\n');
    const blob = new Blob([body], { type: 'application/jsonl' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `loomery-thread-${threadId}.jsonl`;
    a.click();
    URL.revokeObjectURL(a.href);
    setMenuOpen(false);
  };

  const deleteTask = async (): Promise<void> => {
    if (!threadId) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await rpc.call(RPC.threadDelete, { threadId });
    runtime.set({ activeThreadId: null, items: [], phase: 'idle', terminated: null, turnChanges: null });
    setMenuOpen(false);
    setConfirmDelete(false);
    const list = await rpc.call<ThreadRow[]>(RPC.threadList, {});
    runtime.set({ threads: list });
  };

  const undoTurn = (): void => {
    if (!threadId || !checkpoint) return;
    void rpc.call(RPC.checkpointRollback, { threadId, turnId: checkpoint.turnId }).catch((err: unknown) => {
      // 静默失败曾表现为"点了没反应"：至少留下排查痕迹；成功路径由 checkpointRestored 清卡+弹提示
      console.error('[undo] 回滚失败', err);
    });
  };

  // 每文件 ±行数：来自 diffProposed 入册的提案（自主模式写入没有提案，则该行不显示统计）
  const fileStatOf = (file: string): { added: number; removed: number } | null => {
    const p = proposals[file];
    if (!p) return null;
    return {
      added: p.hunks.reduce((s, h) => s + h.newLines.length, 0),
      removed: p.hunks.reduce((s, h) => s + h.oldLines.length, 0),
    };
  };

  const showSummary = Boolean(terminated && turnChanges && turnChanges.files.length > 0);

  // 左侧快捷跳转竖轨：每个用户请求一根短横线（悬浮预览输入、点击跳转到该轮）
  // 尾窗窗口化（#6）：rail 与 renderStream 用同一窗口数组，锚点索引天然对齐
  const hiddenCount = Math.max(0, items.length - visibleCount);
  const visibleItems = hiddenCount > 0 ? items.slice(-visibleCount) : items;
  const railEntries = visibleItems
    .flatMap((it, i) => (it.kind === 'message' && it.role === 'user' ? [{ i, text: it.text }] : []))
    .slice(-16);

  return (
    <div className="panel chat-panel">
      {railEntries.length > 0 ? (
        <div className="msg-rail">
          {railEntries.map((e) => (
            <span
              key={e.i}
              className="rail-tick"
              onClick={() => document.getElementById(`user-msg-${e.i}`)?.scrollIntoView({ block: 'start' })}
            >
              <span className="rail-tip">{e.text}</span>
            </span>
          ))}
        </div>
      ) : null}
      <div className="chat-header">
        {sidebarCollapsed ? (
          <span className="chat-header-nav">
            <SidebarNavCluster collapsed onToggle={onToggleSidebar} />
          </span>
        ) : null}
        <span className="chat-header-title">
          {title ? <FolderOpen size={18} /> : <FolderClosed size={18} />}
          {title ?? '新任务'}
        </span>
        <MoreHorizontal size={19} className="tool-icon" onClick={() => setMenuOpen((v) => !v)} />
        <span className="chat-header-tools">
          {checkpoint && checkpoint.files.length > 0 ? (
            <span className="tool-wrap" title={`回滚本轮 ${checkpoint.files.length} 个文件`} onClick={rollback}>
              <Undo2 size={19} className="tool-icon rollback" />
            </span>
          ) : null}
          <span className="tool-wrap" title={`工作区：${config?.workspaceRoots[0] ?? '未打开'}（切换 P1.5）`}>
            <FolderClosed size={18} className="tool-icon dim2" />
            <ChevronDown size={14} className="tool-icon dim2" />
          </span>
          <span
            className={`tool-wrap ${terminalOpen ? 'active' : ''}`}
            title={terminalOpen ? '关闭终端面板' : '打开终端面板'}
            onClick={toggleTerminal}
          >
            <SquareTerminal size={19} className="tool-icon" />
          </span>
          <span
            className={`tool-wrap ${editorVisible ? '' : 'dim2'}`}
            title={editorVisible ? '隐藏编辑区' : '显示编辑区'}
            onClick={toggleEditor}
          >
            <PanelRight size={19} className="tool-icon" />
          </span>
          <span className="tool-wrap" title="导出会话（JSONL）"><Upload size={19} className="tool-icon" onClick={() => void exportThread()} /></span>
          <span className="tool-wrap" title="帮助"><CircleHelp size={19} className="tool-icon" onClick={() => window.dispatchEvent(new CustomEvent('loomery:open-help'))} /></span>
          <span className="tool-wrap dim2" title="在独立窗口打开任务（P2）"><AppWindow size={19} className="tool-icon dim2" /></span>
          <WinControls />
        </span>
        {menuOpen ? (
          <>
            <div className="menu-backdrop" onClick={() => { setMenuOpen(false); setConfirmDelete(false); }} />
            <div className="dropdown chat-header-menu">
              <button disabled={!threadId} onClick={() => { if (threadId) runtime.togglePin(threadId); setMenuOpen(false); }}>
                <Pin size={14} /> {isPinned ? '取消置顶' : '置顶任务'}
              </button>
              <button disabled={!threadId} onClick={() => { void exportThread(); }}>
                <Upload size={14} /> 导出会话（JSONL）
              </button>
              <button disabled={!threadId} onClick={() => {
                void rpc.call<{ canceled: boolean; dest?: string }>(RPC.exportBundle, { threadId }).then((r) => {
                  if (!r.canceled && r.dest) alert('任务包已导出到：' + r.dest + '\n\n注意：API 密钥不在任务包内，换机后请在设置中重新填写。');
                }).catch(() => alert('导出失败，详见 electron-debug.log'));
                setMenuOpen(false);
              }}>
                🗂 导出任务包（含记忆/暂存/产物）
              </button>
              <button disabled={!threadId} onClick={() => { setTaskPanel('brief'); setMenuOpen(false); }}>
                📄 任务简报
              </button>
              <button disabled={!threadId} onClick={() => { setTaskPanel('memory'); setMenuOpen(false); }}>
                📌 任务记忆
              </button>
              <button disabled={!threadId} onClick={() => { window.dispatchEvent(new CustomEvent('loomery:open-settings', { detail: 'skills' })); setMenuOpen(false); }}>
                🧩 技能（设置页）
              </button>
              <button className={confirmDelete ? 'danger' : ''} disabled={!threadId} onClick={() => void deleteTask()}>
                <Trash2 size={14} /> {confirmDelete ? '再次点击确认删除' : '删除任务'}
              </button>
            </div>
          </>
        ) : null}
      </div>
      {/* 12 胶囊体：chat-panel 直属（相对面板定位；勿放回 header 内——drag 区吞点击 + 定位基准错） */}
      <ActivityCapsule />

      <div className="panel-body chat-stream" id="chat-stream">
        {extOverlap.length > 0 ? (
          <div className="ext-banner">
            <span>⚠ 本轮编辑的 {extOverlap.length} 个文件检测到外部修改：{extOverlap.slice(0, 3).map(([p]) => p.split(/[\\/]/).pop()).join('、')}{extOverlap.length > 3 ? ' 等' : ''}——继续操作可能覆盖外部改动</span>
            <button onClick={() => runtime.dismissExternalChanges()}>知道了</button>
          </div>
        ) : null}
        {hiddenCount > 0 ? (
          <button
            className="load-earlier"
            onClick={() => setVisibleCount((v) => v + VISIBLE_STEP)}
          >
            加载更早消息（还有 {hiddenCount} 条）
          </button>
        ) : null}
        {items.length === 0 ? <div className="empty-center">向 Agent 描述你要做的事。写操作会先请求审批。</div> : renderStream(visibleItems, { running: phase !== 'idle', runningTurnId, turnDurations, runningTurnAt, turnEnds, turnUsageByTurn, terminated })}
        {showSummary ? (
          <div className="card turn-summary" ref={summaryRef}>
            <div className="ts-head" onClick={() => {
              const next = !filesOpen;
              setFilesOpen(next);
              // 过程框展开后汇总卡被推到滚动区最底：展开的文件列表长在可视区下方，
              // 不做最小锚定看起来就像"展开了但是空的"（列表已在视野内时 nearest 不产生滚动）
              if (next) requestAnimationFrame(() => summaryRef.current?.scrollIntoView({ block: 'nearest' }));
            }}>
              <ChevronDown size={14} className={`ts-chevron${filesOpen ? '' : ' collapsed'}`} />
              <span className="ts-total">{turnChanges?.files.length} 个文件已更改</span>
              <b className="added">+{turnChanges?.added ?? 0}</b>
              <b className="removed">−{turnChanges?.removed ?? 0}</b>
              <span className="summary-actions">
                <button
                  disabled={checkpoint?.turnId !== turnChanges?.turnId}
                  title={checkpoint?.turnId === turnChanges?.turnId ? '回滚本轮全部改动' : '本轮没有可回滚的 checkpoint'}
                  onClick={(e) => { e.stopPropagation(); undoTurn(); }}
                >
                  ↩ 撤销
                </button>
              </span>
            </div>
            {filesOpen ? (
              <div className="ts-files">
                {(turnChanges?.files ?? []).map((file) => {
                  const st = fileStatOf(file);
                  return (
                    <div className="ts-file" key={file}>
                      <span className="ts-icon">{fileIconOf(file)}</span>
                      <span className="ts-name" title={file}>{basename(file)}</span>
                      <span className="ts-dir" title={file}>{dirOf(file, config?.workspaceRoots[0])}</span>
                      {st ? (
                        <span className="ts-stats"><b className="added">+{st.added}</b> <b className="removed">−{st.removed}</b></span>
                      ) : <span className="ts-stats" />}
                      <span className="ts-actions">
                        <button onClick={() => void reviewTurnFile(turnChanges?.turnId, file, proposals[file])}>审查</button>
                        <button onClick={() => void openInEditor(file)}>打开</button>
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="composer-card">
        {mediaWarn ? <div className="attach-warn">⚠ {mediaWarn}</div> : null}
        {attachments.length > 0 && !activeModelVision ? (
          <div className="attach-warn">⚠ 当前模型未开启视觉输入——图像不会发送给模型。在「模型设置」对应模型行点击 👁 开启（该模型官方支持视觉时直接生效）。</div>
        ) : null}
        {attachments.length > 0 ? (
          <div className="attach-strip">
            {attachments.map((a) => (
              <span key={a.id} className="attach-thumb">
                <img
                  src={`data:${a.mime};base64,${a.base64}`}
                  alt={a.name}
                  title={`${a.name}（点击预览）`}
                  onClick={() => window.dispatchEvent(new CustomEvent('loomery:lightbox-image', { detail: { name: a.name, mime: a.mime, base64: a.base64 } }))}
                />
                <span
                  className="attach-remove"
                  title="移除"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                >
                  ✕
                </span>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={taRef}
          rows={1}
          placeholder={attachments.length > 0 ? '已附加截图——可再输入说明（Enter 发送）…' : '提出后续修改要求（Enter 发送，Shift+Enter 换行）…'}
          value={text}
          onChange={(e) => { setText(e.target.value); autosize(); updateSlash(e.target.value); }}
          onPaste={(e) => {
            // docs/16 多模态：剪贴板图片 → 附件（随消息发送给 LLM；vision 模型直接看图）
            const files: File[] = [];
            for (const item of Array.from(e.clipboardData?.items ?? [])) {
              if (item.kind === 'file' && item.type.startsWith('image/')) {
                const f = item.getAsFile();
                if (f && f.size <= 8 * 1024 * 1024) files.push(f);
              }
            }
            if (files.length === 0) return;
            e.preventDefault();
            for (const f of files) {
              if (attachments.length + files.indexOf(f) >= 4) break;
              const reader = new FileReader();
              reader.onload = () => {
                const dataUrl = String(reader.result ?? '');
                const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
                setAttachments((prev) => (prev.length >= 4 ? prev : [...prev, { id: Math.random().toString(36).slice(2, 10), name: f.name || `paste-${Date.now()}.png`, mime: f.type || 'image/png', base64 }]));
              };
              reader.readAsDataURL(f);
            }
          }}
          onKeyDown={(e) => {
            // / 技能菜单键盘导航（开启时优先消费按键）
            if (slash.open && slashList.length > 0) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlash((v) => ({ ...v, idx: (v.idx + 1) % slashList.length })); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlash((v) => ({ ...v, idx: (v.idx - 1 + slashList.length) % slashList.length })); return; }
              if (e.key === 'Enter') { e.preventDefault(); pickSlash(slashList[slash.idx]!.name); return; }
              if (e.key === 'Escape') { e.preventDefault(); setSlash({ open: false, query: '', idx: 0 }); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {lightbox ? (
          <div className="lightbox-overlay" onClick={() => setLightbox(null)}>
            <img className="lightbox-img" src={`data:${lightbox.mime};base64,${lightbox.base64}`} alt={lightbox.name} />
            <span className="lightbox-name">{lightbox.name}</span>
          </div>
        ) : null}
        {slash.open && slashList.length > 0 ? (
          <div className="dropdown slash-menu">
            {slashList.map((sk, i) => (
              <button key={sk.entry} className={i === slash.idx ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); pickSlash(sk.name); }}>
                <b>{sk.name}</b>
                <span className="slash-desc">{sk.description}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="row composer-bar">
          <input
            ref={mediaInputRef}
            type="file"
            accept="image/*,video/*"
            multiple
            style={{ display: 'none' }}
            onChange={async (e) => {
              const list = Array.from(e.target.files ?? []);
              e.target.value = '';
              for (const f of list) {
                if (f.type.startsWith('image/') && f.size <= 8 * 1024 * 1024) {
                  const dataUrl = await new Promise<string>((res) => {
                    const reader = new FileReader();
                    reader.onload = () => res(String(reader.result ?? ''));
                    reader.readAsDataURL(f);
                  });
                  setAttachments((prev) => (prev.length >= 8 ? prev : [...prev, { id: Math.random().toString(36).slice(2, 10), name: f.name || 'image.png', mime: f.type || 'image/png', base64: dataUrl.slice(dataUrl.indexOf(',') + 1) }]));
                } else if (f.type.startsWith('video/') && f.size <= 200 * 1024 * 1024) {
                  // docs/16 P2 视频：抽帧为多图（兼容所有 vision 模型，无需供应商视频输入）
                  try {
                    const frames = await extractVideoFrames(f, 6);
                    setAttachments((prev) => (prev.length >= 8 ? prev : [...prev, ...frames.map((fr, k) => ({ id: Math.random().toString(36).slice(2, 10) + k, name: fr.name, mime: fr.mime, base64: fr.base64 }))].slice(0, 8)));
                  } catch {
                    setMediaWarn('视频处理失败——请尝试其他格式的视频文件。');
                  }
                }
              }
            }}
          />
          <button className="mode-btn" title="添加图片 / 视频（视频自动抽取 6 帧分析）" onClick={() => mediaInputRef.current?.click()}>
            <Plus size={15} />
          </button>
          <span className="preset-wrap">
            <button className="preset-btn" onClick={() => setPresetOpen((v) => !v)} title="工作模式">
              <span className="preset-icon">{presetMeta.icon}</span> {presetMeta.title} <ChevronDown size={13} />
            </button>
            {presetOpen ? (
              <>
                <div className="menu-backdrop" onClick={() => setPresetOpen(false)} />
                <div className="dropdown preset-menu">
                  {PRESETS.map((p) => (
                    <button key={p.id} onClick={() => void applyPreset(p.id)}>
                      <span className="preset-item-icon">{p.icon}</span>
                      <span className="preset-item-body">
                        <span className="preset-item-title">{p.title}</span>
                        <span className="preset-item-desc">{p.desc}</span>
                      </span>
                      {p.id === preset ? <Check size={14} className="dd-check" /> : null}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </span>
          <span className="composer-spacer" />
          <ContextRing threadId={threadId} busy={phase !== 'idle'} />
          <ModelMenu />
          {phase === 'idle' ? (
            <button className="send-circle" title="发送" onClick={() => void send()}><ArrowUp size={16} /></button>
          ) : (
            <button className="send-circle stop" title="停止" onClick={stop}><X size={16} /></button>
          )}
        </div>
      </div>
      {taskPanel && threadId ? (
        taskPanel === 'brief'
          ? <BriefPanel threadId={threadId} onClose={() => setTaskPanel(null)} />
          : taskPanel === 'memory'
            ? <MemoryPanel threadId={threadId} onClose={() => setTaskPanel(null)} />
            : <ArtifactsPanel threadId={threadId} onClose={() => setTaskPanel(null)} />
      ) : null}
      {/* 12 §F2.3 内嵌终端（用户定稿：输入框下方，聊天区最底部；display 切换保活） */}
      <div className={terminalOpen ? 'term-wrap' : 'term-wrap collapsed'}>
        <TerminalPanel
          visible={terminalOpen}
          height={terminalHeight}
          onResize={persistTerminalHeight}
          onCloseAll={() => {
            setTerminalOpen(false);
            localStorage.setItem('loomery.terminal.open', '0');
          }}
        />
      </div>
    </div>
  );
}

// MODES 常量随 explain 模式 P1.5 回归时一并移除
void MODES;

// ---------- 每轮计时：每个用户请求各一个（AI 回答前开始计时，本轮结束定格） ----------
/** docs/15：task_complete 自报轮次的完成报告块（替代页脚截断的 tf-summary——正式落位） */
function SelfReportBlock({ summary }: { summary: string }): ReactElement {
  return (
    <div className="self-report-block">
      <div className="sr-head">✅ 完成报告（agent 自检收尾）</div>
      {/* 复用 AssistantMessage 的 Markdown 管线——与过程/正文的渲染格式完全一致（内联码/列表/粗体） */}
      <div className="sr-summary">
        <AssistantMessage text={summary} />
      </div>
    </div>
  );
}

/** docs/16 批次 D 配套：任务执行时在模型输出内容左下角显示绿色"执行中"动画 + 实时耗时（非输入框） */
function StreamingIndicator({ startAt }: { startAt: number }): ReactElement {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((now - startAt) / 1000));
  const fmt = (v: number): string => (v >= 60 ? `${Math.floor(v / 60)} 分 ${v % 60} 秒` : `${v} 秒`);
  return (
    <div className="streaming-indicator">
      <span className="streaming-dot" />
      <span>执行中</span>
      <span className="streaming-time">· {fmt(secs)}</span>
    </div>
  );
}

function TurnTimer({ running, startAt, duration }: { running: boolean; startAt: number; duration?: number }): ReactElement | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const ms = running ? Math.max(0, now - startAt) : duration;
  if (ms === undefined) return null;
  const secs = Math.floor(ms / 1000);
  const fmt = (v: number): string => (v >= 60 ? `${Math.floor(v / 60)} 分 ${v % 60} 秒` : `${v} 秒`);
  return (
    <div className="task-timer">
      {running ? <span className="tp-running">⏳ 工作中 · {fmt(secs)}</span> : <span>✓ 本轮用时 {fmt(secs)}</span>}
    </div>
  );
}

// ---------- Turn 过程分组渲染：按 LLM 生成顺序进折叠框，每轮最终回答留在框外 ----------

function renderStream(
  items: ChatItem[],
  work: { running: boolean; runningTurnId: string | null; turnDurations: Record<string, number>; runningTurnAt: number | null; turnEnds: Record<string, string>; turnUsageByTurn: Record<string, { inputTokens: number; outputTokens: number; steps: number }>; terminated: { reason: string; finalSummary?: string } | null },
): ReactElement[] {
  // 审批卡内嵌到对应工具行：toolCallId → 审批项
  const approvalByTool = new Map<string, ApprovalItem>();
  for (const it of items) {
    if (it.kind === 'approval') approvalByTool.set(it.toolCallId, it);
  }
  const toolExists = (toolCallId: string): boolean => items.some((x) => x.kind === 'tool' && x.toolCallId === toolCallId);

  // 最后一个有结束记录的轮（finalSummary 归属它）
  const out: ReactElement[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i]!;
    // 用户请求：胶囊独立渲染 + 每轮各自的计时（跟在该请求后、AI 回答前）
    if (item.kind === 'message' && item.role === 'user') {
      out.push(
        <div key={`u${i}`} id={`user-msg-${i}`} className="user-msg-anchor">
          <UserPill text={item.text} images={item.images} />
        </div>,
      );
      let tId: string | null = null;
      for (let j = i + 1; j < items.length; j++) {
        const nx = items[j]!;
        if (nx.kind === 'message' && nx.role === 'user') break;
        if (nx.turnId && nx.turnId !== '?') { tId = nx.turnId; break; }
      }
      if (tId) {
        const isRunning = work.running && work.runningTurnId === tId;
        const dur = work.turnDurations[tId];
        if (isRunning || dur !== undefined) {
          out.push(<TurnTimer key={`tt${i}`} running={isRunning} startAt={work.runningTurnAt ?? 0} duration={dur} />);
        }
      }
      i++;
      continue;
    }
    const turnId = item.turnId ?? '?';
    // 无轮次归属的散项（如回滚 notice）：内联渲染保持可见
    if (turnId === '?') {
      if (!(item.kind === 'approval' && toolExists(item.toolCallId))) {
        out.push(<Item key={`x${i}`} item={item} />);
      }
      i++;
      continue;
    }
    const endReason = work.turnEnds[turnId];
    const lastReasonTurnId = Object.keys(work.turnEnds).at(-1);
    // 同一轮：连续收集同 turnId 的全部项（思考/工具/notice/中间正文），按 LLM 生成顺序进折叠框
    const group: ChatItem[] = [];
    let j = i;
    while (j < items.length) {
      const it = items[j]!;
      if (it.kind === 'message' && it.role === 'user') break;
      if ((it.turnId ?? '?') !== turnId) break;
      group.push(it);
      j++;
    }
    // 该轮最后一条带正文的助手消息 = 最终回答，留在框外常显（折叠后答案不丢）。
    // 仅 turn 已结束时才提出框外：运行中每步的过渡文本都是"过程"，不外显——
    // 否则每步新文本进来都顶到框外，用户看到"过程底下一直有内容在流"。
    const turnFinished = !(work.running && work.runningTurnId === turnId);
    let finalIdx = -1;
    if (turnFinished) {
      for (let k = group.length - 1; k >= 0; k--) {
        const g = group[k];
        if (g && g.kind === 'message' && g.role === 'assistant' && g.text.length > 0) { finalIdx = k; break; }
      }
    }
    const boxItems = group.filter((g, k) => {
      if (k === finalIdx) return false; // 最终回答在框外
      if (g.kind === 'approval' && toolExists(g.toolCallId)) return false; // 已内嵌进工具行
      return true;
    });
    if (boxItems.length > 0) {
      out.push(
        <TurnProcessBlock
          key={`t:${turnId}:${i}`}
          items={boxItems}
          running={work.running && work.runningTurnId === turnId}
          approvals={approvalByTool}
        />,
      );
    }

    if (finalIdx >= 0) {
      const fin = group[finalIdx]!;
      out.push(<Item key={`f:${turnId}:${i}`} item={fin} />);
    }
    // docs/15：selfReport 轮次 → 完成报告块（页脚的 tf-summary 截断版不再重复显示）
    if (endReason === 'selfReport' && work.terminated?.finalSummary && turnId === lastReasonTurnId) {
      out.push(<SelfReportBlock key={`sr:${turnId}:${i}`} summary={work.terminated.finalSummary} />);
    }
    // 每轮问答独立页脚（合并行）：左=操作（复制总结/全文/赞/踩），右=该轮 ↑↓ 用量与步数；"本轮完成"文字按需求删除
    const u = work.turnUsageByTurn[turnId];
    // docs/15：selfReport（task_complete 自报收尾）是健康终止，不标"已停止"
    const stopped = endReason !== undefined && endReason !== 'natural' && endReason !== 'selfReport';
    const finMsg = finalIdx >= 0 && group[finalIdx] !== undefined && group[finalIdx]!.kind === 'message' && (group[finalIdx] as MessageItem).role === 'assistant' ? (group[finalIdx] as MessageItem) : null;
    // docs/16：执行中 → 页脚左侧显示绿色执行中动画+实时耗时（与右侧用量同行，2026-11-13 用户定稿合一行）
    const isRunningTurn = work.running && work.runningTurnId === turnId;
    if ((endReason !== undefined || u || isRunningTurn) && (stopped || u || finMsg || isRunningTurn)) {
      out.push(
        <div key={`footer:${turnId}:${i}`} className={`turn-footer merged ${stopped ? 'warn' : ''}`}>
          {isRunningTurn ? <StreamingIndicator startAt={work.runningTurnAt ?? 0} /> : stopped ? <span className="tf-reason">⏹ 本轮已停止（{endReason}），回复可能不完整</span> : null}
          {finMsg ? (
            <span className="footer-actions">
              <span className="tool-wrap" title="复制总结（最后一段）"><Copy size={13} className="tool-icon" onClick={() => copyText(summaryText(finMsg.text))} /></span>
              <span className="tool-wrap" title="复制全文"><CopyPlus size={13} className="tool-icon" onClick={() => copyText(finMsg.text)} /></span>
              <span className="tool-wrap dim2" title="赞（即将支持）"><ThumbsUp size={13} className="tool-icon dim2" /></span>
              <span className="tool-wrap dim2" title="踩（即将支持）"><ThumbsDown size={13} className="tool-icon dim2" /></span>
            </span>
          ) : null}
          <span className="footer-spacer" />
          {work.terminated?.finalSummary && turnId === lastReasonTurnId && endReason !== 'selfReport' ? <span className="tf-summary">{work.terminated.finalSummary}</span> : null}
          {u ? (
            <span className="tf-usage" title={`输入 ${u.inputTokens} tokens · 输出 ${u.outputTokens} tokens`}>
              ↑{u.inputTokens.toLocaleString()} ↓{u.outputTokens.toLocaleString()} · {u.steps} 步
            </span>
          ) : null}
        </div>,
      );
    }
    i = j;
  }
  return out;
}

function TurnProcessBlock({ items, running, approvals }: { items: ChatItem[]; running: boolean; approvals: Map<string, ApprovalItem> }): ReactElement {
  // 开合策略：运行中强制展开且不可手动收起（未到总结环节）；结束自动收起；之后可自由开合。
  // 直接以 DOM open 状态为准（ref 控制），不走 React 受控 open 属性——受控 details 与 onToggle 手改 DOM 混用会失同步，表现为"该收不收"。
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const el = detailsRef.current;
    if (el) el.open = running;
  }, [running]);
  const label = running ? `进行中 · ${items.length} 项` : `过程 · ${items.length} 项`;
  return (
    <details
      ref={detailsRef}
      className="turn-process"
      onToggle={() => {
        const el = detailsRef.current;
        if (!el) return;
        if (running) { el.open = true; return; } // 未到总结：立即弹回展开
        // 展开后内容自身限高滚动（见 .turn-process-body max-height），页面布局几乎不动；
        // 仅当框头不在视野内时最小滚动露出
        if (el.open) requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }));
      }}
    >
      <summary>
        {running ? <span className="tp-running">⏳ {label}</span> : <span>✓ {label}</span>} <ChevronDown size={13} />
      </summary>
      <div className="turn-process-body">
        {items.map((it, i) =>
          it.kind === 'tool'
            ? <ToolCard key={i} item={it} approval={approvals.get(it.toolCallId)} />
            : <Item key={i} item={it} />,
        )}
      </div>
    </details>
  );
}
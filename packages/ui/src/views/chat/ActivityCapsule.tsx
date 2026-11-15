// ActivityCapsule（12 UI + ADR-0026）：聊天区右上常驻活动概览——Git 工作区 + 本轮进程
// 折叠=小胶囊（不占聊天流、不随滚动消失）；展开=浮动面板。
// 数据源：Git 区走读模型 RPC（git.overview，UI 与 agent 两个消费者各走各的门）；
//         进程区优先 planByTurn（plan_write 的全量快照），无计划时回退工具调用时间线。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ChevronDown, ChevronUp, Circle, CircleCheck, CircleX, FilePlus, GitBranch, GitCommitHorizontal, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';
import { rpc } from '@loomery/adapter-ipc-bridge/renderer';
import type { PlanStep } from '@loomery/domain';
import { useRuntime } from '../../stores/runtime';

interface GitChangedFile {
  path: string;
  status: string;
  added: number;
  removed: number;
  staged?: boolean;
}
interface GraphCommitRow { sha: string; parents: string[]; subject: string; refs: string }

interface GitOverview {
  repo: boolean;
  branch: string;
  changed: GitChangedFile[];
  totalAdded: number;
  totalRemoved: number;
}

const OPEN_KEY = 'loomery.capsule.open';

interface ProgressRow {
  key: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

function planRows(steps: PlanStep[]): ProgressRow[] {
  return steps.map((s) => ({ key: s.id, title: s.title, status: s.status }));
}

function StatusIcon({ status }: { status: ProgressRow['status'] }): ReactElement {
  if (status === 'completed') return <CircleCheck size={13} className="cap-ic ok" />;
  if (status === 'failed') return <CircleX size={13} className="cap-ic err" />;
  if (status === 'in_progress') return <Loader2 size={13} className="cap-ic spin" />;
  return <Circle size={13} className="cap-ic dim" />;
}

export function ActivityCapsule(): ReactElement | null {
  const config = useRuntime((s) => s.config);
  const activeRoot = useRuntime((s) => s.threads.find((t) => t.id === s.activeThreadId)?.workspaceRoot);
  const phase = useRuntime((s) => s.phase);
  const runningTurnId = useRuntime((s) => s.runningTurnId);
  const turnEnds = useRuntime((s) => s.turnEnds);
  const planByTurn = useRuntime((s) => s.planByTurn);
  const activeThreadId = useRuntime((s) => s.activeThreadId);

  const root = activeRoot ?? config?.workspaceRoots[0];
  const [git, setGit] = useState<GitOverview | null>(null);
  const running = phase !== 'idle';
  const [open, setOpen] = useState<boolean>(() => localStorage.getItem(OPEN_KEY) === '1');
  const [committing, setCommitting] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [includeUnstaged, setIncludeUnstaged] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [pushRemote, setPushRemote] = useState<string | null>(null);
  const [pushRemotes, setPushRemotes] = useState<string[]>([]);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchInfo, setBranchInfo] = useState<{ current: string; detached: boolean; local: string[]; remote: string[] } | null>(null);
  const [newBranch, setNewBranch] = useState('');
  const [branchQuery, setBranchQuery] = useState('');
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphCommits, setGraphCommits] = useState<GraphCommitRow[]>([]);

  const loadBranches = (): void => {
    if (!root) return;
    setBranchLoading(true);
    void rpc
      .call<{ current: string; detached: boolean; local: string[]; remote: string[] }>(RPC.gitBranches, { root })
      .then((b) => {
        setBranchInfo(b);
        setBranchLoading(false);
      })
      .catch(() => setBranchLoading(false));
  };
  const doCheckout = (branch: string, create: boolean): void => {
    if (!root) return;
    setNotice(null);
    void rpc
      .call<{ ok: boolean; error?: string }>(RPC.gitCheckout, { root, branch, create })
      .then((r) => {
        if (r.ok) {
          setNotice(create ? `已创建并检出：${branch}` : `已切换到：${branch}（打开中的文件如显示旧内容请重新打开）`);
          setNewBranch('');
          setBranchOpen(false);
          refresh();
        } else {
          setNotice(`切换失败：${r.error ?? '未知错误'}`);
        }
      })
      .catch((err: unknown) => setNotice(`切换失败：${String(err instanceof Error ? err.message : err)}`));
  };
  const doMerge = (branch: string): void => {
    if (!root) return;
    setNotice(null);
    void rpc
      .call<{ ok: boolean; output?: string; error?: string }>(RPC.gitMerge, { root, branch })
      .then((r) => {
        setNotice(r.ok ? `已合并 ${branch}` : `合并失败：${r.error ?? ''}`);
        refresh();
      })
      .catch((err: unknown) => setNotice(`合并失败：${String(err instanceof Error ? err.message : err)}`));
  };
  const doRebase = (branch: string): void => {
    if (!root) return;
    setNotice(null);
    void rpc
      .call<{ ok: boolean; output?: string; error?: string }>(RPC.gitRebase, { root, branch })
      .then((r) => {
        setNotice(r.ok ? `已变基到 ${branch}` : `变基失败：${r.error ?? ''}`);
        refresh();
      })
      .catch((err: unknown) => setNotice(`变基失败：${String(err instanceof Error ? err.message : err)}`));
  };

  const loadGraph = (): void => {
    if (!root) return;
    void rpc
      .call<GraphCommitRow[]>(RPC.gitGraphData, { root, limit: 40 })
      .then((list) => setGraphCommits(list ?? []))
      .catch(() => setGraphCommits([]));
  };
  const [notice, setNotice] = useState<string | null>(null);
  const reqSeq = useRef(0);

  const refresh = useCallback((): void => {
    if (!root) {
      setGit(null);
      return;
    }
    const seq = ++reqSeq.current;
    void rpc
      .call<GitOverview>(RPC.gitOverview, { root })
      .then((ov) => {
        if (seq === reqSeq.current) setGit(ov);
      })
      .catch(() => {
        if (seq === reqSeq.current) setGit(null);
      });
  }, [root]);

  // 刷新触发：挂载/切根/轮结束 + 运行中每 5s 轮询（长任务执行中数字不再冻结）+ 文件变更防抖
  const endedCount = Object.keys(turnEnds).length;
  useEffect(() => {
    refresh();
  }, [refresh, endedCount]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => refresh(), 5000);
    return () => clearInterval(t);
  }, [running, refresh]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onFilesChanged = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => refresh(), 1500);
    };
    window.addEventListener('loomery:files-changed', onFilesChanged);
    return () => {
      window.removeEventListener('loomery:files-changed', onFilesChanged);
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  // 进程数据：当前轮（运行中）或最近结束轮
  // ADR-0026：进程区只显示计划步骤（用户定稿：工具调用列表是噪音，不回退）
  // key 兼容读取：新写法 threadId:turnId；本会话早期数据可能只有 turnId
  // 2026-11-13 用户定稿反转：任务结束后子任务清单**保持显示直到下次任务开始**（不再 5 分钟隐藏）；
  // 按线程隔离——显示当前线程最近一次有计划的轮，切到无计划的任务自然为空（不串显示）
  const lastThreadPlan = useMemo<ProgressRow[] | undefined>(() => {
    const tid = activeThreadId ?? '';
    const keys = Object.keys(planByTurn).filter((k) => k.startsWith(tid + ':'));
    const plan = keys.length > 0 ? planByTurn[keys[keys.length - 1] ?? ''] : undefined;
    return plan && plan.length > 0 ? planRows(plan) : undefined;
  }, [activeThreadId, planByTurn]);
  const rows = useMemo<ProgressRow[]>(() => {
    const tid = activeThreadId ?? '';
    if (running && runningTurnId) {
      // 当前轮计划 → 回退线程最后一份（plan_write 前的空窗期/复用上下文不重新规划时，进度不再消失）
      const plan: ProgressRow[] | undefined = planByTurn[tid + ':' + runningTurnId]
        ? planRows(planByTurn[tid + ':' + runningTurnId] as PlanStep[])
        : lastThreadPlan;
      return plan && plan.length > 0 ? plan : [];
    }
    return lastThreadPlan ?? [];
  }, [running, runningTurnId, activeThreadId, planByTurn, lastThreadPlan]);
  const done = rows.filter((r) => r.status === 'completed').length;
  // 2026-11-13 反转定稿：完成后保持显示直到下次任务（5 分钟时效删除）；线程切换时 rows 随 tid 重派生


  // 运行中自动展开跟随进度；轮结束 10s 后自动收起（不打扰）
  useEffect(() => {
    if (running && rows.length > 0) {
      if (localStorage.getItem(OPEN_KEY) !== '1') setOpen(true);
    } else if (!running && rows.length > 0) {
      const t = setTimeout(() => setOpen(false), 10_000);
      return () => clearTimeout(t);
    }
  }, [running, rows.length]);
  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    localStorage.setItem(OPEN_KEY, next ? '1' : '0');
  };

  const submitCommit = (pushAfter: boolean, remote?: string, branch?: string): void => {
    const msg = commitMsg.trim();
    if (!msg || !root) return;
    setNotice(null);
    void rpc
      .call<{ ok: boolean; summary?: string; error?: string }>(RPC.gitAddCommit, { root, message: msg, includeUnstaged: includeUnstaged })
      .then((r) => {
        if (!r.ok) {
          setNotice(`提交失败：${r.error ?? '未知错误'}`);
          return null;
        }
        if (!pushAfter) {
          setNotice(`已提交：${r.summary ?? ''}`);
          setCommitMsg('');
          setCommitting(false);
          refresh();
          return null;
        }
        return rpc.call<{ ok: boolean; output?: string; error?: string }>(RPC.gitPush, { root, ...(remote ? { remote } : {}), ...(branch ? { branch } : {}) }).then((pr) => {
          if (pr.ok) {
            setNotice('已提交并推送');
            setCommitMsg('');
            setCommitting(false);
            refresh();
          } else {
            setNotice(`已提交，但推送失败：${pr.error ?? '未知错误'}`);
            refresh();
          }
          return null;
        });
      })
      .catch((err: unknown) => setNotice(`提交失败：${String(err instanceof Error ? err.message : err)}`));
  };

  /** 仅推送：不需要提交信息（推送的是已存在的本地提交），与提交流程解耦 */
  const doPush = (remote?: string): void => {
    if (!root) return;
    setNotice(null);
    void rpc
      .call<{ ok: boolean; output?: string; error?: string }>(RPC.gitPush, { root, ...(remote ? { remote } : {}) })
      .then((pr) => {
        setNotice(pr.ok ? '已推送' : `推送失败：${pr.error ?? '未知错误'}`);
        if (pr.ok) refresh();
      })
      .catch((err: unknown) => setNotice(`推送失败：${String(err instanceof Error ? err.message : err)}`));
  };

  const suggestMsg = (): void => {
    if (!root) return;
    setSuggesting(true);
    setNotice(null);
    void rpc
      .call<{ ok: boolean; message?: string; error?: string }>(RPC.gitSuggestMessage, { root })
      .then((r) => {
        if (r.ok && r.message) {
          setCommitMsg(r.message);
        } else {
          setNotice(`生成失败：${r.error ?? '未知错误'}——请手动输入`);
        }
        setSuggesting(false);
      })
      .catch(() => setSuggesting(false));
  };

  const showGit = git?.repo === true;
  const untrackedCount = git?.changed.filter((f) => f.status === '?').length ?? 0;
  const hasStaged = git?.changed.some((f) => f.staged === true) ?? false;
  // 提交范围计数：勾选"包含未暂存"=全部变更文件，否则仅已暂存；0 个时提交必然失败→禁用按钮（L7①）
  const stagedCount = git?.changed.filter((f) => f.staged === true).length ?? 0;
  const commitCount = includeUnstaged ? git?.changed.length ?? 0 : stagedCount;
  const canCommit = commitMsg.trim().length > 0 && commitCount > 0;
  // notice 挂到当前打开的弹层内（提交失败时弹层保持打开，错误必须可见）
  const noticeNode = notice ? <div className="cap-notice">{notice}</div> : null;
  // 分支弹层的过滤结果（当前分支固定置顶不入列表）
  const branchQueryLower = branchQuery.toLowerCase();
  const localOthers = branchInfo ? branchInfo.local.filter((b) => b !== branchInfo.current && b.toLowerCase().includes(branchQueryLower)) : [];
  const remoteList = branchInfo ? branchInfo.remote.filter((b) => b.toLowerCase().includes(branchQueryLower)).slice(0, 20) : [];
  // 无 git 且无进程数据：胶囊不出现（不打扰）
  if (!showGit && rows.length === 0) return null;

  return (
    <div className={`activity-capsule ${open ? 'open' : ''}`}>
      <div className="cap-pill" onClick={toggle} title={open ? '收起' : '展开活动概览'}>
        {showGit ? (
          <span className="cap-pill-seg">
            <GitBranch size={12} />
            <span className="cap-branch">{git!.branch || 'HEAD'}</span>
            {git!.changed.length > 0 ? (
              <span className="cap-delta">
                <b className="added">+{git!.totalAdded}</b> <b className="removed">−{git!.totalRemoved}</b>
                {untrackedCount > 0 ? <span className="dim"> · {untrackedCount} 新</span> : null}
              </span>
            ) : null}
          </span>
        ) : null}
        {rows.length > 0 ? (
          <span className="cap-pill-seg">
            {running ? <Loader2 size={12} className="cap-ic spin" /> : <CircleCheck size={12} className="cap-ic ok" />}
            <span>{done}/{rows.length}</span>
          </span>
        ) : null}
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </div>

      {/* 13 分支/提交侧弹浮层（ZCode 同款）：anchored 于胶囊左缘，backdrop 点击关闭；两弹层互斥 */}
      {branchOpen ? (
        <>
          <div className="cap-pop-backdrop" onClick={() => setBranchOpen(false)} />
          <div className="cap-pop branch-pop">
            <div className="cap-pop-head">
              <span>分支</span>
              <button className="cap-pop-close" onClick={() => setBranchOpen(false)} title="关闭">✕</button>
            </div>
            <div className="cap-pop-create">
              <input
                value={newBranch}
                placeholder="创建并检出新分支…"
                onChange={(e) => setNewBranch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newBranch.trim()) { void doCheckout(newBranch.trim(), true); setBranchQuery(''); }
                  if (e.key === 'Escape') setBranchOpen(false);
                }}
              />
              <button disabled={!newBranch.trim()} onClick={() => { if (newBranch.trim()) { void doCheckout(newBranch.trim(), true); setBranchQuery(''); } }}>创建</button>
            </div>
            <input
              className="cap-pop-search"
              placeholder="搜索分支…"
              value={branchQuery}
              onChange={(e) => setBranchQuery(e.target.value)}
            />
            {branchLoading ? <div className="cap-more">（加载中…）</div> : null}
            {branchInfo ? (
              <div className="cap-pop-scroll">
                <div className="cap-pop-group">当前分支</div>
                <div className="cap-branch-item current"><span>✓ {branchInfo.current}</span></div>
                {localOthers.length > 0 ? (
                  <>
                    <div className="cap-pop-group">本地分支</div>
                    {localOthers.map((b) => (
                      <div key={b} className="cap-branch-item" onClick={() => { void doCheckout(b, false); }}>
                        <span>{b}</span>
                        <span className="cap-branch-ops">
                          <button title={`合并 ${b} 到当前分支`} onClick={(e) => { e.stopPropagation(); void doMerge(b); }}>合并</button>
                          <button title={`将当前分支变基到 ${b}`} onClick={(e) => { e.stopPropagation(); void doRebase(b); }}>变基</button>
                        </span>
                      </div>
                    ))}
                  </>
                ) : null}
                {remoteList.length > 0 ? (
                  <>
                    <div className="cap-pop-group">远端（只读）</div>
                    {remoteList.map((b) => (
                      <div key={b} className="cap-branch-item remote-item" title="远端分支（只读）"><span>{b}</span></div>
                    ))}
                  </>
                ) : null}
              </div>
            ) : null}
            <div className="cap-pop-foot">
              <div className="cap-row cap-action" onClick={() => { setGraphOpen((v) => !v); if (!graphOpen && graphCommits.length === 0) loadGraph(); }}>
                <span>{graphOpen ? '收起图谱' : 'Git 图谱（最近 40 条）'}</span>
              </div>
              {graphOpen ? <div className="cap-graph-card"><GraphLane commits={graphCommits} /></div> : null}
              {noticeNode}
            </div>
          </div>
        </>
      ) : null}

      {/* 提交弹层（用户反馈：内嵌表单在 340px 胶囊里挤爆——升级为与分支面板同款侧弹层） */}
      {committing ? (
        <>
          <div className="cap-pop-backdrop" onClick={() => setCommitting(false)} />
          <div className="cap-pop commit-pop">
            <div className="cap-pop-head">
              <span>提交更改</span>
              <button className="cap-pop-close" onClick={() => setCommitting(false)} title="关闭">✕</button>
            </div>
            <div className="cap-pop-body">
              <div className="cap-commit-summary">
                <span>将提交 <b>{commitCount}</b> 个文件</span>
                <span className="dim">已暂存 {stagedCount} · 未暂存 {(git?.changed.length ?? 0) - stagedCount}</span>
              </div>
              <div className="cap-commit-row">
                <textarea
                  autoFocus
                  rows={3}
                  value={commitMsg}
                  placeholder="提交信息…（留空点 ✨ 自动生成）"
                  onChange={(e) => setCommitMsg(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitCommit(false);
                    if (e.key === 'Escape') setCommitting(false);
                  }}
                />
                <span className="cap-btn-wrap" title="AI 生成提交信息"><Sparkles size={14} className={suggesting ? 'cap-ic spin' : 'cap-btn'} onClick={() => { if (!suggesting) suggestMsg(); }} /></span>
              </div>
              <label className="cap-check">
                <input type="checkbox" checked={includeUnstaged} onChange={(e) => setIncludeUnstaged(e.target.checked)} />
                <span>包含未暂存的更改</span>
              </label>
              {pushRemotes.length > 0 ? (
                <div className="cap-commit-row">
                  <span className="cap-count">推送目标</span>
                  <select className="cap-select" value={pushRemote ?? ''} onChange={(e) => setPushRemote(e.target.value || null)}>
                    <option value="">（默认 upstream）</option>
                    {pushRemotes.map((r2) => <option key={r2} value={r2}>{r2}</option>)}
                  </select>
                </div>
              ) : null}
              <div className="cap-commit-actions">
                <button className="cap-primary" disabled={!canCommit} onClick={() => submitCommit(false)} title="Ctrl+↵">提交</button>
                <button disabled={!canCommit} onClick={() => submitCommit(true, pushRemote || undefined, undefined)}>提交并推送</button>
                <button onClick={() => doPush(pushRemote || undefined)} title="推送已有的本地提交（无需提交信息）">仅推送</button>
              </div>
              {commitCount === 0 ? <div className="cap-hint">无已暂存更改——勾选「包含未暂存的更改」后再提交</div> : null}
              {noticeNode}
            </div>
          </div>
        </>
      ) : null}

      {open ? (
        <div className="cap-panel">
          {showGit ? (
            <div className="cap-section">
              <div className="cap-head">
                <span>Git 工具</span>
                <span className="cap-head-tools">
                  <RefreshCw size={12} className="cap-btn" onClick={refresh} />
                </span>
              </div>
              <div className="cap-row cap-row-click" title={untrackedCount > 0 ? `在编辑区打开审查标签页（含 ${untrackedCount} 个新文件）` : '在编辑区打开审查标签页'} onClick={() => window.dispatchEvent(new CustomEvent('loomery:open-review', { detail: { root } }))}>
                <FilePlus size={13} />
                <span>更改</span>
                {git!.changed.length > 0 ? <span className="cap-count">{git!.changed.length}</span> : null}
                <span className="cap-delta">
                  <b className="added">+{git!.totalAdded}</b>
                  <b className="removed">−{git!.totalRemoved}</b>
                </span>
              </div>
              <div className="cap-row cap-row-click" onClick={() => {
                const next = !branchOpen;
                setBranchOpen(next);
                setCommitting(false);
                setNotice(null);
                setGraphOpen(false);
                if (next && !branchInfo) loadBranches();
              }}>
                <GitBranch size={12} />
                <span className="cap-branch">{git!.branch || 'HEAD'}</span>
                <span className="dim" style={{ fontSize: 11 }}>▾</span>
              </div>
              {git!.changed.length === 0 ? <div className="cap-more">工作区干净</div> : null}
              <div className="cap-row cap-action" onClick={() => {
                setCommitting(true);
                setBranchOpen(false);
                setGraphOpen(false);
                setNotice(null);
                if (root) {
                  void rpc
                    .call<{ current: string; remote: string[] }>(RPC.gitBranches, { root })
                    .then((bi) => setPushRemotes(Array.from(new Set(bi.remote.map((r2) => r2.split('/')[0]).filter((p): p is string => p !== undefined)))))
                    .catch(() => setPushRemotes([]));
                }
              }}>
                <GitCommitHorizontal size={12} />
                <span>{hasStaged ? '提交或推送…' : '提交（勾选包含未暂存）…'}</span>
              </div>
            </div>
          ) : null}

          <div className="cap-section">
            <div className="cap-head">
              <span>进程</span>
              {rows.length > 0 ? <span className="cap-count">{done}/{rows.length}</span> : null}
            </div>
            {rows.length === 0 ? (
              <div className="cap-more">（暂无任务进度——多步任务的步骤清单会显示在这里）</div>
            ) : (
              <>
                {done > 0 ? <div className="cap-done-head">‹ 已完成 {done} 项</div> : null}
                <div className="cap-steps">
                  {rows.slice(-14).map((r) => (
                    <div key={r.key} className={`cap-step ${r.status}`}>
                      <StatusIcon status={r.status} />
                      <span className="cap-step-title" title={r.title}>{r.title}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 13 图形化图谱：泳道简化布局（第一个 parent 继承泳道，merge 父开新道；40 commit/页） */
function GraphLane({ commits }: { commits: GraphCommitRow[] }): ReactElement {
  const laneOf = new Map<string, number>();
  const used = new Set<number>();
  const rows = commits.map((c) => {
    let lane = laneOf.get(c.sha);
    if (lane === undefined) {
      lane = 0;
      while (used.has(lane)) lane++;
    }
    used.add(lane);
    const [p0, p1] = c.parents;
    if (p0 && !laneOf.has(p0)) laneOf.set(p0, lane);
    if (p1 && !laneOf.has(p1)) laneOf.set(p1, lane + 1);
    if (p0) used.add(laneOf.get(p0) ?? lane);
    return { ...c, lane };
  });
  const LH = 22;
  const LW = 14;
  const height = rows.length * LH + 8;
  const maxLane = Math.max(0, ...rows.map((r) => r.lane));
  return (
    <div className="cap-graph-svg">
      <svg width={Math.min(60 + maxLane * LW + 300, 520)} height={height} style={{ display: 'block' }}>
        {rows.map((r, i) => {
          const y = i * LH + 14;
          const x = 10 + r.lane * LW;
          const parent = r.parents[0];
          const pi = parent ? rows.findIndex((c2) => c2.sha === parent) : -1;
          const edge = pi >= 0 && pi > i ? { x2: 10 + (rows[pi]?.lane ?? 0) * LW, y2: pi * LH + 14 } : null;
          return (
            <g key={r.sha}>
              {edge ? <line x1={x} y1={y} x2={edge.x2} y2={edge.y2} stroke="var(--border-strong)" strokeWidth={1.5} /> : null}
              <circle cx={x} cy={y} r={4.5} fill={r.refs ? 'var(--accent)' : 'var(--border-strong)'} stroke="var(--bg)" strokeWidth={1.5} />
              <text x={x + 10} y={y + 4} fontSize={11} fill="var(--text)" style={{ fontFamily: 'var(--mono)' }}>
                {r.subject.slice(0, 42)}
                {r.refs ? <tspan fill="var(--accent)" fontSize={10}> {r.refs}</tspan> : null}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

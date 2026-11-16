// V2 左栏：双模式侧栏——模式A 任务列表（默认）/ 模式B 项目文件树
import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react';
import { ArrowLeft, ArrowRight, Blocks, ChevronRight, File as FileIcon, FolderClosed, FolderInput, FolderOpen, ListFilter,
  FolderPlus, MoreHorizontal, Pin, Plus, Search, Settings, Trash2, UserRound } from 'lucide-react';
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';
import { rpc } from '@loomery/adapter-ipc-bridge/renderer';
import type { LoopEvent } from '@loomery/domain';
import { runtime, useRuntime } from '../../stores/runtime';
import { FileTypeIcon } from './FileTypeIcon';
import { insertToComposer, openInEditor } from '../../gateway/editorBus';
import appIcon from '../../assets/app-icon-64.png';
import type { ThreadRow } from '../../stores/runtime';

type TaskRow = ThreadRow;

function relativeTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m}分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时`;
  const d = Math.floor(h / 24);
  return `${d}天`;
}

function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
}

interface TreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  depth: number;
}

/** 由缩进文本行重建绝对路径（workspaceTree RPC 返回带两空格缩进的行） */
function parseTree(lines: string[], root: string): TreeEntry[] {
  const stack: { depth: number; path: string }[] = [{ depth: -1, path: root.replace(/[\\/]+$/, '') }];
  const out: TreeEntry[] = [];
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const depth = Math.floor((line.length - line.trimStart().length) / 2);
    while (stack.length > 1 && (stack[stack.length - 1]?.depth ?? -1) >= depth) stack.pop();
    const parent = stack[stack.length - 1];
    const isDir = trimmed.endsWith('/');
    const name = isDir ? trimmed.slice(0, -1) : trimmed;
    const path = `${parent?.path ?? root}\\${name}`;
    out.push({ name, path, isDir, depth });
    if (isDir) stack.push({ depth, path });
  }
  return out;
}

// 任务切换历史：模块级单例——侧栏收起后，聊天头栏渲染的 ←/→ 副本与侧栏内副本共用同一栈；
// 互换/焦点模式导致 Sidebar 重挂载时历史也不再丢失
const navState = { stack: [] as string[], idx: -1, navigating: false, version: 0 };
const navListeners = new Set<() => void>();
const bumpNav = (): void => {
  navState.version += 1;
  for (const l of navListeners) l();
};
const subscribeNav = (l: () => void): (() => void) => {
  navListeners.add(l);
  return () => { navListeners.delete(l); };
};
const openTaskInner = async (id: string): Promise<void> => {
  // ADR-0008：打开任务 = 事件重放（与实时流同一 reducer，状态天然一致）
  const events = await rpc.call<LoopEvent[]>(RPC.threadExport, { threadId: id });
  runtime.replayEvents(id, events);
  // 内核真相校正：重放无法区分"历史中断轮"（JSONL 无收尾事件，如强杀退出）与"进行中轮"，
  // 以 kernel busy 为准——否则被中断过的任务打开后永远卡在 running 态（发送/手动压缩等被误禁用）
  const list = await rpc.call<{ id: string; busy: boolean }[]>(RPC.threadList, {});
  if (list.find((t) => t.id === id)?.busy) return; // 确实进行中：保留重放出的 running 态
  runtime.set({ phase: 'idle', runningTurnAt: null, runningTurnId: null });
};
const navTo = async (dir: -1 | 1): Promise<void> => {
  const h = navState;
  const target = h.stack[h.idx + dir];
  if (!target) return;
  h.idx += dir;
  bumpNav();
  h.navigating = true;
  try {
    await openTaskInner(target);
  } finally {
    h.navigating = false;
  }
};

// 左上角三件套（logo + 后退/前进）：展开时驻左栏顶部，收起时移驻聊天头栏（同一组件两处渲染）。
// logo 点击 = 收起/展开左侧任务栏，悬浮 title 提示
export function SidebarNavCluster({ collapsed, onToggle }: { collapsed: boolean; onToggle?: () => void }): ReactElement {
  useSyncExternalStore(subscribeNav, () => navState.version);
  const canBack = navState.idx > 0;
  const canFwd = navState.idx < navState.stack.length - 1;
  return (
    <>
      <button className="logo logo-btn" title={collapsed ? '展开左侧任务栏' : '收起左侧任务栏'} onClick={() => onToggle?.()}>
        <img src={appIcon} alt="Loomery" draggable={false} />
      </button>
      <span className="nav-group">
        <button className="icon-btn" title="后退" disabled={!canBack} onClick={() => void navTo(-1)}><ArrowLeft size={15} /></button>
        <button className="icon-btn" title="前进" disabled={!canFwd} onClick={() => void navTo(1)}><ArrowRight size={15} /></button>
      </span>
    </>
  );
}

export function Sidebar({ onToggleSidebar }: { onToggleSidebar?: () => void }): ReactElement {
  const threads = useRuntime((s) => s.threads);
  const activeThreadId = useRuntime((s) => s.activeThreadId);
  const config = useRuntime((s) => s.config);
  const [mode, setMode] = useState<'tasks' | 'files'>(() => (localStorage.getItem('loomery.sidebarMode') as 'tasks' | 'files') ?? 'tasks');
  const [search, setSearch] = useState('');
  const [pinned, setPinned] = useState<string[]>(() => JSON.parse(localStorage.getItem('loomery.pinned') ?? '[]') as string[]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [menuRoot, setMenuRoot] = useState<string | null>(null);
  const [filesRoot, setFilesRoot] = useState('');
  const [filesModeSwitch, setFilesModeSwitch] = useState(false);
  const [renamingProject, setRenamingProject] = useState<{ root: string; text: string } | null>(null);
  const [moveMenuFor, setMoveMenuFor] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeEntry[]>([]);
  // 目录收起/展开：按目录绝对路径记录；渲染时把收起目录的后代整段过滤（localStorage 持久化，刷新保留）
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem('loomery.treeCollapsed') ?? '[]') as string[]));
  const toggleDir = (path: string): void => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      localStorage.setItem('loomery.treeCollapsed', JSON.stringify([...next]));
      return next;
    });
  };
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);



  const refresh = async (): Promise<void> => {
    const list = await rpc.call<ThreadRow[]>(RPC.threadList, {});
    runtime.set({ threads: list });
  };

  const openTask = async (id: string): Promise<void> => {
    await openTaskInner(id);
    if (navState.navigating) return;
    const h = navState;
    h.stack = [...h.stack.slice(0, h.idx + 1), id];
    h.idx = h.stack.length - 1;
    bumpNav();
  };

  const createTask = async (root?: string): Promise<void> => {
    window.dispatchEvent(new CustomEvent('loomery:close-all-tabs'));
    // 多项目：任务绑定其所属项目（工作区根），路径护栏/文件工具按线程归域
    const { threadId } = await rpc.call<{ threadId: string }>(RPC.threadCreate, { workspaceRoot: root ?? config?.workspaceRoots[0] });
    runtime.resetForThread(threadId, []);
    await refresh();
  };

  const refreshConfig = async (): Promise<void> => {
    const cfg = await rpc.call<typeof config>(RPC.configGet, {});
    runtime.set({ config: cfg });
  };
  const addProject = async (): Promise<void> => {
    await rpc.call(RPC.projectAdd, {}).catch(() => undefined);
    await refreshConfig();
  };
  const removeProject = async (root: string): Promise<void> => {
    await rpc.call(RPC.projectRemove, { path: root }).catch(() => undefined);
    await refreshConfig();
  };
  const renameProject = async (root: string, name: string): Promise<void> => {
    if (name.trim().length === 0) { setRenamingProject(null); return; }
    await rpc.call(RPC.projectRename, { path: root, name: name.trim() }).catch(() => undefined);
    setRenamingProject(null);
    await refreshConfig();
  };
  const moveTask = async (threadId: string, root: string): Promise<void> => {
    await rpc.call(RPC.threadMove, { threadId, workspaceRoot: root }).catch(() => undefined);
    setMoveMenuFor(null);
    await refresh();
  };

  const deleteTask = async (id: string): Promise<void> => {
    await rpc.call(RPC.threadDelete, { threadId: id });
    setPinned((p) => {
      const next = p.filter((x) => x !== id);
      localStorage.setItem('loomery.pinned', JSON.stringify(next));
      return next;
    });
    if (runtime.getState().activeThreadId === id) {
      runtime.set({ activeThreadId: null, items: [], phase: 'idle' });
    }
    setConfirmDelete(null);
    await refresh();
  };

  const togglePin = (id: string): void => {
    setPinned((p) => {
      const next = p.includes(id) ? p.filter((x) => x !== id) : [...p, id];
      localStorage.setItem('loomery.pinned', JSON.stringify(next));
      return next;
    });
  };

  // 双击任务标题重命名：提交经 thread.rename（落 threadTitleChanged，重启不再丢）
  const commitRename = async (): Promise<void> => {
    if (!renaming) return;
    const { id, text } = renaming;
    setRenaming(null);
    if (text.trim().length === 0) return;
    await rpc.call(RPC.threadRename, { threadId: id, title: text }).catch(() => undefined);
    await refresh();
  };

  const openFilesMode = async (root?: string): Promise<void> => {
    // 默认根解析：显式传入 > 当前活动任务的项目根（多项目）> 上次查看 > 首个根。
    // 此前无上下文入口（编辑器「文件」新标签等）直接回落 roots[0]——空项目打开会显示第一个项目的文件
    const st = runtime.getState();
    const activeRoot = st.threads.find((t) => t.id === st.activeThreadId)?.workspaceRoot;
    const target = root ?? activeRoot ?? filesRoot ?? config?.workspaceRoots[0] ?? '';
    const lines = await rpc.call<string[]>(RPC.workspaceTree, { path: target }).catch(() => []);
    setFilesRoot(target);
    setTree(parseTree(lines, target));
    setMode('files');
    localStorage.setItem('loomery.sidebarMode', 'files');
  };

  // 恢复到文件模式时自动加载目录树（重启/刷新场景）——同样以「上次查看的根」优先
  useEffect(() => {
    if (mode === 'files' && tree.length === 0 && config) {
      const st = runtime.getState();
      const activeRoot = st.threads.find((t) => t.id === st.activeThreadId)?.workspaceRoot;
      const target = filesRoot || activeRoot || config.workspaceRoots[0] || '';
      void rpc.call<string[]>(RPC.workspaceTree, { path: target }).then((lines) => setTree(parseTree(lines, target))).catch(() => undefined);
    }
  }, [mode, config, tree.length, filesRoot]);

  // 切换侧栏模式时清掉文件右键菜单（菜单只在文件树分支渲染，残留 state 会在任务列表里凭旧坐标弹出）
  useEffect(() => {
    setFileMenu(null);
  }, [mode]);

  // Ctrl+N 新建任务（全局快捷键，06 V2 交互规则）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void addProject();
      }
      if (e.key === 'Escape') {
        setMenuRoot(null);
        setFileMenu(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, []);

  const sortedTasks = useMemo(() => {
    const visible = threads.filter((t) => t.title.toLowerCase().includes(search.toLowerCase()));
    return [...visible].sort((a, b) => {
      const pa = pinned.includes(a.id) ? 0 : 1;
      const pb = pinned.includes(b.id) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return b.createdAt - a.createdAt;
    });
  }, [threads, search, pinned]);

  const renderTask = (t: TaskRow): ReactElement => {
    const isPinned = pinned.includes(t.id);
    const confirming = confirmDelete === t.id;
    return (
      <div key={t.id} className={`task-item ${t.id === activeThreadId ? 'active' : ''}`} onClick={() => void openTask(t.id)}>
        <span className="task-dot">{t.busy ? '●' : isPinned ? '⭐' : '○'}</span>
        {renaming?.id === t.id ? (
          <input
            className="task-rename"
            autoFocus
            value={renaming.text}
            title="Enter 确认 · Esc 取消"
            onChange={(e) => setRenaming({ id: t.id, text: e.target.value })}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void commitRename(); }
              else if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
            }}
            onBlur={() => void commitRename()}
          />
        ) : (
          <span
            className="task-title"
            title={`${t.title}（双击重命名）`}
            onDoubleClick={(e) => { e.stopPropagation(); setRenaming({ id: t.id, text: t.title }); }}
          >
            {t.title}
          </span>
        )}
        <span className="task-time">{relativeTime(t.createdAt)}</span>
        <span className="task-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" title={isPinned ? '取消置顶' : '置顶'} onClick={() => togglePin(t.id)}>
            <Pin size={13} />
          </button>
            <button
              className={`icon-btn ${moveMenuFor === t.id ? 'danger-active' : ''}`}
              title="移入其他项目"
              onClick={(e) => { e.stopPropagation(); setMoveMenuFor((v) => (v === t.id ? null : t.id)); }}
              onBlur={() => setTimeout(() => setMoveMenuFor((v) => (v === t.id ? null : v)), 150)}
            >
              <FolderInput size={13} />
            </button>
            <button
              className={`icon-btn ${confirming ? 'danger-active' : ''}`}
              title={confirming ? '再次点击确认删除' : '删除任务'}
              onClick={() => (confirming ? void deleteTask(t.id) : setConfirmDelete(t.id))}
              onBlur={() => setConfirmDelete(null)}
            >
              <Trash2 size={13} />
            </button>
          </span>
          {moveMenuFor === t.id ? (
            <div className="dropdown project-menu" onClick={(e) => e.stopPropagation()}>
              <div className="dd-section">移入项目</div>
              {projectGroups
                .filter((g) => g.root !== '__removed__' && g.root !== t.workspaceRoot)
                .map((g) => (
                  <button key={g.root} onMouseDown={() => void moveTask(t.id, g.root)}>
                    <FolderClosed size={13} /> {g.name}
                  </button>
                ))}
            </div>
          ) : null}
      </div>
    );
  };

  const projectNameOf = (root: string): string => config?.projectNames?.[root] ?? basename(root);
  // 多项目：项目 = 工作区根列表；线程按归属分组（无根旧任务归首项目；根被移除的任务进"已移除"组）
  const projects = config?.workspaceRoots ?? [];
  const projectGroups = useMemo(() => {
    const groups = projects.map((root) => ({ root, name: projectNameOf(root), tasks: [] as TaskRow[] }));
    const byRoot = new Map(groups.map((g) => [g.root, g]));
    const orphan = { root: '__removed__', name: '已移除的项目', tasks: [] as TaskRow[] };
    for (const t of sortedTasks) {
      const key = t.workspaceRoot ?? projects[0];
      const g = (key ? byRoot.get(key) : undefined) ?? orphan;
      g.tasks.push(t);
    }
    return orphan.tasks.length > 0 ? [...groups, orphan] : groups;
  }, [sortedTasks, projects]);

  // 收起目录的后代过滤：hideBelow=收起目录的深度，后续更深的行跳过，遇到同级/更浅即出子树
  const visibleTree = useMemo<TreeEntry[]>(() => {
    if (collapsedDirs.size === 0) return tree;
    const out: TreeEntry[] = [];
    let hideBelow = -1;
    for (const n of tree) {
      if (hideBelow >= 0) {
        if (n.depth > hideBelow) continue;
        hideBelow = -1;
      }
      out.push(n);
      if (n.isDir && collapsedDirs.has(n.path)) hideBelow = n.depth;
    }
    return out;
  }, [tree, collapsedDirs]);

  // 左栏监听：编辑器「＋打开文件」切到模式B
  useEffect(() => {
    const onOpenFiles = (): void => { void openFilesMode(); };
    window.addEventListener('loomery:open-files', onOpenFiles);
    return () => window.removeEventListener('loomery:open-files', onOpenFiles);
  }, [config]);


  if (mode === 'files') {
    return (
      <div className="sidebar">
        <div className="sidebar-top">
          <SidebarNavCluster collapsed={false} onToggle={onToggleSidebar} />
        </div>
        <div className="sidebar-files-head">
          <button className="icon-btn" title="返回任务列表" onClick={() => { setMode('tasks'); localStorage.setItem('loomery.sidebarMode', 'tasks'); }}>
            <ArrowLeft size={15} />
          </button>
          {filesModeSwitch ? (
            <div className="dropdown project-menu" style={{ top: 34, left: 8 }}>
              {(config?.workspaceRoots ?? []).map((root) => (
                <button key={root} onClick={() => { setFilesModeSwitch(false); void openFilesMode(root); }}>
                  <FolderClosed size={13} /> {config?.projectNames?.[root] ?? basename(root)}
                </button>
              ))}
            </div>
          ) : null}
          <span className="sidebar-project-name" style={{ cursor: 'pointer' }} title="点击切换项目" onClick={() => setFilesModeSwitch((v) => !v)}>
            <FolderOpen size={14} /> {projectNameOf(filesRoot || (config?.workspaceRoots[0] ?? '')) || '当前项目'} <ChevronRight size={12} style={{ transform: filesModeSwitch ? 'rotate(90deg)' : 'none', display: 'inline-flex' }} />
          </span>
        </div>
        <div className="sidebar-tree">
          {visibleTree.map((n) => (
            <div
              key={n.path}
              className={`tree-row ${n.isDir ? 'dir' : 'file'}`}
              style={{ paddingLeft: 8 + n.depth * 14, ['--d']: n.depth } as CSSProperties}
              data-depth={n.depth}
              onClick={() => {
                if (n.isDir) { toggleDir(n.path); return; }
                void openInEditor(n.path);
              }}
              onContextMenu={(e) => {
                if (n.isDir) return;
                e.preventDefault();
                // 钳制在视口内，避免菜单溢出窗口边缘
                setFileMenu({
                  x: Math.min(e.clientX, window.innerWidth - 190),
                  y: Math.min(e.clientY, window.innerHeight - 92),
                  path: n.path,
                });
              }}
              title={n.path}
            >
              <span className={`tree-chevron${n.isDir && !collapsedDirs.has(n.path) ? ' open' : ''}`}>
                {n.isDir ? <ChevronRight size={12} /> : null}
              </span>
              {n.isDir ? <FolderClosed size={14} /> : <FileTypeIcon name={n.name} />}
              <span className="tree-name">{n.name}</span>
            </div>
          ))}
          {tree.length === 0 ? <div className="empty-hint">（空目录）</div> : null}
        </div>
        {fileMenu ? (
          <>
            <div className="menu-backdrop" onClick={() => setFileMenu(null)} />
            <div className="dropdown" style={{ position: 'fixed', left: fileMenu.x, top: fileMenu.y, zIndex: 90 }}>
              <button onClick={() => { insertToComposer(fileMenu.path); setFileMenu(null); }}>
                引用到聊天框
              </button>
              <button onClick={() => { void openInEditor(fileMenu.path); setFileMenu(null); }}>
                在编辑器中打开
              </button>
            </div>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar-top">
        <SidebarNavCluster collapsed={false} onToggle={onToggleSidebar} />
      </div>
      <div className="sidebar-actions">
        <button className="action-item primary" onClick={() => void addProject()}>
          <FolderPlus size={16} /> <span>新建项目</span> <kbd>Ctrl+N</kbd>
        </button>
        <button className="action-item" title="插件市场（P2 提供）" disabled>
          <Blocks size={16} /> <span>插件市场</span>
        </button>
      </div>

      <div className="sidebar-list-head">
        <span>任务列表</span>
          <span className="head-tools" title="筛选（即将支持）">
            <Search size={14} className="tool-icon" />
            <input
              className="search-input"
              placeholder="搜索任务"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <ListFilter size={14} className="tool-icon" />
          </span>
      </div>

      <div className="sidebar-tasks">
        {projectGroups.map((g) => (
          <div key={g.root} className="project-group">
            <div className="project-row">
              <FolderClosed size={14} className="project-icon" />
              {renamingProject?.root === g.root ? (
                <input
                  className="task-rename"
                  autoFocus
                  value={renamingProject.text}
                  onChange={(e) => setRenamingProject({ root: g.root, text: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); void renameProject(g.root, renamingProject.text); }
                    else if (e.key === 'Escape') { e.preventDefault(); setRenamingProject(null); }
                  }}
                  onBlur={() => void renameProject(g.root, renamingProject.text)}
                />
              ) : (
                <span className="project-name" title={g.root}>{g.name}</span>
              )}
              <span className="project-actions">
                <button className="icon-btn" title="查看该项目文件" onClick={() => void openFilesMode(g.root)}>
                  <FileIcon size={13} />
                </button>
                <button className="icon-btn" title="在此项目下新建任务" onClick={() => void createTask(g.root)}>
                  <Plus size={13} />
                </button>
                <button className="icon-btn" title="更多" onClick={() => { setMenuRoot((v) => (v === g.root ? null : g.root)); }}>
                  <MoreHorizontal size={13} />
                </button>
              </span>
            </div>
            {menuRoot === g.root ? (
              <div className="dropdown project-menu">
                <button onClick={() => { setMenuRoot(null); void openFilesMode(g.root); }}>
                  <FolderClosed size={14} /> 查看该项目文件
                </button>
                <button onClick={() => { setMenuRoot(null); setRenamingProject({ root: g.root, text: g.name }); }}>
                  <MoreHorizontal size={14} /> 编辑项目名
                </button>
                {g.root === '__removed__' ? null : (
                  <button onClick={() => { setMenuRoot(null); void removeProject(g.root); }}>
                    <Trash2 size={14} /> 移除项目（任务保留）
                  </button>
                )}
              </div>
            ) : null}
            {g.tasks.length === 0 ? <div className="empty-hint">该项目还没有任务</div> : null}
            {g.tasks.map(renderTask)}
          </div>
        ))}

      </div>

      <div className="sidebar-foot">
        <span className="account"><UserRound size={15} /> 本地账户</span>
        <span className="foot-tools">
          <span title="设置" onClick={() => window.dispatchEvent(new CustomEvent('loomery:open-settings'))}><Settings size={15} className="tool-icon" /></span>
        </span>
      </div>
    </div>
  );
}


// 12 §F2.3 TerminalPanel：ChatPanel 内嵌终端（多 tab + 拖拽高度 + 编码无害化）
// 数据面：CHANNELS.terminalData/terminalExit 推送；控制面：terminal.* RPC
// 不过审批管道（用户领土）；高度持久化 localStorage（与 App.tsx fracs 同模式）
// 每个会话独立宿主 div（xterm 实例一一对应）；ResizeObserver 统一处理拖拽/窗口/显隐后的 fit
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Plus, X } from 'lucide-react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';
import { rpc } from '@loomery/adapter-ipc-bridge/renderer';
import { useRuntime } from '../../stores/runtime';

export const TERMINAL_HEIGHT_KEY = 'loomery.terminal.height';

interface TermSession {
  term: Terminal;
  fit: FitAddon;
  ctxMenuBound?: boolean;
}

const HEIGHT_MIN = 120;
const HEIGHT_MAX_RATIO = 0.7;
export const TERMINAL_DEFAULT_HEIGHT = 240;

export function readStoredHeight(): number {
  const v = Number(localStorage.getItem(TERMINAL_HEIGHT_KEY));
  return Number.isFinite(v) && v >= HEIGHT_MIN ? v : TERMINAL_DEFAULT_HEIGHT;
}

function clampHeight(h: number, panelHeight: number): number {
  const max = Math.max(HEIGHT_MIN + 40, Math.floor(panelHeight * HEIGHT_MAX_RATIO));
  return Math.min(Math.max(Math.floor(h), HEIGHT_MIN), max);
}

/** xterm 主题与程序主题同源：CSS 变量 → 终端配色（用户要求背景与主题一致，不再黑块） */
function themeFromCss(): Partial<ITheme> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--bg-card', '#202028'),
    foreground: v('--text', '#d7d7de'),
    cursor: v('--accent', '#5b8cff'),
    cursorAccent: v('--bg', '#131316'),
    selectionBackground: v('--border-strong', '#3a3a45'),
    // ANSI 16 色板（与暗/亮主题均协调的 GitHub 风格模板）
    black: v('--border', '#2a2a33'),
    red: '#f85149', green: '#3fb950', yellow: '#d29922', blue: '#5b8cff',
    magenta: '#bc8cff', cyan: '#39c5cf', white: '#d7d7de',
    brightBlack: '#5c5c66', brightRed: '#ff7b72', brightGreen: '#7ee787', brightYellow: '#e3b341',
    brightBlue: '#79a8ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f0f5',
  };
}

function makeTerm(): TermSession {
  const term = new Terminal({
    fontFamily: 'Consolas, "Cascadia Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    allowTransparency: true, // theme.background 才能真正生效（此前 transparent 未开此项=黑块根因）
    theme: themeFromCss(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // 主题切换跟随：data-theme 属性变化时重建配色（终端释放时断开观察）
  const observer = new MutationObserver(() => {
    term.options.theme = themeFromCss();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const origDispose = term.dispose.bind(term);
  term.dispose = () => {
    observer.disconnect();
    origDispose();
  };
  return { term, fit };
}

export function TerminalPanel({
  visible,
  height,
  onResize,
  onCloseAll,
}: {
  /** 面板是否可见：首挂不可见时不创建会话（避免应用启动即起 PowerShell 进程） */
  visible: boolean;
  height: number;
  onResize: (h: number) => void;
  onCloseAll: () => void;
}): ReactElement {
  const config = useRuntime((s) => s.config);
  // 终端 cwd 跟随活动任务（多项目：任务属于哪个项目，终端就开在哪个项目根）
  const activeRoot = useRuntime((s) => s.threads.find((t) => t.id === s.activeThreadId)?.workspaceRoot);
  const taskRoot = activeRoot ?? config?.workspaceRoots[0];
  const [tabs, setTabs] = useState<{ id: string; label: string }[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const sessionsRef = useRef(new Map<string, TermSession>());
  const hostEls = useRef(new Map<string, HTMLDivElement>());
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  // 数据/退出订阅全程；卸载 = 彻底关闭（隐藏保活由父级 display 切换实现，不卸载）
  useEffect(() => {
    const sessions = sessionsRef.current;
    // reload 孤儿回收：F5 时旧 UI 的 unmount cleanup 不保证执行，main 侧 pty 会话残留——
    // 新 UI 无法接管其 xterm 状态，直接清掉再建新会话
    void rpc.call<{ id: string }[]>(RPC.terminalList, {}).then((list) => {
      for (const m of list ?? []) void rpc.call(RPC.terminalKill, { id: m.id }).catch(() => undefined);
    }).catch(() => undefined);
    const w = window.loomery;
    const onDataCb = (payload: { id: string; chunk: string }): void => {
      sessions.get(payload.id)?.term.write(payload.chunk);
    };
    const onExitCb = (payload: { id: string; exitCode: number }): void => {
      const s = sessions.get(payload.id);
      if (s) {
        s.term.write(`\r\n\x1b[2m[会话已退出，exit=${payload.exitCode}]\x1b[0m\r\n`);
        s.term.dispose();
        sessions.delete(payload.id);
      }
      setTabs((ts) => ts.filter((t) => t.id !== payload.id));
      setActiveId((cur) => (cur === payload.id ? null : cur));
    };
    const offData = w?.onTerminalData?.(onDataCb);
    const offExit = w?.onTerminalExit?.(onExitCb);
    return () => {
      offData?.();
      offExit?.();
      for (const [id, s] of sessions) {
        try {
          s.term.dispose();
        } catch { /* 已释放 */ }
        void rpc.call(RPC.terminalKill, { id }).catch(() => undefined);
      }
      sessions.clear();
    };
  }, []);

  const attach = (id: string, s: TermSession, attempt = 0): void => {
    requestAnimationFrame(() => {
      const host = hostEls.current.get(id);
      // 宿主未提交（React 渲染时序）或面板隐藏（display:none 下 open 出零尺寸 DOM）：帧级重试，超时留给 visible flush
      if (!host || host.offsetParent === null) {
        if (attempt < 120) attach(id, s, attempt + 1);
        return;
      }
      if (s.term.element) return;
      s.term.open(host);
      // 右键粘贴（宿主就绪后挂载；仅一次）
      if (!s.ctxMenuBound) {
        s.ctxMenuBound = true;
        host.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          void navigator.clipboard.readText().then((txt) => {
            if (txt) s.term.paste(txt);
          }).catch(() => undefined);
        });
      }
      try {
        s.fit.fit();
      } catch { /* 尺寸未就绪：ResizeObserver 会再触发 */ }
      void rpc.call(RPC.terminalResize, { id, cols: s.term.cols, rows: s.term.rows }).catch(() => undefined);
    });
  };

  const createSession = async (): Promise<void> => {
    const root = taskRoot;
    const meta = await rpc.call<{ id: string; shellName: string; cwd: string }>(RPC.terminalCreate, root ? { cwd: root } : {});
    const s = makeTerm();
    // 写合帧（16ms）：按住方向键等高频 onData 不再每键一个 RPC；顺序由单缓冲保证
    let acc = '';
    let flushing = false;
    s.term.onData((d) => {
      acc += d;
      if (flushing) return;
      flushing = true;
      setTimeout(() => {
        const payload = acc;
        acc = '';
        flushing = false;
        if (payload.length > 0) void rpc.call(RPC.terminalWrite, { id: meta.id, data: payload }).catch(() => undefined);
      }, 16);
    });
    // 右键粘贴 + Ctrl+Shift+C/V（xterm 默认不带终端惯例快捷键）
    s.term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === 'keydown' && ev.ctrlKey && ev.shiftKey && (ev.key === 'C' || ev.key === 'V')) {
        if (ev.key === 'V') {
          void navigator.clipboard.readText().then((txt) => {
            if (txt) s.term.paste(txt);
          }).catch(() => undefined);
        } else {
          const sel = s.term.getSelection();
          if (sel) void navigator.clipboard.writeText(sel).catch(() => undefined);
        }
        return false;
      }
      return true;
    });
    sessionsRef.current.set(meta.id, s);
    setTabs((ts) => {
      // tab 名用实际生效 cwd（main 兜底可能不同于 UI 传入值；修"PowerShell · PowerShell"）
      const dirSource = meta.cwd || root || meta.shellName;
      const dirName = dirSource.slice(Math.max(dirSource.lastIndexOf('/'), dirSource.lastIndexOf('\\')) + 1) || meta.shellName;
      const label = `${meta.shellName} · ${dirName}`;
      return [...ts, { id: meta.id, label }];
    });
    setActiveId(meta.id);
    attach(meta.id, s);
  };

  // 切换项目任务 → 活动终端同步 cd 到新根（用户定稿；仅活动 tab——其他 tab 用户手动 cd 过，尊重不动）
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const prevRootRef = useRef<string | undefined>(null);
  useEffect(() => {
    const first = prevRootRef.current === null;
    prevRootRef.current = taskRoot;
    if (first || !taskRoot) return; // 首跑只记录（创建时已用新根）
    const id = activeIdRef.current;
    if (!id || !sessionsRef.current.has(id)) return; // 终端未开：下次创建自然用新根
    void rpc.call(RPC.terminalWrite, { id, data: `cd "${taskRoot}"\r` }).catch(() => undefined);
    setTabs((ts) => ts.map((x) => {
      if (x.id !== id) return x;
      const shell = x.label.split(' · ')[0];
      return { ...x, label: `${shell} · ${taskRoot.slice(Math.max(taskRoot.lastIndexOf('/'), taskRoot.lastIndexOf('\\')) + 1)}` };
    }));
  }, [taskRoot]);

  // 会话创建由 visible 驱动：首开创建，隐藏保活，关光再开重建（用户显式意图）
  const creatingRef = useRef(false);
  useEffect(() => {
    if (!visible || creatingRef.current || sessionsRef.current.size > 0) return;
    creatingRef.current = true;
    void createSession()
      .catch(() => undefined)
      .then(() => {
        creatingRef.current = false;
      });
  }, [visible]);

  // 展开（或宿主就绪）时 flush 未挂载的会话（隐藏期创建的 term 在展开瞬间补 open+fit）
  useEffect(() => {
    if (!visible) return;
    for (const [id, s] of sessionsRef.current) {
      if (!s.term.element) attach(id, s);
    }
  }, [visible, tabs.length]);

  // 尺寸自适应（拖拽/窗口/显隐统一入口）
  // PTY resize 去抖 250ms：ConPTY 每次 resize 都会让 PowerShell 重绘一行提示符——
  // 拖拽中逐像素 resize = 提示符堆积（实证）；xterm 本地 fit 实时，PTY 尺寸拖拽结束一次到位
  const resizeTimerRef = useRef<number | null>(null);
  const lastSentRef = useRef<{ cols: number; rows: number } | null>(null);
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const id = activeRef.current;
      const s = id ? sessionsRef.current.get(id) : undefined;
      if (!s || !s.term.element) return;
      try {
        s.fit.fit();
      } catch { /* 隐藏中尺寸 0：跳过 */ }
      if (s.term.element.offsetHeight > 0) {
        if (resizeTimerRef.current !== null) clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = window.setTimeout(() => {
          resizeTimerRef.current = null;
          const cols = s.term.cols;
          const rows = s.term.rows;
          const last = lastSentRef.current;
          if (last && last.cols === cols && last.rows === rows) return; // 尺寸未变不通知
          lastSentRef.current = { cols, rows };
          void rpc.call(RPC.terminalResize, { id, cols, rows }).catch(() => undefined);
        }, 250);
      }
    });
    if (hostEls.current.size > 0) for (const [, el] of hostEls.current) ro.observe(el);
    // host 数随 tab 变化：观察一个 wrapper 即可——用父容器（.term-hosts）
    return () => {
      ro.disconnect();
      if (resizeTimerRef.current !== null) clearTimeout(resizeTimerRef.current);
    };
  }, [tabs.length]);

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault();
    document.body.classList.add('dragging');
    const onMove = (me: MouseEvent): void => {
      const wrap = wrapRef.current?.closest('.chat-panel') as HTMLElement | null;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      onResize(clampHeight(rect.bottom - me.clientY, rect.height));
    };
    const onUp = (): void => {
      document.body.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const closeTab = (id: string): void => {
    void rpc.call(RPC.terminalKill, { id }).catch(() => undefined);
    const s = sessionsRef.current.get(id);
    if (s) {
      s.term.dispose();
      sessionsRef.current.delete(id);
    }
    setTabs((ts) => ts.filter((t) => t.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
  };

  const switchTab = (id: string): void => {
    setActiveId(id);
    const s = sessionsRef.current.get(id);
    if (s) {
      requestAnimationFrame(() => {
        try {
          s.fit.fit();
        } catch { /* 未挂载 */ }
        if (s.term.element) {
          void rpc.call(RPC.terminalResize, { id, cols: s.term.cols, rows: s.term.rows }).catch(() => undefined);
        }
      });
    }
  };

  return (
    <div ref={wrapRef} className="terminal-panel" style={{ height }}>
      <div className="term-drag-handle" onMouseDown={startDrag} onDoubleClick={() => onResize(TERMINAL_DEFAULT_HEIGHT)} title="拖拽调高 · 双击复位" />
      <div className="term-tabbar">
        <span className="term-prefix">终端</span>
        {tabs.map((t) => (
          <span key={t.id} className={`term-tab ${t.id === activeId ? 'active' : ''}`} onClick={() => switchTab(t.id)}>
            <span>{t.label}</span>
            <X
              size={13}
              className="term-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            />
          </span>
        ))}
        <span className="term-tabbar-spacer" />
        <span className="term-action-wrap" title="新建终端"><Plus size={15} className="term-action" onClick={() => void createSession().catch(() => undefined)} /></span>
        <span className="term-action-wrap" title="关闭终端面板"><X size={15} className="term-action" onClick={onCloseAll} /></span>
      </div>
      <div className="term-hosts">
        {tabs.map((t) => (
          <div
            key={t.id}
            ref={(el) => {
              if (el) hostEls.current.set(t.id, el);
              else hostEls.current.delete(t.id);
            }}
            className={`term-host ${t.id === activeId ? '' : 'hidden-term'}`}
          />
        ))}
      </div>
    </div>
  );
}

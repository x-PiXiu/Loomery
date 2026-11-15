// Viewer 注册表（UI 层扩展点，与内核 ToolRegistry 对称）：文件类型 → 渲染组件。
// 新增显示类型 = 在本文件追加一个组件 + 一条注册，EditorArea 核心零改动。
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { rpc } from '@loomery/adapter-ipc-bridge/renderer';
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';
import { registerPageProvider, unregisterPageProvider } from '../../gateway/editorBus';

interface ReviewFileRow { path: string; status: string; added: number; removed: number; binary?: boolean }

// Electron <webview> 标签（TS 无内置 JSX 定义）：double-cast 成任意属性组件，属性运行时透传
const WebView = 'webview' as unknown as React.FC<Record<string, string | boolean | undefined>>;

export interface ViewerProps {
  path: string;
  /** 文本类 viewer 使用 */
  content?: string;
  /** 二进制类 viewer 使用（fsReadFile binary 分支返回，cap 512KB） */
  base64?: string;
  /** 原始字节数（binary 分支） */
  size?: number;
  /** 截断标记 */
  truncated?: boolean;
  /** browser 条目：初始 URL */
  url?: string;
  /** review 条目：初始筛选模式（worktree/staged/all/lastTurn） */
  reviewMode?: string;
}

type ViewerComponent = (props: ViewerProps) => ReactElement;
const registry = new Map<string, ViewerComponent>();

export function registerViewer(kind: string, comp: ViewerComponent): void {
  registry.set(kind, comp);
}

export function getViewer(kind: string): ViewerComponent | undefined {
  return registry.get(kind);
}

// ---------- Hex 查看器：offset | 16 字节 hex | ASCII，显示前 16KB ----------
function HexViewer({ base64, size, truncated }: ViewerProps): ReactElement {
  const bytes = useMemo(() => {
    if (!base64) return new Uint8Array();
    const bin = atob(base64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }, [base64]);
  const SHOW = 16 * 1024;
  const shown = bytes.subarray(0, SHOW);
  const rows: ReactElement[] = [];
  for (let off = 0; off < shown.length; off += 16) {
    const chunk = shown.subarray(off, off + 16);
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...chunk].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    rows.push(
      <div key={off} className="hex-row">
        <span className="hex-off">{off.toString(16).padStart(8, '0')}</span>
        <span className="hex-bytes">{hex}</span>
        <span className="hex-ascii">{ascii}</span>
      </div>,
    );
  }
  return (
    <div className="viewer-shell">
      <div className="viewer-toolbar">
        二进制 · {size ?? bytes.length} 字节{truncated ? '（仅载入前 512KB）' : ''}
        {bytes.length > SHOW ? ` · 显示前 ${SHOW / 1024}KB` : ''}
      </div>
      <div className="hex-view">{rows}</div>
    </div>
  );
}

// ---------- CSV/TSV 表格视图：首行表头，cap 500 行 ----------
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const CSV_ROWS_CAP = 500;

function CsvViewer({ content, path }: ViewerProps): ReactElement {
  const { rows, capped } = useMemo(() => {
    const delimiter = path.toLowerCase().endsWith('.tsv') ? '\t' : ((content?.split('\n')[0]?.match(/\t/g)?.length ?? 0) > (content?.split('\n')[0]?.match(/,/g)?.length ?? 0) ? '\t' : ',');
    const all = parseCsv(content ?? '', delimiter);
    return { rows: all.slice(0, CSV_ROWS_CAP), capped: all.length > CSV_ROWS_CAP };
  }, [content, path]);
  const [head, ...body] = rows;
  return (
    <div className="viewer-shell">
      <div className="viewer-toolbar">
        表格 · {body.length} 行{capped ? `（仅显示前 ${CSV_ROWS_CAP} 行）` : ''}
      </div>
      <div className="csv-view">
        <table>
          <thead>
            <tr>{(head ?? []).map((h, i) => <th key={i}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {body.map((r, ri) => (
              <tr key={ri}>{(head ?? []).map((_, ci) => <td key={ci}>{r[ci] ?? ''}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- HTML 预览：app-file 协议从磁盘真实加载（相对路径 css/js/图片生效） + 源码切换 ----------
// srcDoc 是 opaque origin，相对路径资源全部断链（实证：带 css 的网页预览成裸文本）——
// 改用 app-file:// 让 Chromium 按目录解析资源；脚本与样式在用户领土内由用户自负
function HtmlViewer({ path, content }: ViewerProps): ReactElement {
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [nonce, setNonce] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [navTarget, setNavTarget] = useState<string | null>(null);
  const src = useMemo(
    () => `app-file://local/${encodeURIComponent(navTarget ?? path)}?t=${nonce}`,
    [path, navTarget, nonce],
  );
  // agent 控制（preview_control 工具 → gateway → CustomEvent）：刷新/导航
  useEffect(() => {
    const onReload = (ev: Event): void => {
      const p = (ev as CustomEvent<{ path: string }>).detail?.path;
      if (!p || p === '*' || p === path) setNonce((n) => n + 1);
    };
    const onNavigate = (ev: Event): void => {
      const d = (ev as CustomEvent<{ path: string; target: string }>).detail;
      if (!d) return;
      // target 为工作区内相对路径 → 解析到同目录
      const base = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
      const t = d.target;
      const isAbs = t.startsWith('/') || (t.length >= 2 && t[1] === ':');
      const resolved = isAbs ? t : base + '/' + (t.startsWith('/') ? t.slice(1) : t);
      if (resolved === path) setNonce((n) => n + 1);
      else setNavTarget(resolved);
    };
    window.addEventListener('loomery:preview-reload', onReload);
    window.addEventListener('loomery:preview-navigate', onNavigate);
    return () => {
      window.removeEventListener('loomery:preview-reload', onReload);
      window.removeEventListener('loomery:preview-navigate', onNavigate);
    };
  }, [path]);

  // 2026-11-13 P0③ 自动跟随：watcher 文件变更 → 防抖 400ms reload（用户看预览时永远是最新版）
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onFilesChanged = (ev: Event): void => {
      const paths = (ev as CustomEvent<{ paths: string[] }>).detail?.paths ?? [];
      if (!paths.includes(path)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setNonce((n) => n + 1), 400);
    };
    window.addEventListener('loomery:files-changed', onFilesChanged);
    return () => {
      window.removeEventListener('loomery:files-changed', onFilesChanged);
      if (timer) clearTimeout(timer);
    };
  }, [path]);

  // 2026-11-13 P0②：页面文本提取注册（iframe 跨域 → 注入 hook 的 postMessage 应答，1.5s 超时置空）
  useEffect(() => {
    const key = 'app-file://local/' + encodeURIComponent(navTarget ?? path);
    registerPageProvider(key, {
      getText: () => {
      const w = iframeRef.current?.contentWindow;
      if (!w) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        const reqId = 'txt_' + Math.random().toString(36).slice(2, 8);
        const onText = (ev: MessageEvent): void => {
          const d = ev.data as { type?: string; reqId?: string; text?: string };
          if (d?.type === 'loomery-page-text' && d.reqId === reqId) {
            window.removeEventListener('message', onText);
            resolve(typeof d.text === 'string' && d.text.trim().length > 0 ? d.text.slice(0, 8000) : null);
          }
        };
        window.addEventListener('message', onText);
        w.postMessage({ type: 'loomery-get-text', reqId }, '*');
        window.setTimeout(() => {
          window.removeEventListener('message', onText);
          resolve(null);
        }, 1500);
      });
      },
    });
    return () => unregisterPageProvider(key);
  }, [path, navTarget]);

  return (
    <div className="viewer-shell">
      <div className="viewer-toolbar">
        <button className={mode === 'preview' ? 'on' : ''} onClick={() => setMode('preview')}>预览</button>
        <button className={mode === 'source' ? 'on' : ''} onClick={() => setMode('source')}>源码</button>
        <button title="重新加载（agent 改完文件后自动刷新，也可手动）" onClick={() => setNonce((n) => n + 1)}>↻ 刷新</button>
        <button title="在浏览器标签中打开（完整浏览器行为）" onClick={() => window.dispatchEvent(new CustomEvent('loomery:open-browser', { detail: { url: `app-file://local/${encodeURIComponent(path)}` } }))}>🌐 浏览器标签</button>
        <span className="viewer-note">沙箱预览 · 相对路径资源已生效 · 保存后自动刷新</span>
      </div>
      {mode === 'preview' ? (
        <iframe
          key={nonce}
          ref={iframeRef}
          className="html-preview"
          sandbox="allow-scripts allow-forms allow-modals"
          src={src}
          title="HTML 预览"
        />
      ) : (
        <pre className="html-source">{content}</pre>
      )}
    </div>
  );
}

// ---------- PDF：app-pdf 特权协议 → 主进程流式供给 → Chromium 内建 pdf 引擎渲染 ----------
// 大文件不占 IPC（16MB RPC 上限扛不住真实 PDF），协议句柄在主进程做领土校验
function PdfViewer({ path }: ViewerProps): ReactElement {
  const src = useMemo(() => `app-pdf://local/${encodeURIComponent(path)}`, [path]);
  return (
    <div className="viewer-shell">
      <div className="viewer-toolbar">PDF · 流式加载（app-pdf 协议，无大小上限）</div>
      <iframe className="pdf-preview" src={src} title="PDF 预览" />
    </div>
  );
}

registerViewer('hex', HexViewer);
registerViewer('csv', CsvViewer);
// ---------- 内置浏览器标签：Electron webview（ZCode 同款） ----------
// Electron 本身就是 Chromium——webview 是独立会话的完整浏览器视口；
// 安全：main 侧 web-contents-created 钩子剥离 nodeIntegration/preload，弹窗重定向外部浏览器
/** 最小 webview 形状（ui 包无 electron 类型；真实行为由 Electron 运行时提供） */
interface WvLike {
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  isLoading(): boolean;
  addEventListener(type: string, cb: (ev: { url: string }) => void): void;
  removeEventListener(type: string, cb: (ev: { url: string }) => void): void;
  executeJavaScript(code: string): Promise<unknown>;
  sendInputEvent(input: { type: string; x: number; y: number }): void;
}

const BROWSER_HOME = 'about:blank';

function BrowserViewer({ url: initialUrl }: ViewerProps): ReactElement {
  const wvRef = useRef<WvLike | null>(null);
  const [addr, setAddr] = useState(initialUrl ?? BROWSER_HOME);
  const [current, setCurrent] = useState(initialUrl ?? BROWSER_HOME);
  const entryUrl = initialUrl ?? BROWSER_HOME;

  // entry.url 变化（如从 HtmlViewer"浏览器打开"换 URL）→ 加载新地址
  useEffect(() => {
    if (initialUrl && initialUrl !== current) void wvRef.current?.loadURL(initialUrl).catch(() => undefined);
  }, [initialUrl]);

  useEffect(() => {
    const wv = wvRef.current;
    if (!wv) return;
    const onNav = (ev: { url: string }): void => {
      setCurrent(ev.url);
      setAddr(ev.url);
    };
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-navigate-in-page', onNav);
    return () => {
      wv.removeEventListener('did-navigate', onNav);
      wv.removeEventListener('did-navigate-in-page', onNav);
    };
  }, []);

  // 2026-11-13 P0②/P2：页面 handle 注册（文本提取 + 页面级 JS + 截图——browser_control 经网关调用）
  useEffect(() => {
    const key = 'browser:' + (initialUrl ?? BROWSER_HOME);
    registerPageProvider(key, {
      getText: async () => {
        try {
          const text = await wvRef.current?.executeJavaScript('document.body ? document.body.innerText : ""');
          return typeof text === 'string' && text.length > 0 ? text.slice(0, 8000) : null;
        } catch {
          return null;
        }
      },
      runJs: async (code) => {
        try {
          return await wvRef.current?.executeJavaScript(code);
        } catch {
          return undefined;
        }
      },
      hover: async (x, y) => {
        wvRef.current?.sendInputEvent({ type: 'mouseMove', x, y });
      },
      capture: async (rect) => {
        try {
          interface NativeImageLike {
            resize(o: { width: number }): NativeImageLike;
            toDataURL(o?: { type?: string; quality?: number }): string;
            getSize(): { width: number; height: number };
          }
          const wv = wvRef.current as unknown as { capturePage: (q?: number[]) => Promise<NativeImageLike | undefined> } | null;
          const img = await wv?.capturePage(rect ? [rect.x, rect.y, rect.width, rect.height] : undefined);
          if (!img) return null;
          const size = img.getSize();
          const finalImg = size.width > 1280 ? img.resize({ width: 1280 }) : img;
          const dataUrl = finalImg.toDataURL({ type: 'jpeg', quality: 70 });
          const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
          const finalSize = finalImg.getSize();
          return { mime: 'image/jpeg', base64, width: finalSize.width, height: finalSize.height };
        } catch {
          return null;
        }
      },
    });
    return () => unregisterPageProvider(key);
  }, [initialUrl]);

  const go = (raw: string): void => {
    let target = raw.trim();
    if (!target) return;
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
    const looksDomain = /^([\w-]+\.)+[a-z]{2,}(:\d+)?(\/|$)/i.test(target) || target.startsWith('localhost') || target.startsWith('app-file:');
    if (!hasScheme && !looksDomain) target = 'https://www.bing.com/search?q=' + encodeURIComponent(target);
    else if (!hasScheme && !target.startsWith('app-file:')) target = 'https://' + target;
    void wvRef.current?.loadURL(target).catch(() => undefined);
  };

  return (
    <div className="viewer-shell browser-view">
      <div className="viewer-toolbar browser-bar">
        <button title="后退" onClick={() => wvRef.current?.goBack()}>‹</button>
        <button title="前进" onClick={() => wvRef.current?.goForward()}>›</button>
        <button title="刷新 / 停止" onClick={() => (wvRef.current?.isLoading() ? wvRef.current?.stop() : wvRef.current?.reload())}>↻</button>
        <button title="主页" onClick={() => go('about:blank')}>⌂</button>
        <input
          className="browser-addr"
          value={addr}
          spellCheck={false}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go(addr);
          }}
          placeholder="输入网址后回车"
        />
        {current.startsWith('http') ? <button title="在系统浏览器打开" onClick={() => void rpc.call('window.openExternal', { url: current }).catch(() => undefined)}>↗</button> : null}
      </div>
      <WebView ref={wvRef as never} src={entryUrl} className="browser-wv" partition="persist:browser-tab" />
    </div>
  );
}

registerViewer('html', HtmlViewer);
// ---------- 审查标签页（13 git 套件）：筛选 + 文件列表 + 行内 diff 展开 ----------
const REVIEW_MODES: { id: string; label: string }[] = [
  { id: 'worktree', label: '未暂存' },
  { id: 'staged', label: '已暂存' },
  { id: 'all', label: '全部分支更改' },
  { id: 'lastTurn', label: '上一轮更改' },
];

function ReviewPane({ path, reviewMode }: ViewerProps): ReactElement {
  const root = path.startsWith('review:') ? path.slice('review:'.length) : path;
  const [mode, setMode] = useState(reviewMode ?? 'worktree');
  const [menuOpen, setMenuOpen] = useState(false);
  const [files, setFiles] = useState<ReviewFileRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, { text: string; truncated: boolean } | 'loading'>>({});

  const refresh = (): void => {
    void rpc.call<ReviewFileRow[]>(RPC.gitReviewList, { root, mode }).then((list) => {
      setFiles(list ?? []);
      setLoaded(true);
      setExpanded({});
    }).catch(() => {
      setFiles([]);
      setLoaded(true);
    });
  };

  useEffect(() => {
    refresh();
  }, [mode, root]);

  const toggleFile = (f: ReviewFileRow): void => {
    if (expanded[f.path]) {
      setExpanded((e) => { const n = { ...e }; delete n[f.path]; return n; });
      return;
    }
    setExpanded((e) => ({ ...e, [f.path]: 'loading' }));
    void rpc.call<{ text: string; truncated: boolean }>(RPC.gitFileDiff, { root, path: f.path, mode }).then((d) => {
      setExpanded((e) => ({ ...e, [f.path]: d }));
    }).catch(() => setExpanded((e) => ({ ...e, [f.path]: { text: '（加载失败）', truncated: false } })));
  };

  const [notice, setNotice] = useState<string | null>(null);
  const stageToggle = (f: ReviewFileRow): void => {
    const rpcName = mode === 'staged' ? RPC.gitUnstage : RPC.gitAdd;
    void rpc.call<{ ok: boolean; error?: string }>(rpcName, { root, files: [f.path] }).then((r) => {
      if (!r.ok) setNotice(r.error ?? '操作失败');
      refresh();
    }).catch(() => refresh());
  };

  const statusColor = (st: string): string => (st === '?' || st === 'A' ? 'ok' : st === 'D' || st === 'deleted' ? 'err' : 'mod');

  return (
    <div className="viewer-shell review-view">
      <div className="viewer-toolbar review-bar">
        <button onClick={() => setMenuOpen((v) => !v)}>
          {REVIEW_MODES.find((m) => m.id === mode)?.label ?? '未暂存'} ▾
        </button>
        {menuOpen ? (
          <div className="review-menu">
            {REVIEW_MODES.map((m) => (
              <button key={m.id} className={m.id === mode ? 'on' : ''} onClick={() => { setMode(m.id); setMenuOpen(false); }}>{m.label}</button>
            ))}
          </div>
        ) : null}
        <span className="review-spacer" />
        {loaded && files.length > 0 ? <span className="review-count">{files.length} 个文件</span> : null}
        <button title="刷新" onClick={refresh}>↻ 刷新</button>
      </div>
      <div className="review-list">
        {notice ? <div className="review-notice">{notice}</div> : null}
        {loaded && files.length === 0 ? <div className="review-empty">（该筛选下没有更改）</div> : null}
        {files.map((f) => (
          <div key={f.path} className="review-file">
            <div className="review-file-row" onClick={() => toggleFile(f)}>
              <span className={`rv-st ${statusColor(f.status)}`}>{f.status}</span>
              <span className="rv-name">{f.path.split(/[\\/]/).pop()}</span>
              <span className="rv-dir">{f.path.slice(0, Math.max(f.path.lastIndexOf('/'), f.path.lastIndexOf('\\')) + 1)}</span>
              <span className="cap-delta"><b className="added">+{f.added}</b> <b className="removed">−{f.removed}</b></span>
              <button
                className="rv-stage"
                title={mode === 'staged' ? '取消暂存（保留工作区内容）' : '暂存此文件'}
                onClick={(e) => { e.stopPropagation(); void stageToggle(f); }}
              >
                {mode === 'staged' ? '取消暂存' : '暂存'}
              </button>
              <span className={`rv-chevron ${expanded[f.path] ? 'open' : ''}`}>∨</span>
            </div>
            {expanded[f.path] && expanded[f.path] !== 'loading' ? (
              <pre className="review-diff">
                {(expanded[f.path] as { text: string }).text.split('\n').map((line, i) => (
                  <div key={i} className={line.startsWith('+') ? 'dl-add' : line.startsWith('-') ? 'dl-del' : line.startsWith('@@') ? 'dl-hunk' : 'dl-ctx'}>{line}</div>
                ))}
                {(expanded[f.path] as { truncated: boolean }).truncated ? <div className="dl-hunk">（差异过长已截断——可在编辑器打开文件查看完整内容）</div> : null}
              </pre>
            ) : null}
            {expanded[f.path] === 'loading' ? <pre className="review-diff">（加载中…）</pre> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

registerViewer('html', HtmlViewer);
registerViewer('browser', BrowserViewer);
registerViewer('review', ReviewPane);
registerViewer('pdf', PdfViewer);

/** kind → viewer 组件（EditorArea 渲染分支用） */
export function viewerFor(kind: string): ViewerComponent | undefined {
  return getViewer(kind);
}

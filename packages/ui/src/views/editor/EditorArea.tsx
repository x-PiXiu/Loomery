// V2.1 右列：标签页 + 面包屑 + Monaco/图片预览 + Ctrl+S + 外部修改刷新
import { useEffect, useRef, useState, type ReactElement } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Columns2, Copy, GitCompare, ExternalLink, Eye, MoreHorizontal, X, ChevronsDown, File as FileIcon, FileCode2, FileText, FolderClosed, Globe, Image as ImageIcon, Maximize2, PictureInPicture2, Plus, Search, GitPullRequest, Terminal } from 'lucide-react';
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';
import { bridge, rpc } from '@loomery/adapter-ipc-bridge/renderer';
import { emitEnvEvent } from '@loomery/adapter-editor-gateway/renderer';
import type { Diagnostic } from '@loomery/domain';
import { monaco } from '../../monaco-setup';
import { insertToComposer, registerBrowserOpener, registerDiffOpener, registerEditorOpener, takePendingOpen, unregisterBrowserOpener, unregisterDiffOpener, unregisterEditorOpener, requestTerminalShow } from '../../gateway/editorBus';
import { viewerFor } from './viewers';
import { notifyTabsCount } from '../../gateway/editorBus';
import { emitEnvironment, setEditorHooksProvider, setFileReloadHandler } from '../../gateway/mount';
import { balanceFences } from '../../utils/markdown';
import { WinControls } from '../common/WinControls';
import { useRuntime } from '../../stores/runtime';

function langOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    // 脚本/前端
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    vue: 'html', svelte: 'html',
    css: 'css', scss: 'scss', less: 'less', sass: 'scss',
    html: 'html', htm: 'html', xml: 'xml', svg: 'xml', xsl: 'xml', vue2: 'html',
    json: 'json', jsonc: 'json', json5: 'json',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', env: 'ini',
    // 系统/后端
    py: 'python', pyi: 'python', pyw: 'python',
    go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
    cs: 'csharp', php: 'php', rb: 'ruby', swift: 'swift', m: 'objective-c', mm: 'objective-cpp',
    dart: 'dart', lua: 'lua', pl: 'perl', pm: 'perl', r: 'r', jl: 'julia',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'powershell', bat: 'bat', cmd: 'bat',
    sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf', pb: 'protobuf', hcl: 'hcl', tf: 'hcl', tfvars: 'hcl',
    // 标记/文档
    md: 'markdown', markdown: 'markdown', mdx: 'markdown', txt: 'plaintext', log: 'log',
    diff: 'diff', patch: 'diff',
  };
  return map[ext] ?? 'plaintext';
}

function severityOf(s: monaco.MarkerSeverity): Diagnostic['severity'] {
  if (s === monaco.MarkerSeverity.Error) return 'error';
  if (s === monaco.MarkerSeverity.Warning) return 'warning';
  if (s === monaco.MarkerSeverity.Info) return 'info';
  return 'hint';
}

interface OpenEntry {
  path: string;
  kind: 'text' | 'image' | 'newtab' | 'diff' | 'hex' | 'csv' | 'html' | 'pdf' | 'browser' | 'review';
  /** diff 条目元数据 */
  diffPath?: string;
  diffOriginal?: string;
  diffModified?: string;
  mime?: string;
  src?: string;
  /** .md 文件：预览/源码视图（默认预览，⋯菜单切换） */
  isMd?: boolean;
  preview?: boolean;
  /** 二进制 viewer（hex/pdf）数据：fsReadFile binary 分支的 base64（cap 512KB） */
  base64?: string;
  size?: number;
  truncated?: boolean;
  /** csv/html viewer 的文本内容 */
  content?: string;
  /** browser 条目：URL（path = 'browser:<url>' 作唯一键） */
  url?: string;
  /** review 条目：筛选模式（lastTurn 由汇总卡审查按钮预设） */
  reviewMode?: string;
}

/** 走 viewer 注册表渲染的 kind（非 Monaco 文本/图片/diff/newtab 既有分支） */
const VIEWER_KINDS = new Set(['hex', 'csv', 'html', 'pdf', 'browser', 'review']);

const NEW_TAB_PATH = '__newtab__';
let openReviewMode: string | undefined;

/** 编辑器会话外部态：换位/焦点切换会卸载重挂本组件（本地 state 清零）——
 *  标签清单/激活页/未保存缓冲寄存在模块级，重挂时恢复；closeAllTabs/保存随写随清 */
const editorSession: {
  entries: OpenEntry[];
  active: string | null;
  dirty: Map<string, string>;
} = { entries: [], active: null, dirty: new Map() };

function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
}

function copyText(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => undefined);
}

export function EditorArea(): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const models = useRef(new Map<string, monaco.editor.ITextModel>());
  const activeRef = useRef<string | null>(null);
  const dirtyRef = useRef(new Set<string>());
  const [entries, setEntries] = useState<OpenEntry[]>(() => editorSession.entries);
  const [active, setActive] = useState<string | null>(() => editorSession.active);
  const diffHostRef = useRef<HTMLDivElement | null>(null);
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [diffExpanded, setDiffExpanded] = useState(false); // diff 对照开关：收起=仅修改后，展开=双栏对照
  const [tabDropOpen, setTabDropOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string; selText: string; selRange: string } | null>(null);
  const [tabSearch, setTabSearch] = useState('');
  const [, force] = useState(0);
  const tabsNotifyInit = useRef(false);

  /** 打开 diff 标签（审批卡/汇总卡跳转，ADR-0020） */
  const openDiff = (realPath: string, original: string, modified: string): void => {
    const key = `diff:${realPath}`;
    setEntries((prev) => {
      if (prev.some((e) => e.path === key)) return prev.filter((e) => e.path !== key);
      return [...prev.filter((e) => e.path !== key), { path: key, kind: 'diff', diffPath: realPath, diffOriginal: original, diffModified: modified }];
    });
    activeRef.current = key;
    setActive(key);
  };

  const openNewTab = (): void => {
    setEntries((prev) => (prev.some((e) => e.path === NEW_TAB_PATH) ? prev : [...prev, { path: NEW_TAB_PATH, kind: 'newtab' }]));
    activeRef.current = NEW_TAB_PATH;
    setActive(NEW_TAB_PATH);
  };

  const openPath = async (path: string, line?: number): Promise<void> => {
    if (path.startsWith('review:')) {
      setEntries((prev) => {
        const existing = prev.find((x) => x.path === path);
        if (existing && existing.kind === 'review') {
          return prev.map((x) => (x.path === path && x.kind === 'review' ? { ...x, reviewMode: openReviewMode ?? x.reviewMode } : x));
        }
        return [...prev, { path, kind: 'review', reviewMode: openReviewMode }];
      });
      openReviewMode = undefined;
      activeRef.current = path;
      setActive(path);
      return;
    }
    if (path.startsWith('browser:')) {
      const url = path.slice('browser:'.length);
      setEntries((prev) => {
        const existing = prev.find((x) => x.path === path);
        if (existing && existing.kind === 'browser') {
          return prev.map((x) => (x.path === path && x.kind === 'browser' ? { ...x, url } : x));
        }
        return [...prev, { path, kind: 'browser', url }];
      });
      activeRef.current = path;
      setActive(path);
      return;
    }
    // browser 标签走 path 前缀路由（不碰 fs——browser:<url> 非真实路径）
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const res = await rpc.call<{ content?: string; binary?: boolean; image?: string; mime?: string; base64?: string; size?: number; truncated?: boolean }>(RPC.fsReadFile, { path });
    if (res.image) {
      // src 必须随条目落库：此前只存 mime，渲染时 src 恒 undefined = 碎图
      setEntries((prev) => (prev.some((e) => e.path === path) ? prev : [...prev, { path, kind: 'image', mime: res.mime, src: res.image }]));
      activeRef.current = path;
      setActive(path);
      emitEnvEvent(bridge(), { type: 'onDidChangeActiveEditor', path });
      return;
    }
    // viewer 注册表路由：二进制 → hex/pdf；csv/html → 专用视图（不经 Monaco）
    if (res.binary && ext === 'pdf') {
      setEntries((prev) => (prev.some((e) => e.path === path) ? prev : [...prev, { path, kind: 'pdf' }]));
      activeRef.current = path;
      setActive(path);
      return;
    }
    if (res.binary) {
      setEntries((prev) => (prev.some((e) => e.path === path) ? prev : [...prev, { path, kind: 'hex', base64: res.base64, size: res.size, truncated: res.truncated }]));
      activeRef.current = path;
      setActive(path);
      return;
    }
    if (ext === 'csv' || ext === 'tsv') {
      setEntries((prev) => (prev.some((e) => e.path === path) ? prev : [...prev, { path, kind: 'csv', content: res.content ?? '' }]));
      activeRef.current = path;
      setActive(path);
      return;
    }
    if (ext === 'html' || ext === 'htm') {
      // 已存在则更新 content（agent 改完文件重开要拿新内容，且源码视图需要新鲜值）
      setEntries((prev) => prev.some((e) => e.path === path)
        ? prev.map((e) => (e.path === path && e.kind === 'html' ? { ...e, content: res.content ?? '' } : e))
        : [...prev, { path, kind: 'html', content: res.content ?? '' }]);
      activeRef.current = path;
      setActive(path);
      return;
    }
    let model = models.current.get(path);
    if (!model) {
      // 换位/重挂：monaco 模型注册表是全局的——旧实例的同 URI 模型可能仍在（createModel 会抛 already exists），优先复用
      model = monaco.editor.getModel(monaco.Uri.file(path)) ?? undefined;
    }
    if (!model) {
      // 换位/重挂后的脏缓冲恢复：磁盘内容先建模，再覆盖未保存值并标记脏
      const savedDirty = editorSession.dirty.get(path);
      model = monaco.editor.createModel(
        savedDirty ?? (res.binary ? '// [二进制文件，未显示内容]' : (res.content ?? '')),
        langOf(path),
        monaco.Uri.file(path),
      );
      model.onDidChangeContent(() => {
        dirtyRef.current.add(path);
        force((n) => n + 1);
      });
      if (savedDirty !== undefined) {
        editorSession.dirty.delete(path); // 已物化进模型
        dirtyRef.current.add(path);
        force((n) => n + 1);
      }
    }
    models.current.set(path, model);
    setEntries((prev) => {
      if (prev.some((e) => e.path === path)) return prev;
      const isMd = path.toLowerCase().endsWith('.md');
      return [...prev, { path, kind: 'text', ...(isMd ? { isMd: true, preview: true } : {}) }];
    });
    activeRef.current = path;
    setActive(path);
    const ed = editorRef.current;
    if (ed) {
      ed.setModel(model);
      if (line !== undefined) {
        ed.revealLineInCenter(line);
        ed.setPosition({ lineNumber: line, column: 1 });
      }
      ed.focus();
    }
    emitEnvEvent(bridge(), { type: 'onDidChangeActiveEditor', path });
  };

  const closeTab = (path: string): void => {
    const model = models.current.get(path);
    if (model) {
      if (dirtyRef.current.has(path)) return; // 脏文件不允许误关
      model.dispose();
      models.current.delete(path);
    }
    setEntries((prev) => {
      const next = prev.filter((e) => e.path !== path);
      if (activeRef.current === path) {
        const nextActive = next[next.length - 1]?.path ?? null;
        activeRef.current = nextActive;
        setActive(nextActive);
        const m = nextActive ? models.current.get(nextActive) : null;
        if (m && editorRef.current) editorRef.current.setModel(m);
      }
      return next;
    });
  };

  useEffect(() => {
    const ed = monaco.editor.create(hostRef.current ?? document.body, {
      theme: document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark',
      automaticLayout: true,
      fontSize: 14,
      lineHeight: 1.6,
      minimap: { enabled: false },
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      scrollBeyondLastLine: false,
      padding: { top: 10 },
      // 收窄行号左侧留白：去掉 glyph margin 空白条，行号列 5→3 字符，行号与代码间距 10→6px
      glyphMargin: false,
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 6,
    });
    editorRef.current = ed;

    const onTheme = (): void => {
      monaco.editor.setTheme(document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark');
    };
    window.addEventListener('loomery:theme', onTheme);

    ed.onDidChangeCursorSelection(() => {
      const model = ed.getModel();
      const sel = ed.getSelection();
      if (!model || !sel || sel.isEmpty()) return;
      emitEnvEvent(bridge(), {
        type: 'onDidChangeSelection',
        path: model.uri.fsPath,
        text: model.getValueInRange(sel),
        range: { startLine: sel.startLineNumber, startCol: sel.startColumn, endLine: sel.endLineNumber, endCol: sel.endColumn },
      });
    });

    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const model = ed.getModel();
      if (!model) return;
      void rpc
        .call(RPC.fsWriteFile, { path: model.uri.fsPath, content: model.getValue() })
        .then(() => {
          dirtyRef.current.delete(model.uri.fsPath);
          editorSession.dirty.delete(model.uri.fsPath); // 外部会话态同步（否则重挂会复活已保存内容）
          force((n) => n + 1);
          emitEnvEvent(bridge(), { type: 'onDidSave', path: model.uri.fsPath });
        })
        .catch((err: unknown) => console.error('[editor] 保存失败', err));
    });

    registerEditorOpener(openPath);
    // 2026-11-13 P1⑤ AI 行内操作：选中代码 → 右键菜单/快捷键 → 预填 Composer（selection provider 同源）
    const aiAction = (id: string, label: string, kb: number[], prompt: (sel: string, file: string, pos: string) => string): void => {
      ed.addAction({
        id,
        label,
        contextMenuGroupId: 'loomery',
        contextMenuOrder: 1,
        keybindings: kb,
        run: (editor) => {
          const sel = editor.getSelection();
          const model = editor.getModel();
          if (!model || !sel || sel.isEmpty()) return;
          const text = model.getValueInRange(sel);
          const file = model.uri.fsPath;
          const pos = `${sel.startLineNumber}`;
          insertToComposer(prompt(text, file, pos));
        },
      });
    };
    aiAction('loomery.explainSelection', 'Loomery：解释这段代码',
      [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyE],
      (sel, file, pos) => `请解释下面这段代码（来自 ${file} 第 ${pos} 行附近），说明它的作用、调用关系与潜在问题：

${sel}`);
    aiAction('loomery.improveSelection', 'Loomery：给出改进建议',
      [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyI],
      (sel, file, pos) => `请审查下面这段代码（来自 ${file} 第 ${pos} 行附近），指出问题并给出改进后的版本（用 apply_diff 修改）：

${sel}`);
    // 2026-11-13 浏览器控制：tab='active' → 原地换 URL（标签数不增长，BrowserViewer 随 path 重挂载加载新地址）；
    // tab='new' 或无浏览器标签 → openPath 开新（同 URL 自动激活既有标签）
    // 2026-11-13 P2 批次 D/F：截图落图片标签 + 关闭浏览器标签（agent 经网关调达）
    const onOpenImage = (ev: Event): void => {
      const d = (ev as CustomEvent<{ name: string; mime: string; base64: string }>).detail;
      if (!d?.base64) return;
      const path = 'shot:' + d.name;
      setEntries((prev) => {
        const ex = prev.find((e) => e.path === path);
        if (ex && ex.kind === 'image') return prev.map((e) => (e.path === path && e.kind === 'image' ? { ...e, src: d.base64, mime: d.mime } : e));
        return [...prev, { path, kind: 'image', mime: d.mime, src: d.base64 }];
      });
      activeRef.current = path;
      setActive(path);
    };
    const onCloseTabReq = (ev: Event): void => {
      const p = (ev as CustomEvent<{ path: string }>).detail?.path;
      if (p) closeTab(p);
    };
    window.addEventListener('loomery:open-image', onOpenImage);
    window.addEventListener('loomery:close-editor-tab', onCloseTabReq);
    const browserOpenerFn = (url: string, tab: 'new' | 'active'): void => {
      const hasBrowser = editorSession.entries.some((e) => e.kind === 'browser');
      if (tab === 'active' && hasBrowser) {
        setEntries((prev) => prev.map((e) => (e.kind === 'browser' ? { ...e, path: 'browser:' + url, kind: 'browser', url } : e)));
        activeRef.current = 'browser:' + url;
        setActive('browser:' + url);
        return;
      }
      void openPath('browser:' + url);
    };
    registerBrowserOpener(browserOpenerFn);
    registerDiffOpener(openDiff);
    // 右键引用：选中文本 → 插入 路径:行号区间 + 内容 到聊天框（禁用 monaco 原生菜单）
    ed.updateOptions({ contextmenu: false });
    const hostEl = hostRef.current;
    const onCtx = (e: MouseEvent): void => {
      e.preventDefault();
      const model = ed.getModel();
      const sel = ed.getSelection();
      const selText = model && sel && !sel.isEmpty() ? model.getValueInRange(sel) : '';
      const selRange = model && sel && !sel.isEmpty() ? `${sel.startLineNumber}-${sel.endLineNumber}` : '';
      setCtxMenu({ x: e.clientX, y: e.clientY, path: model?.uri.fsPath ?? '', selText, selRange });
    };
    hostEl?.addEventListener('contextmenu', onCtx);
    const onCloseAllTabs = (): void => closeAllTabs();
    window.addEventListener('loomery:close-all-tabs', onCloseAllTabs);

  // 探针钩子：读取激活 Monaco 模型全文（viewer 类标签返回空——它们不经 Monaco）
    if (window.loomeryDev) window.loomeryDev.getActiveModelText = (): string => editorRef.current?.getModel()?.getValue() ?? '';

    setEditorHooksProvider(() => ({
      openFile: openPath,
      applyEdit: async (path, edit) => {
        const model = models.current.get(path) ?? (await (openPath(path), models.current.get(path)));
        if (!model) return false;
        model.pushEditOperations(
          [],
          [{ range: new monaco.Range(edit.startLine, edit.startCol, edit.endLine, edit.endCol), text: edit.newText }],
          () => null,
        );
        return true;
      },
      revealLine: (path, line) => openPath(path, line),
      getActiveEditor: () => (activeRef.current ? { path: activeRef.current, tabs: editorSession.entries.map((e) => e.path) } : null),
      getOpenTabs: () => editorSession.entries.map((e) => e.path),
      getSelection: () => {
        const model = ed.getModel();
        const sel = ed.getSelection();
        return model && sel && !sel.isEmpty() ? { path: model.uri.fsPath, text: model.getValueInRange(sel) } : null;
      },
      getDiagnostics: (): Diagnostic[] =>
        monaco.editor.getModelMarkers({}).map((m) => ({
          file: m.resource.fsPath,
          range: { startLine: m.startLineNumber, startCol: m.startColumn, endLine: m.endLineNumber, endCol: m.endColumn },
          severity: severityOf(m.severity),
          message: m.message,
          source: m.owner,
        })),
      // 12 UI：agent 控制内嵌预览（HTML viewer 监听 CustomEvent；未打开时静默）
      reloadPreview: async () => {
        window.dispatchEvent(new CustomEvent('loomery:preview-reload', { detail: { path: '*' } }));
      },
      navigatePreview: async () => undefined,
      getPageContent: async (target: { url?: string; path?: string }) => {
        const { getPageContent } = await import('../../gateway/editorBus');
        return await getPageContent(target);
      },
      captureBrowserPage: async (url: string, rect?: { x: number; y: number; width: number; height: number }) => {
        const { getBrowserHandle } = await import('../../gateway/editorBus');
        return (await getBrowserHandle(url)?.capture?.(rect)) ?? null;
      },
      runBrowserJs: async (url: string, code: string) => {
        const { getBrowserHandle } = await import('../../gateway/editorBus');
        return (await getBrowserHandle(url)?.runJs?.(code)) ?? undefined;
      },
      openImageTab: async (name: string, mime: string, base64: string) => {
        const { openImageTab } = await import('../../gateway/editorBus');
        openImageTab(name, mime, base64);
      },
      closeBrowserTab: async (url: string) => {
        const { requestCloseEditorTab } = await import('../../gateway/editorBus');
        requestCloseEditorTab('browser:' + url);
      },
      listBrowserTabs: async () => {
        const { listBrowserTabs } = await import('../../gateway/editorBus');
        return listBrowserTabs();
      },
      hoverBrowserPage: async (url: string, x: number, y: number) => {
        const { getBrowserHandle } = await import('../../gateway/editorBus');
        await getBrowserHandle(url)?.hover?.(x, y);
      },
      openBrowser: async (url: string) => {
        window.dispatchEvent(new CustomEvent('loomery:open-browser', { detail: { url } }));
      },
    }));

    // 消费挂起的打开请求（编辑器列隐藏时点击文件的场景）；无挂起但有会话态 → 恢复激活页（换位重挂场景）
    // 零标签挂载：显示新标签页欢迎屏（编辑器列恒驻后，空态=欢迎屏而非塌缩）
    if (entries.length === 0) openNewTab();
    const pend = takePendingOpen();
    if (pend.path) void openPath(pend.path);
    else if (pend.diff) openDiff(pend.diff.path, pend.diff.original, pend.diff.modified);
    else {
      const restored = editorSession.entries.find((e) => e.path === editorSession.active);
      if (restored && restored.kind === 'text') void openPath(restored.path);
    }

    setFileReloadHandler((paths) => {
      // 2026-11-13 P0③：预览标签自动跟随（HtmlViewer 监听此事件防抖 reload）
      window.dispatchEvent(new CustomEvent('loomery:files-changed', { detail: { paths } }));
      for (const p of paths) {
        const model = models.current.get(p);
        if (!model || dirtyRef.current.has(p)) continue;
        void rpc
          .call<{ content: string }>(RPC.fsReadFile, { path: p })
          .then((res) => model.setValue(res.content))
          .catch(() => undefined);
      }
    });

    return () => {
      window.removeEventListener('loomery:theme', onTheme);
      window.removeEventListener('loomery:close-all-tabs', onCloseAllTabs);
      // 模块级注册注销（否则死闭包吞掉后续 openInEditor/openInDiff——编辑器关掉后再点文件打不开）
      unregisterEditorOpener(openPath);
      unregisterBrowserOpener(browserOpenerFn);
      window.removeEventListener('loomery:open-image', onOpenImage);
      window.removeEventListener('loomery:close-editor-tab', onCloseTabReq);
      unregisterDiffOpener(openDiff);
      setEditorHooksProvider(() => null); // 网关调用回退为显式"编辑器尚未就绪"
      setFileReloadHandler(() => undefined);
      // 会话态回写：未保存缓冲留在 editorSession.dirty（重挂后 openPath 覆盖恢复），模型随后销毁
      editorSession.dirty.clear();
      for (const [p, m] of models.current) {
        if (dirtyRef.current.has(p)) editorSession.dirty.set(p, m.getValue());
      }
      ed.dispose();
    };
  }, []);

  // 2026-11-14 流向 B 通电：markers 变化 → 环境事件外发（此前通道断头：EnvHub 在 main 待命但无人发送）。
  // 打字期间 markers 高频抖动 → 每文件 600ms debounce 合帧；事件体复用 getDiagnostics 的同源映射。
  useEffect(() => {
    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    const disp = monaco.editor.onDidChangeMarkers((uris) => {
      for (const uri of uris) {
        const key = uri.fsPath;
        const timer = pending.get(key);
        if (timer) clearTimeout(timer);
        pending.set(
          key,
          setTimeout(() => {
            pending.delete(key);
            const markers = monaco.editor.getModelMarkers({ resource: uri });
            emitEnvironment({
              type: 'onDidChangeDiagnostics',
              path: key,
              diagnostics: markers.map((m) => ({
                file: m.resource.fsPath,
                range: { startLine: m.startLineNumber, startCol: m.startColumn, endLine: m.endLineNumber, endCol: m.endColumn },
                severity: severityOf(m.severity),
                message: m.message,
                source: m.owner,
              })),
            });
          }, 600),
        );
      }
    });
    return () => {
      disp.dispose();
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  // 通知标签数 + 会话态回写：跳过首次（挂载时 entries 还是空，随后挂起的 openPath 才会填入，避免误触发 App 收起列）
  useEffect(() => {
    if (!tabsNotifyInit.current) {
      tabsNotifyInit.current = true;
      editorSession.entries = entries; // 挂载恢复的清单也要落回会话态（后续卸载用它）
      return;
    }
    notifyTabsCount(entries.length);
    editorSession.entries = entries;
    editorSession.active = activeRef.current;
  }, [entries]);

  // DiffEditor 生命周期：仅当激活标签为 diff 时创建（06 §4.3 双栏对照）
  // 默认收起 = 单栏仅显示修改后（inline 视图 + compactMode 只留一套行号）；
  // 点"对照"展开 = 双栏 修改前|修改后 对比阅读（禁用窄宽自动内联，强制并排）
  useEffect(() => {
    const entry = entries.find((e) => e.path === active);
    if (!entry || entry.kind !== 'diff' || !diffHostRef.current) return;
    const lang = langOf(entry.diffPath ?? '');
    const original = monaco.editor.createModel(entry.diffOriginal ?? '', lang);
    const modified = monaco.editor.createModel(entry.diffModified ?? '', lang);
    const de = monaco.editor.createDiffEditor(diffHostRef.current, {
      readOnly: true,
      renderSideBySide: false,
      automaticLayout: true,
      fontSize: 14,
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      scrollBeyondLastLine: false,
      renderOverviewRuler: true,
      originalEditable: false,
      compactMode: true,
    });
    de.setModel({ original, modified });
    diffEditorRef.current = de;
    return () => {
      de.dispose();
      original.dispose();
      modified.dispose();
      diffEditorRef.current = null;
    };
  }, [active, entries]);

  // 对照开关应用到已创建的 diff 编辑器。依赖带 entries：创建 effect 依赖 [active, entries]，
  // 切走再切回/任何 entries 变化都会用默认"收起"参数重建 diff——必须跟着重建重新套用，
  // 否则按钮显示已展开而编辑器实际是单栏。
  // 注意 compactMode 会强制简单 diff（纯增删）永远 inline（压过 renderSideBySide）——展开态必须一并关掉
  useEffect(() => {
    diffEditorRef.current?.updateOptions(
      diffExpanded
        ? { renderSideBySide: true, compactMode: false, useInlineViewWhenSpaceIsLimited: false }
        : { renderSideBySide: false, compactMode: true, useInlineViewWhenSpaceIsLimited: true },
    );
  }, [diffExpanded, active, entries]);

  const activeEntry = entries.find((e) => e.path === active);
  const config = useRuntime((s) => s.config);
  const wsRoot = config?.workspaceRoots[0];
  const rootName = wsRoot ? basename(wsRoot) : null;
  // 面包屑相对路径：首段 = 项目名（对齐 ZCode）
  // diff 标签的 active 是 'diff:<真实路径>'，面包屑必须用真实路径（此前 diff: 前缀混进段里）
  const crumbPath = activeEntry?.kind === 'diff' ? (activeEntry.diffPath ?? active) : active;
  const crumbIsBrowser = activeEntry?.kind === 'browser';
  const relPath = crumbPath && wsRoot && (crumbPath === wsRoot || crumbPath.startsWith(wsRoot))
    ? crumbPath.slice(wsRoot.length).replace(/^[\\/]+/, '')
    : crumbPath;
  const segments = crumbIsBrowser
    ? [activeEntry?.url ?? '浏览器']
    : [
        ...(rootName ? [rootName] : []),
        ...(relPath ? relPath.split(/[\\\\/]/).filter(Boolean) : []),
      ];
  const [bcMenuOpen, setBcMenuOpen] = useState(false);
  const showMdPreview = activeEntry?.kind === 'text' && activeEntry.isMd === true && activeEntry.preview === true;
  const mdContent = activeEntry?.path ? (models.current.get(activeEntry.path)?.getValue() ?? '') : '';

  const setMdPreview = (path: string, v: boolean): void => {
    setEntries((prev) => prev.map((e) => (e.path === path ? { ...e, preview: v } : e)));
  };

  const closeAllTabs = (): void => {
    for (const e of entries) {
      if (e.kind === 'text' && dirtyRef.current.has(e.path)) continue;
      models.current.get(e.path)?.dispose();
      models.current.delete(e.path);
    }
    setEntries((prev) => prev.filter((e) => e.kind === 'text' && dirtyRef.current.has(e.path)));
    if (activeRef.current && !dirtyRef.current.has(activeRef.current)) {
      activeRef.current = null;
      setActive(null);
      editorRef.current?.setModel(null as unknown as monaco.editor.ITextModel);
    }
  };

  const popoutActive = async (): Promise<void> => {
    if (!activeEntry) return;
    await rpc.call(RPC.windowPopout, { file: activeEntry.path });
    closeTab(activeEntry.path);
  };

  // 13 审查标签页：loomery:open-review { root?, mode? }（胶囊 Git 区/汇总卡入口）——组件体顶层（Hook 不可嵌套于另一 Hook，React #321 教训）
  useEffect(() => {
    const onOpenReview = (ev: Event): void => {
      const d = (ev as CustomEvent<{ root?: string; mode?: string }>).detail ?? {};
      openReviewMode = d.mode;
      void openPath('review:' + (d.root ?? ''));
    };
    window.addEventListener('loomery:open-review', onOpenReview);
    return () => window.removeEventListener('loomery:open-review', onOpenReview);
  }, []);

  // preview_control 闭环补全（2026-11-13）：预览标签未打开时 HtmlViewer 的监听不存在（未挂载=静默），
  // agent 的 reload/navigate 会石沉大海——这里兜底自动打开目标页（打开即加载最新内容）；已打开则交给 viewer 自身监听
  useEffect(() => {
    const isOpen = (p: string): boolean => editorSession.entries.some((x) => x.path === p);
    const onReload = (ev: Event): void => {
      const p = (ev as CustomEvent<{ path?: string }>).detail?.path;
      if (!p || p === '*' || isOpen(p)) return;
      void openPath(p);
    };
    const onNavigate = (ev: Event): void => {
      const d = (ev as CustomEvent<{ path?: string; target?: string }>).detail;
      if (!d?.path || !d.target) return;
      const base = d.path.slice(0, Math.max(d.path.lastIndexOf('/'), d.path.lastIndexOf('\\')));
      const t = d.target;
      const isAbs = t.startsWith('/') || (t.length >= 2 && t[1] === ':');
      const resolved = isAbs ? t : base + '/' + (t.startsWith('/') ? t.slice(1) : t);
      if (!isOpen(resolved)) void openPath(resolved);
    };
    window.addEventListener('loomery:preview-reload', onReload);
    window.addEventListener('loomery:preview-navigate', onNavigate);
    return () => {
      window.removeEventListener('loomery:preview-reload', onReload);
      window.removeEventListener('loomery:preview-navigate', onNavigate);
    };
  }, []);

  // 2026-11-13 P1⑥：browser 标签名 hostname:port（整串 URL 太长）
  const browserTabName = (p: string): string => {
    const url = p.startsWith('browser:') ? p.slice('browser:'.length) : p;
    try {
      const u = new URL(url);
      return (u.hostname || 'about') + (u.port ? ':' + u.port : '');
    } catch {
      return url.slice(0, 24);
    }
  };
  const tabIcon = (path: string): ReactElement => {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext)) return <ImageIcon size={12} />;
    if (['md', 'txt'].includes(ext)) return <FileText size={12} />;
    if (['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'go', 'rs', 'css', 'html', 'yml', 'yaml', 'mjs', 'cjs'].includes(ext)) return <FileCode2 size={12} />;
    return <FileIcon size={12} />;
  };

  return (
    <div className="panel editor-panel">
      <div className="editor-tabs">
        <button className="icon-btn" title="全部标签页" onClick={() => setTabDropOpen((v) => !v)}><ChevronsDown size={14} /></button>
        {entries.filter((e) => e.kind !== 'newtab').length === 0 && active !== NEW_TAB_PATH ? <span className="tabs-empty">未打开文件</span> : entries.map((e) => (
            <span key={e.path} className={`tab ${e.path === active ? 'active' : ''}`} onClick={() => (e.kind === 'newtab' || e.kind === 'diff' || VIEWER_KINDS.has(e.kind) || e.kind === 'image' ? setActive(e.path) : void openPath(e.path))} title={e.kind === 'diff' ? `Diff · ${e.diffPath}` : e.path}>
            {e.kind === 'newtab' ? <Plus size={12} /> : e.kind === 'diff' ? <GitCompare size={12} /> : tabIcon(e.path)}
            <span className="tab-name">{e.kind === 'newtab' ? '新标签页' : e.kind === 'diff' ? `${(e.diffPath ?? '').split(/[\\/]/).pop()} · Diff` : e.kind === 'browser' ? browserTabName(e.path) : e.path.split(/[\\/]/).pop()}</span>
            {e.kind === 'text' && dirtyRef.current.has(e.path) ? <b className="dot">●</b> : null}
            <X size={12} className="tab-close" onClick={(ev) => { ev.stopPropagation(); closeTab(e.path); }} />
          </span>
        ))}
        <span className="tabstrip-tools">
          <button className="icon-btn" title="新标签页" onClick={openNewTab}><Plus size={14} /></button>
          {activeEntry?.kind === 'diff' ? (
            <button
              className={`icon-btn diff-toggle ${diffExpanded ? 'on' : ''}`}
              title={diffExpanded ? '收起为仅显示修改后' : '展开双栏对照（修改前 | 修改后）'}
              onClick={() => setDiffExpanded((v) => !v)}
            >
              <Columns2 size={13} />
            </button>
          ) : null}
          <button className="icon-btn" title={localStorage.getItem('loomery.focusRight') === '1' ? '恢复三列' : '编辑器占满整窗'} onClick={() => window.dispatchEvent(new CustomEvent('loomery:focus-right'))}><Maximize2 size={13} /></button>
          <button className="icon-btn" title="弹出当前标签到独立窗口" disabled={!activeEntry || activeEntry.kind === 'newtab' || activeEntry.kind === 'diff'} onClick={() => void popoutActive()}><PictureInPicture2 size={13} /></button>
          <WinControls />
        </span>
      </div>
      {active && active !== NEW_TAB_PATH ? (
        <div className="breadcrumb">
          {segments.map((seg, i) => (
            <span key={i} className={i === segments.length - 1 ? 'seg last' : 'seg'}>
              {i > 0 ? <b>›</b> : null} {seg}
            </span>
          ))}
          <span className="crumb-tools">
            <span className="tool-wrap" title="更多操作" onClick={() => setBcMenuOpen((v) => !v)}>
              <MoreHorizontal size={14} className="tool-icon" />
            </span>
            <span className="tool-wrap" title="在资源管理器中显示（即将支持）">
              <ExternalLink size={13} className="tool-icon dim2" />
            </span>
          </span>
        </div>
      ) : null}
{bcMenuOpen && activeEntry ? (
        <>
          <div className="menu-backdrop" onClick={() => setBcMenuOpen(false)} />
          <div className="dropdown bc-menu">
            {activeEntry.isMd ? (
              <>
              <div className="dd-section">Markdown</div>
              <button onClick={() => { setMdPreview(activeEntry.path, true); setBcMenuOpen(false); }}>
                <Eye size={14} /> 预览 {activeEntry.preview ? <Check size={13} className="dd-check" /> : null}
              </button>
              <button onClick={() => { setMdPreview(activeEntry.path, false); setBcMenuOpen(false); }}>
                <FileCode2 size={14} /> 源码 {!activeEntry.preview ? <Check size={13} className="dd-check" /> : null}
              </button>
              <div className="dd-sep" />
              </>
            ) : null}
            <button onClick={() => { copyText(activeEntry.path); setBcMenuOpen(false); }}>
              <Copy size={14} /> 复制绝对路径
            </button>
            <button onClick={() => { copyText(relPath ?? activeEntry.path); setBcMenuOpen(false); }}>
              <Copy size={14} /> 复制相对路径
            </button>
          </div>
        </>
      ) : null}
      {tabDropOpen ? (
        <>
          <div className="menu-backdrop" onClick={() => setTabDropOpen(false)} />
          <div className="tab-dropdown">
            <div className="dd-search">
            <Search size={14} />
            <input autoFocus placeholder="搜索标签页…" value={tabSearch} onChange={(e) => setTabSearch(e.target.value)} />
            </div>
            <div className="dd-list">
            {entries.filter((e) => e.kind !== 'newtab' && e.path.toLowerCase().includes(tabSearch.toLowerCase())).map((e) => (
              <div key={e.path} className={`dd-item ${e.path === active ? 'active' : ''}`} onClick={() => { if (e.kind === 'diff') setActive(e.path); else void openPath(e.path); setTabDropOpen(false); }}>
                {tabIcon(e.path)}
                <span className="dd-name">{e.path}</span>
                <X size={12} className="tool-icon" onClick={(ev) => { ev.stopPropagation(); closeTab(e.path); }} />
              </div>
            ))}
            {entries.filter((e) => e.kind !== 'newtab').length === 0 ? <div className="dd-empty">没有打开的标签页</div> : null}
            <div className="dd-item" style={{ color: 'var(--err)' }} onClick={() => { closeAllTabs(); setTabDropOpen(false); }}>
              <X size={13} /><span className="dd-name">关闭全部标签页</span>
            </div>
            </div>
          </div>
        </>
      ) : null}
        {ctxMenu ? (
          <>
            <div className="menu-backdrop" onClick={() => setCtxMenu(null)} />
            <div className="dropdown ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
              <button
                className={ctxMenu.selText ? '' : 'disabled'}
                onClick={() => {
                  const head = ctxMenu.selRange ? `${ctxMenu.path}:${ctxMenu.selRange}` : ctxMenu.path;
                  insertToComposer(`\n${head}\n${ctxMenu.selText}\n`);
                  setCtxMenu(null);
                }}
              >
                引用到聊天框{ctxMenu.selRange ? `（行 ${ctxMenu.selRange}）` : ''}
              </button>
            </div>
          </>
        ) : null}
        <div className="editor-stage">
        {showMdPreview ? (
          <div className="md-preview">
            <Markdown remarkPlugins={[remarkGfm]}>{balanceFences(mdContent)}</Markdown>
          </div>
        ) : null}
        {activeEntry?.kind === 'image' ? (
          <div className="image-view">
            <img src={`data:${activeEntry.mime};base64,${activeEntry.src}`} alt={activeEntry.path} />
          </div>
        ) : null}
        {activeEntry?.kind === 'newtab' ? <div className="newtab-scroll"><NewTabPanel /></div> : null}
        {activeEntry?.kind === 'diff' ? <div ref={diffHostRef} className="diff-host" /> : null}
        {(() => {
          // 必须以 JSX 元素渲染（<V />）而非函数直调——直调会把 viewer 的 useMemo/useState
          // 跑进 EditorArea 的 hook 作用域，viewer 激活与否 → hook 计数变化 → React #310 崩溃
          const Viewer = activeEntry && VIEWER_KINDS.has(activeEntry.kind) ? viewerFor(activeEntry.kind) : undefined;
          if (!Viewer || !activeEntry) return null;
          return (
            <Viewer
              path={activeEntry.path}
              content={activeEntry.content}
              base64={activeEntry.base64}
              size={activeEntry.size}
              truncated={activeEntry.truncated}
              url={activeEntry.url}
              reviewMode={activeEntry.reviewMode}
            />
          );
        })()}
        <div
          ref={hostRef}
          className="editor-host"
          style={{ display: activeEntry?.kind === 'image' || activeEntry?.kind === 'newtab' || activeEntry?.kind === 'diff' || (activeEntry && VIEWER_KINDS.has(activeEntry.kind)) || showMdPreview ? 'none' : 'block' }}
        />
      </div>
    </div>
  );
}

// ＋号新标签页：类型选择（对齐 ZCode；未实现项诚实占位）
function NewTabPanel(): ReactElement {
  const config = useRuntime((s) => s.config);
  const activeThread = useRuntime((s) => s.threads.find((t) => t.id === s.activeThreadId));
  // 审查页目标根：活动任务的工作区 → 第一个根
  const reviewRoot = activeThread?.workspaceRoot ?? config?.workspaceRoots[0] ?? '';
  const items: { icon: ReactElement; title: string; desc: string; enabled: boolean; action?: () => void }[] = [
    { icon: <FolderClosed size={18} />, title: '文件', desc: '从目录中选择一个文件', enabled: true, action: () => window.dispatchEvent(new CustomEvent('loomery:open-files')) },
    { icon: <Globe size={18} />, title: '浏览器', desc: '浏览网页和预览应用。', enabled: true, action: () => window.dispatchEvent(new CustomEvent('loomery:open-browser')) },
    // 2026-11-13：终端/审查功能已实装——旧规划清单的 P3/即将支持 标记退役
    { icon: <Terminal size={18} />, title: '终端', desc: '打开底部终端面板（多标签会话，与聊天区共用）。', enabled: true, action: () => requestTerminalShow() },
    { icon: <GitPullRequest size={18} />, title: '审查', desc: '查看工作区的代码变更与差异（与胶囊 Git 工具同款）。', enabled: true, action: () => window.dispatchEvent(new CustomEvent('loomery:open-review', { detail: { root: reviewRoot } })) },
    { icon: <FileText size={18} />, title: '辅助对话', desc: '在侧边面板中继续对话（规划中）。', enabled: false },
  ];
  return (
    <div className="newtab-list">
      <h3>新标签页</h3>
      {items.map((it) => (
        <div key={it.title} className="newtab-item">
          <span className="nt-icon">{it.icon}</span>
          <div className="nt-body">
            <div className="nt-title">{it.title}</div>
            <div className="nt-desc">{it.desc}</div>
          </div>
          <button disabled={!it.enabled} onClick={it.action}>打开</button>
        </div>
      ))}
    </div>
  );
}

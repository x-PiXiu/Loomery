// 渲染层内部总线：Sidebar 模式B点文件 → 编辑器打开；审批卡/汇总卡 → DiffPane（不经主进程）
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';
import { rpc } from '@loomery/adapter-ipc-bridge/renderer';

type OpenFileFn = (path: string, line?: number) => Promise<void>;
type DiffFn = (path: string, original: string, modified: string) => void;

let opener: OpenFileFn | null = null;
let diffOpener: DiffFn | null = null;
let browserOpener: ((url: string, tab: 'new' | 'active') => void) | null = null;

// 编辑器列隐藏时的挂起打开请求（显示列 → 挂载后消费）
let pendingPath: string | null = null;
let pendingDiff: { path: string; original: string; modified: string } | null = null;
function requestShowEditor(): void {
  window.dispatchEvent(new CustomEvent('loomery:show-editor'));
}

export function registerEditorOpener(fn: OpenFileFn): void {
  opener = fn;
}

/** 2026-11-13 P0② 页面文本提取注册表：viewer 挂载时注册（key=自己的 url/path），网关按目标匹配取 innerText */
const pageProviders = new Map<string, PageHandle>();

export interface PageHandle {
  getText: () => Promise<string | null>;
  /** 浏览器标签（webview）专用：页面内执行 JS / 截图——iframe 预览不提供 */
  runJs?: (code: string) => Promise<unknown>;
  capture?: (rect?: { x: number; y: number; width: number; height: number }) => Promise<{ mime: 'image/jpeg'; base64: string; width: number; height: number } | null>;
  /** 真实鼠标移动（CSS :hover 只有真实输入才触发） */
  hover?: (x: number, y: number) => Promise<void>;
}

export function registerPageProvider(key: string, handle: PageHandle): void {
  pageProviders.set(key, handle);
}

export function unregisterPageProvider(key: string): void {
  pageProviders.delete(key); // key 由 viewer 唯一持有（path/url），按 key 删除即可
}

/** docs/16 P2：按 URL 定位浏览器标签 handle（截图/页面交互用） */
export function getBrowserHandle(url: string): PageHandle | undefined {
  return pageProviders.get('browser:' + url);
}

/** 2026-11-13：打开底部终端面板（Composer 监听 loomery:terminal-show）——编辑区新标签页的终端入口 */
export function requestTerminalShow(): void {
  window.dispatchEvent(new CustomEvent('loomery:terminal-show'));
}

/** docs/16 P2 批次 D：截图落编辑区图片标签（EditorArea 监听 loomery:open-image） */
export function openImageTab(name: string, mime: string, base64: string): void {
  window.dispatchEvent(new CustomEvent('loomery:open-image', { detail: { name, mime, base64 } }));
}

/** docs/16 P2 批次 F：关闭编辑器标签（EditorArea 监听 loomery:close-editor-tab） */
export function requestCloseEditorTab(path: string): void {
  window.dispatchEvent(new CustomEvent('loomery:close-editor-tab', { detail: { path } }));
}

/** docs/16 P2 批次 F：当前打开的浏览器标签 URL 清单 */
export function listBrowserTabs(): string[] {
  return [...pageProviders.keys()].filter((k) => k.startsWith('browser:')).map((k) => k.slice('browser:'.length));
}

const getTextOf = (key: string) => pageProviders.get(key);

/** 网关取页面文本：精确 url/path 匹配 → 否则取"第一个活着的页面"（当前激活的浏览器/预览） */
export async function getPageContent(target: { url?: string; path?: string }): Promise<string | null> {
  if (target.url) {
    const hit = getTextOf(target.url) ?? getTextOf('browser:' + target.url);
    if (hit) return await hit.getText();
  }
  if (target.path) {
    const hit = getTextOf(target.path) ?? getTextOf('app-file://local/' + encodeURIComponent(target.path));
    if (hit) return await hit.getText();
  }
  // 兜底：任取一个活着的页面（当前通常只有一个）
  for (const handle of pageProviders.values()) {
    const text = await handle.getText();
    if (text !== null) return text;
  }
  return null;
}

export function registerBrowserOpener(fn: (url: string, tab: 'new' | 'active') => void): void {
  browserOpener = fn;
}

export function unregisterBrowserOpener(fn: (url: string, tab: 'new' | 'active') => void): void {
  if (browserOpener === fn) browserOpener = null;
}

/** 编辑器卸载时注销——否则模块级 opener 指向死闭包，点击文件被无声吞掉（pending/show-editor 永不触发） */
export function unregisterEditorOpener(fn: OpenFileFn): void {
  if (opener === fn) opener = null;
}

// 内置浏览器标签统一入口（模块级常驻监听）：EditorArea 挂载时经 opener 直开；
// 未挂载（零标签）时挂 pendingPath + 唤起编辑器列，挂载后 takePendingOpen 消费（'browser:' 前缀路由已支持）
window.addEventListener('loomery:open-browser', (ev) => {
  const d = (ev as CustomEvent<{ url?: string; tab?: 'new' | 'active' }>).detail ?? {};
  const url = d.url ?? 'about:blank';
  const tab = d.tab ?? 'active';
  if (browserOpener) browserOpener(url, tab);
  else void openInEditor('browser:' + url);
});

export function openInEditor(path: string, line?: number): Promise<void> {
  if (opener) return opener(path, line);
  pendingPath = path;
  requestShowEditor();
  return Promise.resolve();
}

export function registerDiffOpener(fn: DiffFn): void {
  diffOpener = fn;
}

export function unregisterDiffOpener(fn: DiffFn): void {
  if (diffOpener === fn) diffOpener = null;
}

export function openInDiff(path: string, original: string, modified: string): void {
  if (diffOpener) { diffOpener(path, original, modified); return; }
  pendingDiff = { path, original, modified };
  requestShowEditor();
}

/** 读取 diff 原始侧内容：优先 checkpoint 快照（写盘后仍可对照），回退当前文件 */
export async function resolveOriginalContent(turnId: string | undefined, path: string): Promise<string | null> {
  if (turnId) {
    try {
      const snap = await rpc.call<string | null>(RPC.checkpointRead, { turnId, path });
      if (typeof snap === 'string') return snap;
    } catch (err) { console.log('[drag-log][diff] checkpointRead err: ' + String(err)); }
  }
  try {
    const res = await rpc.call<{ content?: string; binary?: boolean }>(RPC.fsReadFile, { path });
    console.log('[drag-log][diff] fsReadFile ok len=' + (res.content ?? '').length + ' binary=' + res.binary);
    return res.binary ? null : (res.content ?? '');
  } catch (err) {
    console.error('[drag-log][diff] fsReadFile err: ' + String(err));
    return null;
  }
}

/** 诊断/探针：输入框草稿寄存（Composer 写透式更新，跨重挂恢复） */
let composerDraft = '';
export function setComposerDraft(v: string): void {
  composerDraft = v;
}
export function getComposerDraft(): string {
  return composerDraft;
}

// 开发/自验证钩子：主进程 self-shot 通过 executeJavaScript 打开指定文件
declare global {
  interface Window {
    loomeryDev?: {
      openInEditor(path: string): void;
      insertToComposer(text: string): void;
      getComposerDraft(): string;
      /** 探针：激活 Monaco 模型全文（EditorArea 挂载时注入） */
      getActiveModelText?(): string;
    };
  }
}
window.loomeryDev = {
  openInEditor: (path: string) => { void openInEditor(path); },
  insertToComposer: (text: string) => { insertToComposer(text); },
  getComposerDraft: () => composerDraft,
};

/** 编辑器挂载后消费挂起的打开请求（App 在挂载完成后调用） */
export function takePendingOpen(): { path?: string; diff?: { path: string; original: string; modified: string } } {
  const out: { path?: string; diff?: { path: string; original: string; modified: string } } = {};
  if (pendingPath) out.path = pendingPath;
  if (pendingDiff) out.diff = pendingDiff;
  pendingPath = null;
  pendingDiff = null;
  return out;
}

// ---- 编辑器标签数量通知（App 据此显隐编辑器列） ----
type TabsFn = (count: number) => void;
let tabsCb: TabsFn | null = null;
export function onTabsCount(cb: TabsFn): void {
  tabsCb = cb;
}
export function notifyTabsCount(count: number): void {
  tabsCb?.(count);
}

// ---- 聊天框引用注入（右键"引用到聊天框"） ----
type InsertFn = (text: string) => void;
let insertCb: InsertFn | null = null;
export function registerComposerInserter(fn: InsertFn): void {
  insertCb = fn;
}
/** 聊天面板卸载时注销（focusRight 模式 ChatPanel 不挂载，死回调会吞掉"引用到聊天框"） */
export function unregisterComposerInserter(fn: InsertFn): void {
  if (insertCb === fn) insertCb = null;
}
export function insertToComposer(text: string): void {
  insertCb?.(text);
}

// ---- 聊天框文本替换（用户消息"重新编辑"：整段放回输入框改完再发） ----
export interface ReplaceImages {
  mime: string;
  base64: string;
  name?: string;
}
let replaceCb: ((text: string, images?: ReplaceImages[]) => void) | null = null;
export function registerComposerReplacer(fn: InsertFn): void {
  replaceCb = fn;
}
export function unregisterComposerReplacer(fn: InsertFn): void {
  if (replaceCb === fn) replaceCb = null;
}
export function replaceComposerText(text: string, images?: ReplaceImages[]): void {
  replaceCb?.(text, images);
}

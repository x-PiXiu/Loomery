// 编辑器桥装配：渲染层 hooks 注册 + 文件刷新回调（ADR-0014）
import { emitEnvEvent, registerEditorHandlers, type EditorRendererHooks } from '@loomery/adapter-editor-gateway/renderer';
import { bridge } from '@loomery/adapter-ipc-bridge/renderer';
import type { EnvironmentEvent } from '@loomery/domain';

let provider: (() => EditorRendererHooks | null) | null = null;
let fileReload: ((paths: string[]) => void) | null = null;

export function setEditorHooksProvider(p: () => EditorRendererHooks | null): void {
  provider = p;
}

export function setFileReloadHandler(handler: (paths: string[]) => void): void {
  fileReload = handler;
}

export function notifyFileChanges(paths: string[]): void {
  if (paths.length > 0) fileReload?.(paths);
}

function hooks(): EditorRendererHooks {
  const h = provider?.();
  if (!h) throw new Error('编辑器尚未就绪');
  return h;
}

export function mountEditorBridge(): void {
  registerEditorHandlers(bridge(), {
    openFile: (path, line, col) => hooks().openFile(path, line, col),
    applyEdit: (path, edit) => hooks().applyEdit(path, edit),
    revealLine: (path, line) => hooks().revealLine(path, line),
    getActiveEditor: () => {
      const a = provider?.()?.getActiveEditor() ?? null;
      return a ? { ...a, tabs: provider?.()?.getOpenTabs() ?? [] } : a;
    },
    getOpenTabs: () => provider?.()?.getOpenTabs() ?? [],
    getSelection: () => provider?.()?.getSelection() ?? null,
    getDiagnostics: () => provider?.()?.getDiagnostics() ?? [],
    reloadPreview: async (path) => {
      window.dispatchEvent(new CustomEvent('loomery:preview-reload', { detail: { path } }));
    },
    navigatePreview: async (path, target) => {
      window.dispatchEvent(new CustomEvent('loomery:preview-navigate', { detail: { path, target } }));
    },
    openBrowser: async (url, tab) => {
      window.dispatchEvent(new CustomEvent('loomery:open-browser', { detail: { url, tab } }));
    },
    getPageContent: async (target) => {
      const { getPageContent } = await import('./editorBus');
      return await getPageContent(target);
    },
    captureBrowserPage: async (url, rect) => {
      const { getBrowserHandle } = await import('./editorBus');
      return (await getBrowserHandle(url)?.capture?.(rect)) ?? null;
    },
    runBrowserJs: async (url, code) => {
      const { getBrowserHandle } = await import('./editorBus');
      return (await getBrowserHandle(url)?.runJs?.(code)) ?? undefined;
    },
    hoverBrowserPage: async (url, x, y) => {
      const { getBrowserHandle } = await import('./editorBus');
      await getBrowserHandle(url)?.hover?.(x, y);
    },
    openImageTab: async (name, mime, base64) => {
      const { openImageTab } = await import('./editorBus');
      openImageTab(name, mime, base64);
    },
    closeBrowserTab: async (url) => {
      const { requestCloseEditorTab } = await import('./editorBus');
      requestCloseEditorTab('browser:' + url);
    },
    listBrowserTabs: async () => {
      const { listBrowserTabs } = await import('./editorBus');
      return listBrowserTabs();
    },
  });
}

export function emitEnvironment(event: EnvironmentEvent): void {
  emitEnvEvent(bridge(), event);
}

// editor-gateway 渲染层侧：把 Monaco 实现挂到主进程 RPC 调用上（实现在外、接口在内）
import type { Diagnostic, EnvironmentEvent } from '@loomery/domain';
import type { LoomeryBridge } from '@loomery/adapter-ipc-bridge/renderer';
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';

export interface EditRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface EditorRendererHooks {
  openFile(path: string, line?: number, col?: number): Promise<void>;
  applyEdit(path: string, edit: EditRange & { newText: string }): Promise<boolean>;
  revealLine(path: string, line: number): Promise<void>;
  getActiveEditor(): { path: string; tabs?: string[] } | null;
  getOpenTabs(): string[];
  getOpenTabs(): string[];
  getSelection(): { path: string; text: string } | null;
  getDiagnostics(): Diagnostic[];
  /** 12 UI：agent 控制内嵌预览（未打开预览时静默返回） */
  reloadPreview(path: string): Promise<void>;
  navigatePreview(path: string, target: string): Promise<void>;
  openBrowser(url: string, tab?: 'new' | 'active'): Promise<void>;
  getPageContent(target: { url?: string; path?: string }): Promise<string | null>;
  captureBrowserPage(
    url: string,
    rect?: { x: number; y: number; width: number; height: number },
  ): Promise<{ mime: 'image/jpeg'; base64: string; width: number; height: number } | null>;
  runBrowserJs(url: string, code: string): Promise<unknown>;
  openImageTab(name: string, mime: string, base64: string): Promise<void>;
  closeBrowserTab(url: string): Promise<void>;
  listBrowserTabs(): Promise<string[]>;
  hoverBrowserPage(url: string, x: number, y: number): Promise<void>;
}

/** 由 ui 的 gateway/mount.ts 调用一次：注册主进程调用的分发器 */
export function registerEditorHandlers(bridge: LoomeryBridge, hooks: EditorRendererHooks): void {
  bridge.onMainCall(async (channel: string, payload: unknown) => {
    switch (channel) {
      case RPC.editorOpenFile: {
        const { path, line, col } = payload as { path: string; line?: number; col?: number };
        await hooks.openFile(path, line, col);
        return null;
      }
      case RPC.editorApplyEdit: {
        const { path, edit } = payload as { path: string; edit: EditRange & { newText: string } };
        return await hooks.applyEdit(path, edit);
      }
      case RPC.editorReveal: {
        const { path, line } = payload as { path: string; line: number };
        await hooks.revealLine(path, line);
        return null;
      }
      case RPC.editorGetActive:
        return hooks.getActiveEditor();
      case RPC.editorGetTabs:
        return hooks.getOpenTabs();
      case RPC.editorGetSelection:
        return hooks.getSelection();
      case RPC.editorGetDiagnostics:
        return hooks.getDiagnostics();
      case RPC.previewReload: {
        const { path } = payload as { path: string };
        await hooks.reloadPreview(path);
        return null;
      }
      case RPC.previewNavigate: {
        const { path, target } = payload as { path: string; target: string };
        await hooks.navigatePreview(path, target);
        return null;
      }
      case RPC.previewBrowser: {
        const { url, tab } = payload as { url: string; tab?: 'new' | 'active' };
        await hooks.openBrowser(url, tab);
        return null;
      }
      case RPC.previewContent: {
        const target = payload as { url?: string; path?: string };
        const text = await hooks.getPageContent(target);
        return { text };
      }
      case RPC.previewCapture: {
        const { url, rect } = payload as { url: string; rect?: { x: number; y: number; width: number; height: number } };
        return await hooks.captureBrowserPage(url, rect);
      }
      case RPC.previewRunJs: {
        const { url, code } = payload as { url: string; code: string };
        return await hooks.runBrowserJs(url, code);
      }
      case RPC.previewHover: {
        const { url, x, y } = payload as { url: string; x: number; y: number };
        await hooks.hoverBrowserPage(url, x, y);
        return null;
      }
      case RPC.editorOpenImageTab: {
        const { name, mime, base64 } = payload as { name: string; mime: string; base64: string };
        await hooks.openImageTab(name, mime, base64);
        return null;
      }
      case RPC.browserClose: {
        const { url } = payload as { url: string };
        await hooks.closeBrowserTab(url);
        return null;
      }
      case RPC.browserList:
        return hooks.listBrowserTabs();
      default:
        throw new Error(`渲染层未实现频道: ${channel}`);
    }
  });
}

/** 编辑器环境事件外发（04 §2 流向 B） */
export function emitEnvEvent(bridge: LoomeryBridge, event: EnvironmentEvent): void {
  bridge.sendEnvEvent(event);
}

// editor-gateway main 侧：EditorGateway/环境事件源的 RPC 实现 + 编辑器上下文 Providers
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { estimateTokens } from '@loomery/domain';
import type { Diagnostic, EnvironmentEvent } from '@loomery/domain';
import type {
  ContextChunk, ContextProvider, EditorGateway, EnvironmentEventSource,
} from '@loomery/ports';
import { RPC, type EnvHub, type MainCallInvoker } from '@loomery/adapter-ipc-bridge';

export class RendererEditorGateway implements EditorGateway {
  constructor(private readonly call: MainCallInvoker) {}

  openFile(path: string, opts?: { line?: number; col?: number }): Promise<void> {
    return this.call.call(RPC.editorOpenFile, { path, line: opts?.line, col: opts?.col }).then(() => undefined);
  }

  applyEdit(
    path: string,
    edit: { startLine: number; startCol: number; endLine: number; endCol: number; newText: string },
  ): Promise<boolean> {
    return this.call.call<boolean>(RPC.editorApplyEdit, { path, edit });
  }

  getSelection(): Promise<{ path: string; text: string } | null> {
    return this.call.call<{ path: string; text: string } | null>(RPC.editorGetSelection);
  }

  revealLine(path: string, line: number): Promise<void> {
    return this.call.call(RPC.editorReveal, { path, line }).then(() => undefined);
  }

  reloadPreview(path: string): Promise<void> {
    return this.call.call(RPC.previewReload, { path }).then(() => undefined);
  }

  navigatePreview(path: string, target: string): Promise<void> {
    return this.call.call(RPC.previewNavigate, { path, target }).then(() => undefined);
  }

  openBrowser(url: string, tab?: 'new' | 'active'): Promise<void> {
    return this.call.call(RPC.previewBrowser, { url, ...(tab ? { tab } : {}) }).then(() => undefined);
  }

  getDiagnostics() {
    return this.call.call<Diagnostic[]>(RPC.editorGetDiagnostics);
  }

  captureBrowserPage(url: string, rect?: { x: number; y: number; width: number; height: number }) {
    return this.call
      .call<{ mime: 'image/jpeg'; base64: string; width: number; height: number } | null>(RPC.previewCapture, { url, ...(rect ? { rect } : {}) })
      .then((r) => r ?? null);
  }

  runBrowserJs(url: string, code: string) {
    return this.call.call<unknown>(RPC.previewRunJs, { url, code });
  }

  openImageTab(name: string, mime: string, base64: string): Promise<void> {
    return this.call.call(RPC.editorOpenImageTab, { name, mime, base64 }).then(() => undefined);
  }

  closeBrowserTab(url: string): Promise<void> {
    return this.call.call(RPC.browserClose, { url }).then(() => undefined);
  }

  listBrowserTabs(): Promise<string[]> {
    return this.call.call<string[]>(RPC.browserList).then((r) => r ?? []);
  }

  hoverBrowserPage(url: string, x: number, y: number): Promise<void> {
    return this.call.call(RPC.previewHover, { url, x, y }).then(() => undefined);
  }

  getPageContent(target: { url?: string; path?: string }) {
    return this.call.call<{ text: string | null }>(RPC.previewContent, target).then((r) => r?.text ?? null);
  }
}

/** 渲染层环境事件 → EnvironmentEventSource（context 据此失效缓存） */
export function createEnvSource(hub: EnvHub): EnvironmentEventSource & { attach(): void } {
  return {
    attach: () => hub.attach(),
    subscribe: (cb) => hub.subscribe((e) => cb(e as unknown as EnvironmentEvent)),
  };
}

const chunk = (providerId: string, priority: number, text: string): ContextChunk => ({
  providerId,
  priority,
  tokens: estimateTokens(text),
  text,
});

/** 内置上下文 Providers：当前文件 / 选区 / 诊断（编辑器类，经 RPC）+ 项目结构（主进程 fs） */
export function createEditorContextProviders(
  call: MainCallInvoker,
  workspaceRoots: () => string[],
): ContextProvider[] {
  const activeFile: ContextProvider = {
    id: 'editor.active-file',
    priority: 3,
    provide: async () => {
      const active = await call.call<{ path: string; tabs?: string[] } | null>(RPC.editorGetActive).catch(() => null);
      if (!active?.path) return null;
      // 2026-11-13 P1⑥：附打开的标签清单（agent 知道用户在同时看什么——文档与实现并读的场景）
      const tabsLine = active.tabs && active.tabs.length > 0
        ? `\n\n## 打开的标签\n${active.tabs.slice(0, 12).map((t) => '- ' + t).join('\n')}`
        : '';
      return chunk('editor.active-file', 3, `## 当前打开文件\n${active.path}${tabsLine}`);
    },
  };

  const selection: ContextProvider = {
    id: 'editor.selection',
    priority: 4,
    provide: async () => {
      const sel = await call.call<{ path: string; text: string } | null>(RPC.editorGetSelection).catch(() => null);
      if (!sel?.text) return null;
      return chunk('editor.selection', 4, `## 当前选区（${sel.path}）\n\`\`\`\n${sel.text.slice(0, 4000)}\n\`\`\``);
    },
  };

  const diagnostics: ContextProvider = {
    id: 'editor.diagnostics',
    priority: 5,
    provide: async () => {
      const list = await call.call<Diagnostic[]>(RPC.editorGetDiagnostics).catch(() => []);
      if (!list || list.length === 0) return null;
      const lines = list
        .slice(0, 50)
        .map((d) => `- [${d.severity}] ${d.file}:${d.range.startLine}${d.source ? ` (${d.source})` : ''} ${d.message}`);
      return chunk('editor.diagnostics', 5, `## 实时诊断（${list.length}）\n${lines.join('\n')}`);
    },
  };

  const workspace: ContextProvider = {
    id: 'workspace.tree',
    priority: 8,
    provide: async () => {
      const roots = workspaceRoots();
      if (roots.length === 0) return null;
      const lines: string[] = [];
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 2 || lines.length > 200) return;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of entries.slice(0, 60)) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          lines.push(`${'  '.repeat(depth)}${e.name}${e.isDirectory() ? '/' : ''}`);
          if (e.isDirectory()) await walk(join(dir, e.name), depth + 1);
        }
      };
      for (const root of roots) {
        lines.push(root);
        await walk(root, 1);
      }
      return chunk('workspace.tree', 8, `## 项目结构\n${lines.join('\n')}`);
    },
  };

  return [activeFile, selection, diagnostics, workspace];
}

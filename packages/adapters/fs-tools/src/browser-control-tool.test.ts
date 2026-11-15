// browser_control 回归锁（docs/16 P2）：截图三落点（图像/编辑区标签/工作区保存）+ wait 超时 + press/fill JS 生成
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBrowserControlTool } from './browser-control-tool';
import type { EditorGateway, ToolContext } from '@loomery/ports';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' + 'QUFB'.repeat(8000); // 垫到 >20KB（绕过白屏检测阈值）

function makeEditor(overrides: Partial<EditorGateway> & { runJsResults?: unknown[] } = {}): EditorGateway & { calls: { url: string; code?: string; rect?: unknown }[] } {
  const calls: { url: string; code?: string; rect?: unknown }[] = [];
  let runJsIdx = 0;
  const results = overrides.runJsResults;
  return {
    calls,
    openFile: async () => undefined,
    applyEdit: async () => true,
    getSelection: async () => null,
    revealLine: async () => undefined,
    reloadPreview: async () => undefined,
    navigatePreview: async () => undefined,
    openBrowser: async () => undefined,
    getDiagnostics: async () => [],
    getPageContent: async () => '页面文本',
    captureBrowserPage: async (url, rect) => {
      calls.push({ url, rect });
      return { mime: 'image/jpeg', base64: PNG_B64, width: 1280, height: 800 };
    },
    runBrowserJs: async (url, code) => {
      calls.push({ url, code });
      if (results) return results[runJsIdx++] ?? undefined;
      return { ok: true };
    },
    openImageTab: async () => undefined,
    closeBrowserTab: async () => undefined,
    listBrowserTabs: async () => [],
    hoverBrowserPage: async () => undefined,
    ...overrides,
  } as EditorGateway & { calls: { url: string; code?: string; rect?: unknown }[] };
}

const baseCtx = (workspaceRoots: string[], editor?: EditorGateway): ToolContext => ({
  workspaceRoots,
  signal: new AbortController().signal,
  ...(editor ? { editor } : {}),
});

describe('browser_control（docs/16 P2）', () => {
  const tool = createBrowserControlTool();
  const handler = tool.handler!;

  it('screenshot：返回图像 + 默认打开编辑区图片标签', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'loomery-bc-'));
    const editor = makeEditor();
    const r = await handler({ action: 'screenshot', url: 'http://localhost:5173' }, baseCtx([ws], editor));
    expect(r.ok).toBe(true);
    expect(r.images).toHaveLength(1);
    expect(r.images?.[0]?.mime).toBe('image/jpeg');
    expect(r.content).toContain('编辑区图片标签');
    await rm(ws, { recursive: true, force: true });
  });

  it('screenshot save：base64 落盘为真实文件', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'loomery-bc-'));
    const editor = makeEditor();
    const r = await handler({ action: 'screenshot', url: 'http://x', save: 'shots/home.png' }, baseCtx([ws], editor));
    expect(r.ok).toBe(true);
    expect(r.content).toContain('已保存');
    const saved = await readFile(join(ws, 'shots', 'home.png'));
    expect(saved.length).toBeGreaterThan(0);
    await rm(ws, { recursive: true, force: true });
  });

  it('screenshot 元素级：rect 由 getBoundingClientRect 提供', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'loomery-bc-'));
    const editor = makeEditor({
      runJsResults: [{ x: 12, y: 34, width: 200, height: 40 }],
    });
    const r = await handler({ action: 'screenshot', url: 'http://x', selector: 'header' }, baseCtx([ws], editor));
    expect(r.ok).toBe(true);
    // calls[0]=runBrowserJs(取几何)，calls[1]=captureBrowserPage（携带 rect）
    expect(editor.calls[1]?.rect).toEqual({ x: 12, y: 34, width: 200, height: 40 });
    await rm(ws, { recursive: true, force: true });
  });

  it('wait selector：出现即返回；超时给出可行动错误', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'loomery-bc-'));
    // 立即出现
    const editor1 = makeEditor({ runJsResults: [true] });
    const r1 = await handler({ action: 'wait', url: 'http://x', selector: '#app', timeout: 1000 }, baseCtx([ws], editor1));
    expect(r1.ok).toBe(true);
    expect(r1.content).toContain('已出现');
    // 始终不出现（假网关恒 false）
    const editor2 = makeEditor({ runJsResults: [false, false, false, false, false] });
    const r2 = await handler({ action: 'wait', url: 'http://x', selector: '#app', timeout: 500 }, baseCtx([ws], editor2));
    expect(r2.ok).toBe(false);
    expect(r2.content).toContain('等待超时');
    await rm(ws, { recursive: true, force: true });
  });

  it('press/fill：生成正确的页面 JS（key 事件/受控组件 setter）', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'loomery-bc-'));
    const editor = makeEditor();
    const rp = await handler({ action: 'press', url: 'http://x', key: 'Enter', selector: 'input.q' }, baseCtx([ws], editor));
    expect(rp.ok).toBe(true);
    const pressed = editor.calls[0]?.code ?? '';
    expect(pressed).toContain('"Enter"');
    expect(pressed).toContain('keydown');
    const rf = await handler({ action: 'fill', url: 'http://x', selector: 'input.q', text: 'hello' }, baseCtx([ws], editor));
    expect(rf.ok).toBe(true);
    expect(editor.calls.at(-1)?.code).toContain("dispatchEvent(new Event('input'");
    await rm(ws, { recursive: true, force: true });
  });

  it('白屏检测：极小截图自动探测可达性并给出行动建议', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'loomery-bc-'));
    const probes: string[] = [];
    const tool2 = createBrowserControlTool({
      probeUrl: async (u) => {
        probes.push(u);
        return '可达性探测：目标不可达（ECONNREFUSED）——服务可能未启动。用 run_command(background=true) 启动服务后重试。';
      },
    });
    const blankEditor = makeEditor();
    // 覆盖 capture 返回极小图像（白屏特征）
    blankEditor.captureBrowserPage = async () => ({ mime: 'image/jpeg', base64: 'aGVsbG8=', width: 714, height: 1203 });
    const r = await tool2.handler!({ action: 'screenshot', url: 'http://localhost:5173' }, baseCtx([ws], blankEditor));
    expect(r.ok).toBe(true);
    expect(r.content).toContain('页面大概率空白');
    expect(r.content).toContain('目标不可达');
    expect(probes).toEqual(['http://localhost:5173']);
    await rm(ws, { recursive: true, force: true });
  });

  it('read 空结果：附可达性诊断（填平信息盲区）', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'loomery-bc-'));
    const tool2 = createBrowserControlTool({
      probeUrl: async () => '可达性探测：目标不可达（ECONNREFUSED）——服务可能未启动。',
    });
    const emptyEditor = makeEditor();
    emptyEditor.getPageContent = async () => null;
    const r = await tool2.handler!({ action: 'read', url: 'http://localhost:5173' }, baseCtx([ws], emptyEditor));
    expect(r.ok).toBe(true);
    expect(r.content).toContain('目标不可达');
    expect(r.content).toContain('background=true');
    await rm(ws, { recursive: true, force: true });
  });

  it('hover：走真实鼠标移动（sendInputEvent）', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'loomery-bc-'));
    let hovered: { type: string; x: number; y: number } | undefined;
    const editor = makeEditor({
      runJsResults: [{ x: 100, y: 50 }],
      hoverBrowserPage: async (url, x, y) => {
        hovered = { type: 'mouseMove', x, y };
      },
    });
    void editor;
    const r = await handler({ action: 'hover', url: 'http://x', selector: '.menu' }, baseCtx([ws], editor));
    expect(r.ok).toBe(true);
    expect(hovered).toEqual({ type: 'mouseMove', x: 100, y: 50 });
    await rm(ws, { recursive: true, force: true });
  });
});

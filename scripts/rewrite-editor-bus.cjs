// 整文件重写 editorBus.ts（避免漂移/损坏）
const fs = require('fs');
const content = `// 渲染层内部总线：Sidebar 模式B点文件 → 编辑器打开；审批卡/汇总卡 → DiffPane（不经主进程）
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';
import { rpc } from '@loomery/adapter-ipc-bridge/renderer';

type OpenFileFn = (path: string, line?: number) => Promise<void>;
type DiffFn = (path: string, original: string, modified: string) => void;

let opener: OpenFileFn | null = null;
let diffOpener: DiffFn | null = null;

export function registerEditorOpener(fn: OpenFileFn): void {
  opener = fn;
}

export function openInEditor(path: string, line?: number): Promise<void> {
  return opener ? opener(path, line) : Promise.resolve();
}

export function registerDiffOpener(fn: DiffFn): void {
  diffOpener = fn;
}

export function openInDiff(path: string, original: string, modified: string): void {
  diffOpener?.(path, original, modified);
}

/** 读取 diff 原始侧内容：优先 checkpoint 快照（写盘后仍可对照），回退当前文件 */
export async function resolveOriginalContent(turnId: string | undefined, path: string): Promise<string | null> {
  if (turnId) {
    try {
      const snap = await rpc.call<string | null>(RPC.checkpointRead, { turnId, path });
      if (typeof snap === 'string') return snap;
    } catch { /* 快照不存在则回退当前文件 */ }
  }
  try {
    const res = await rpc.call<{ content?: string; binary?: boolean }>(RPC.fsReadFile, { path });
    return res.binary ? null : (res.content ?? '');
  } catch {
    return null;
  }
}

// 开发/自验证钩子：主进程 self-shot 通过 executeJavaScript 打开指定文件
declare global {
  interface Window {
    loomeryDev?: { openInEditor(path: string): void };
  }
}
window.loomeryDev = { openInEditor: (path: string) => { void openInEditor(path); } };
`;
fs.writeFileSync('packages/ui/src/gateway/editorBus.ts', content);
console.log('editorBank rewritten');

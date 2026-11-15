// resolveOriginalContent 全程日志（定位 fsReadFile 为何 null）
const fs = require('fs');
const p = 'packages/ui/src/gateway/editorBus.ts';
let s = fs.readFileSync(p, 'utf8');
const old = `export async function resolveOriginalContent(turnId: string | undefined, path: string): Promise<string | null> {
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
}`;
const now = `export async function resolveOriginalContent(turnId: string | undefined, path: string): Promise<string | null> {
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
}`;
if (s.includes(old)) {
  s = s.replace(old, now);
  fs.writeFileSync(p, s);
  console.log('instrumented');
} else {
  console.log('miss');
  process.exit(1);
}

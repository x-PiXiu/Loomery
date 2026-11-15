// DiffPane 第二步：CheckpointService.readSnapshot / RPC.checkpointRead / bootstrap 处理器 / runtime proposals
const fs = require('fs');
let ok = 0;

// 1) CheckpointService.readSnapshot
const ckPath = 'packages/adapters/fs-tools/src/checkpoint/checkpoint.ts';
let ck = fs.readFileSync(ckPath, 'utf8');
if (!ck.includes('readSnapshot')) {
  ck = ck.replace(
    'import { copyFile, mkdir, readdir, rm, stat, writeFile } from \'node:fs/promises\';',
    'import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from \'node:fs/promises\';',
  );
  const anchor = '  /** 滚动清理：按目录 mtime 删除最旧的 Turn 快照，仅保留最近 keepTurns 个 */';
  const inject = [
    '  /** 读取某 Turn 某文件的快照原文（DiffPane 原始侧内容；无快照或二进制返回 null） */',
    '  async readSnapshot(turnId: string, file: string): Promise<string | null> {',
    '    const dest = this.snapshotPath(turnId, file);',
    '    if (!existsSync(dest)) return null;',
    '    const buf = await readFile(dest);',
    '    if (buf.subarray(0, 8000).includes(0)) return null;',
    '    return buf.toString(\'utf8\');',
    '  }',
    '',
    anchor,
  ].join('\n');
  ck = ck.replace(anchor, inject);
  fs.writeFileSync(ckPath, ck);
  ok++;
  console.log('readSnapshot ok');
} else console.log('readSnapshot present');

// 2) envelope 频道
const envPath = 'packages/adapters/ipc-bridge/src/envelope.ts';
let env = fs.readFileSync(envPath, 'utf8');
if (!env.includes('checkpointRead')) {
  env = env.replace("  checkpointRollback: 'checkpoint.rollback',", "  checkpointRollback: 'checkpoint.rollback',\n  checkpointRead: 'checkpoint.read',");
  fs.writeFileSync(envPath, env);
  ok++;
  console.log('channel ok');
} else console.log('channel present');

// 3) bootstrap 处理器
const bsPath = 'packages/shell/src/main/bootstrap.ts';
let bs = fs.readFileSync(bsPath, 'utf8');
if (!bs.includes('RPC.checkpointRead')) {
  const anchor = "  rpc.handle(RPC.layoutGet, (p) => {";
  const inject = [
    "  rpc.handle(RPC.checkpointRead, (p) => {",
    "    const { turnId, path } = p as { turnId: string; path: string };",
    "    return checkpoint.readSnapshot(String(turnId), String(path));",
    "  });",
    anchor,
  ].join('\n');
  bs = bs.replace(anchor, inject);
  fs.writeFileSync(bsPath, bs);
  ok++;
  console.log('bootstrap handler ok');
} else console.log('handler present');

// 4) runtime：proposals 状态 + diffProposed 落库 + ApprovalItem 带 proposal
const rtPath = 'packages/ui/src/stores/runtime.ts';
let rt = fs.readFileSync(rtPath, 'utf8');

if (!rt.includes('proposals:')) {
  rt = rt.replace(
    'export interface ApprovalItem {\n  turnId?: string;\n  kind: \'approval\';',
    'export interface ApprovalItem {\n  turnId?: string;\n  proposal?: DiffProposal;\n  kind: \'approval\';',
  );
  rt = rt.replace(
    "import type { AgentMode, AppConfig, LoopEvent } from '@loomery/domain';",
    "import type { AgentMode, AppConfig, DiffProposal, LoopEvent } from '@loomery/domain';",
  );
  rt = rt.replace(
    '  turnUsage: { inputTokens: number; outputTokens: number; steps: number; startedAt: number; endedMs?: number } | null;',
    '  turnUsage: { inputTokens: number; outputTokens: number; steps: number; startedAt: number; endedMs?: number } | null;\n  /** 最近一轮的 diff 提案（按文件路径；DiffPane 跳转用） */\n  proposals: Record<string, DiffProposal>;',
  );
  rt = rt.replace(
    '  turnUsage: null,\n  lastInputTokens: 0,\n};',
    '  turnUsage: null,\n  lastInputTokens: 0,\n  proposals: {},\n};',
  );
  rt = rt.replace(
    "let { items, threads, mode, tokens, phase, terminated, checkpoint, turnChanges, turnUsage, lastInputTokens } = s;",
    "let { items, threads, mode, tokens, phase, terminated, checkpoint, turnChanges, turnUsage, lastInputTokens, proposals } = s;",
  );
  // turnStarted 重置 proposals
  rt = rt.replace(
    "          turnUsage = { inputTokens: 0, outputTokens: 0, steps: 0, startedAt: ev.ts };",
    "          turnUsage = { inputTokens: 0, outputTokens: 0, steps: 0, startedAt: ev.ts };\n          proposals = {};",
  );
  // diffProposed 存提案
  rt = rt.replace(
    '          if (turnChanges) turnChanges = st;',
    '          if (turnChanges) turnChanges = st;\n          proposals = { ...proposals, [p.path]: p };',
  );
  // approvalRequired item 带 proposal
  rt = rt.replace(
    "          append({ kind: 'approval', approvalId: ev.payload.approvalId, toolCallId: ev.payload.toolCallId, toolName: toolNameOf(ev.payload.toolCallId), diffText, resolved: null, turnId: curTurn });",
    "          append({ kind: 'approval', approvalId: ev.payload.approvalId, toolCallId: ev.payload.toolCallId, toolName: toolNameOf(ev.payload.toolCallId), diffText, resolved: null, turnId: curTurn, ...(ev.payload.diffProposal ? { proposal: ev.payload.diffProposal } : {}) });",
  );
  // commit
  rt = rt.replace(
    'this.state = { ...s, events, items, threads, mode, tokens, phase, terminated, checkpoint, turnChanges, turnUsage, lastInputTokens };',
    'this.state = { ...s, events, items, threads, mode, tokens, phase, terminated, checkpoint, turnChanges, turnUsage, lastInputTokens, proposals };',
  );
  // resetForThread 清空
  rt = rt.replace(
    "this.set({ activeThreadId: threadId, items, tokens: 0, phase: 'idle', terminated: null, checkpoint: null, turnChanges: null, turnUsage: null, lastInputTokens: 0 });",
    "this.set({ activeThreadId: threadId, items, tokens: 0, phase: 'idle', terminated: null, checkpoint: null, turnChanges: null, turnUsage: null, lastInputTokens: 0, proposals: {} });",
  );
  fs.writeFileSync(rtPath, rt);
  ok++;
  console.log('runtime proposals ok');
} else console.log('runtime present');

console.log('steps done:', ok);

// seq 碰撞修复：种子阶段带回 maxSeq，ThreadService.resetSeq——重启后的元数据操作（移动/重命名）不再被主键碰撞吞掉
const fs = require('fs');

// 1) domain Thread += maxSeq
let sess = fs.readFileSync('packages/domain/src/session.ts', 'utf8');
if (!sess.includes('maxSeq')) {
  const a = '  /** 累计 token 用量（usageDelta 折叠；使用统计页） */\n  usageTokens?: number;\n}';
  const n = '  /** 累计 token 用量（usageDelta 折叠；使用统计页） */\n  usageTokens?: number;\n  /** 最大事件 seq（种子阶段回灌 FanoutSink，防元数据事件主键碰撞被静默丢弃） */\n  maxSeq?: number;\n}';
  if (!sess.includes(a)) { console.log('domain anchor missing'); process.exit(1); }
  sess = sess.replace(a, n);
  fs.writeFileSync('packages/domain/src/session.ts', sess, 'utf8');
  console.log('domain ok');
}

// 2) SQLite listThreads 带 maxSeq
let sq = fs.readFileSync('packages/adapters/memory-store/src/sqlite/sqlite-store.ts', 'utf8');
if (!sq.includes('usageTokens: r.usageTokens, turnIds: JSON.parse(r.turnIds)')) {
  const a = "SELECT threadId, title, createdAt, workspaceRoot, usageTokens, turnIds FROM thread_meta";
  const b = "SELECT threadId, title, createdAt, workspaceRoot, usageTokens, turnIds, maxSeq FROM thread_meta";
  sq = sq.replace(a, b);
  sq = sq.replace(
    "as Array<{ threadId: string; title: string; createdAt: number; workspaceRoot: string | null; usageTokens: number; turnIds: }>",
    'as Array<{ threadId: string; title: string; createdAt: number; workspaceRoot: string | null; usageTokens: number; turnIds: string; maxSeq: number }>',
  );
  sq = sq.replace('usageTokens: r.usageTokens,', 'usageTokens: r.usageTokens,\n      maxSeq: r.maxSeq,');
  fs.writeFileSync('packages/adapters/memory-store/src/sqlite/sqlite-store.ts', sq, 'utf8');
  console.log('sqlite ok');
}

// 3) JSON listThreads 折叠时记录 maxSeq
let ix = fs.readFileSync('packages/adapters/memory-store/src/index.ts', 'utf8');
if (!ix.includes('maxSeq: maxSeqOf(events)')) {
  console.log('json listThreads shape needs manual read — printing');
}

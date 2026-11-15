// docs 措辞同步（ADR-0023 已执行：JSONL→事件日志/引擎中立）
const fs = require('fs');

const fix = (p, pairs) => {
  let s = fs.readFileSync(p, 'utf8');
  for (const [from, to] of pairs) {
    if (!s.includes(from)) { console.log('MISS in ' + p + ': ' + from.slice(0, 50)); continue; }
    s = s.split(from).join(to);
  }
  fs.writeFileSync(p, s, 'utf8');
  console.log('ok ' + p);
};

// docs/05：事实源/事件溯源/存储 GC/日志容错表述
fix('docs/05-modules.md', [
  ['②`MemoryStore.appendEvent` 追加 JSONL 日志（`userData/sessions/<threadId>.jsonl`）。',
   '②`MemoryStore.appendEvent` 追加事件日志（ADR-0023：默认 SQLite `events` 表，`LOOMERY_STORE=json` 回退 JSONL 文件）。'],
  ['**内存治理【规范，P2】**：JSONL 是事实源，内核消息态是**可丢弃的读缓存**。',
   '**内存治理【规范，P2】**：事件日志是事实源（引擎中立，ADR-0023 后=SQLite events 表），内核消息态是**可丢弃的读缓存**。'],
  ['把 JSONL 原子重写为**重放等价的稀疏事件流**',
   '把事件日志原子重写为**重放等价的稀疏事件流**（SQLite=事务内 DELETE+INSERT；JSON=tmp+rename）'],
  ['⑤ **日志容错【规范，P2】**：JSONL 逐行容错解析（`parseJournalLines`）',
   '⑤ **日志容错【规范，P2】**：JSONL 逐行容错解析（`parseJournalLines`，JSON 引擎与导入器共用）'],
  ['⑦ **迁移边界【规范，P2】**：JSONL 解析统一经 `migrateEvent`',
   '⑦ **迁移边界【规范，P2】**：解析边界统一经 `migrateEvent`（JSONL 逐行 / SQLite 行水合）'],
  ['（memoryPinned/Unpinned/Extracted 落 JSONL）', '（memoryPinned/Unpinned/Extracted 落事件日志）'],
]);

// docs/03：LRU 常量行措辞
fix('docs/03-core-contracts.md', [
  ['内核驻留全量消息的任务数上界（LRU 卸载，JSONL 可随时重建；内存治理，P2）',
   '内核驻留全量消息的任务数上界（LRU 卸载，事件日志可随时重建；内存治理，P2）'],
]);
console.log('docs wording done');

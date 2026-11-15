// 记忆更新：迁移遗漏排查批次
const fs = require('fs');
const p = 'C:/Users/29108/.zcode/cli/memories/projects/loomery-3794f0800c2b9453/memory/loomery-agent-editor-project.md';
const entry = `
2026-11-01 **SQLite 迁移遗漏排查收官（自查 5 处，全部修复实证；29 memory-store 测试/lint 0）**：①**userDataSet 复制打开中的 loomery.db+-wal**（数据目录迁移功能在 SQLite 下会拿到不一致快照）——修=userDataSet 前置 PRAGMA wal_checkpoint(TRUNCATE)+副本排除 -wal/-shm；**探针实证：复制副本 integrity_check=ok 且 events=6977/threads=6/facts=35 分毫不差**（verify-sqlite.cjs 新增 [migrated-copy] 断言，runner 用 node:sqlite 直查副本）。②**导入未过滤异线程事件**（JsonJournal.load 有 threadId 过滤，导入器漏了→异线程事件入库可污染）——修=import 时 e.threadId!==文件名 threadId 跳过（严格对齐 JSON 语义）。③verify-compact 探针落盘证据读 sessions/*.jsonl（SQLite 后文件已被归档，证据段静默失效）——修=改经 thread.export 读回（引擎中立），GC 11→7 直方图+memoryCompressed seq=10 断言恢复。④E2E 驱动核查（e2e/e2e-pin/e2e-skill 纯 RPC 驱动无直写 JSONL）无恙。⑤docs 措辞漂移：docs/05 §7 事件溯源/事实源/GC/迁移边界+docs/03 常量行——JSONL 表述全部改为引擎中立（事件日志=SQLite events 表，JSONL 为回退格式）。**方法论沉淀：迁移类改动后要扫四类角落——①数据迁移/复制链路（打开中的 DB！）②探针/测试基建对旧格式的直接依赖 ③双实现语义细节（如 load 的隐式过滤）④docs 措辞与实现同步**。
`;
fs.appendFileSync(p, entry, 'utf8');
const ix = 'C:/Users/29108/.zcode/cli/memories/projects/loomery-3794f0800c2b9453/memory/MEMORY.md';
let s = fs.readFileSync(ix, 'utf8');
const anchor = '真机 6 任务/6977 事件迁入 foldMs=0（JSON 134ms）二次启动不重导';
if (!s.includes(anchor)) { console.log('anchor missing'); process.exit(1); }
s = s.replace(anchor, anchor + '；**自查补 5 处遗漏：userDataSet 复制打开中 DB 前置 wal_checkpoint(TRUNCATE)+副本排除 wal/shm（副本 integrity_check=ok 实证）/导入过滤异线程事件/verify-compact 证据改 thread.export/docs 措辞引擎中立——迁移后必扫四角落：复制链路/探针基建/双实现语义细节/docs 同步**');
fs.writeFileSync(ix, s, 'utf8');
console.log('memory updated');

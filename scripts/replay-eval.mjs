// 回放评估真机脚本（eval golden）：真实会话事件流 → 语义指纹 → golden 保存/检查。
// 用法：
//   node scripts/replay-eval.mjs --save    生成/更新 golden（scripts/golden/replay-golden.json）
//   node scripts/replay-eval.mjs --check   内核升级后重放对比（指纹漂移=行为变化，逐线程报差异）
// 数据源：数据目录解析链（LOOMERY_DATA env → 仓库 .loomery-data）优先 SQLite（events 表），JSONL 兜底。
// 指纹全哈希化（replay-eval.ts），真实对话原文不落盘。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
// esbuild 是工具链内依赖（vite），从 ui 包解析——根 package.json 不直装
// esbuild 藏在 pnpm 工具链深处（.pnpm 虚拟store）——按真实路径解析，根 package.json 不直装
function resolveEsbuild() {
  const pnpmDir = join(repoRoot, 'node_modules/.pnpm');
  const entry = readdirSync(pnpmDir).find((d) => /^esbuild@/.test(d));
  if (!entry) throw new Error('node_modules/.pnpm 下未找到 esbuild（先 pnpm install）');
  return createRequire(join(pnpmDir, entry, 'node_modules/esbuild/package.json'));
}
const { buildSync } = resolveEsbuild()('esbuild');

// ---- 内核指纹函数：esbuild 现场打包（TS 源码 → 临时 mjs）----
const outDir = mkdtempSync(join(tmpdir(), 'loomery-eval-'));
buildSync({
  entryPoints: [join(repoRoot, 'packages/agent-core/src/testing/replay-eval.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['node:*'],
  outfile: join(outDir, 'replay-eval.mjs'),
  logLevel: 'silent',
});
const { corpusFingerprint, compareGolden } = await import(
  'file:///' + join(outDir, 'replay-eval.mjs').replace(/\\/g, '/')
);

// ---- 数据目录解析（与运行时解析链一致：env → 默认随程序盘）----
const dataDir = process.env.LOOMERY_DATA
  ? resolve(process.env.LOOMERY_DATA)
  : join(repoRoot, '.loomery-data');
const GOLDEN = join(repoRoot, 'scripts', 'golden', 'replay-golden.json');

function loadFromSqlite(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare('SELECT DISTINCT threadId FROM events').all();
  const threads = [];
  for (const { threadId } of rows) {
    const evs = db
      .prepare('SELECT seq, id, schemaVersion, ts, turnId, step, type, payload FROM events WHERE threadId = ? ORDER BY seq ASC')
      .all(threadId)
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
    if (evs.length > 0) threads.push({ threadId, events: evs });
  }
  db.close();
  return threads;
}

function loadFromJsonl(sessionsDir) {
  const threads = [];
  for (const f of readdirSync(sessionsDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const events = readFileSync(join(sessionsDir, f), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    if (events.length > 0) threads.push({ threadId: events[0].threadId ?? f.replace(/\.jsonl$/, ''), events });
  }
  return threads;
}

// ---- 装载 ----
let threads = [];
const sqlitePath = existsSync(join(dataDir, 'loomery.db')) ? join(dataDir, 'loomery.db') : join(dataDir, 'loomery.sqlite');
const sessionsDir = join(dataDir, 'sessions');
if (existsSync(sqlitePath)) threads = loadFromSqlite(sqlitePath);
else if (existsSync(sessionsDir)) threads = loadFromJsonl(sessionsDir);
else {
  console.error(`未找到数据目录内容：${dataDir}（既无 loomery.sqlite 也无 sessions/）`);
  process.exit(2);
}
console.log(`装载 ${threads.length} 个线程（数据源：${existsSync(sqlitePath) ? 'SQLite' : 'JSONL'} @ ${dataDir}）`);

const actual = corpusFingerprint(threads);

if (process.argv.includes('--save')) {
  mkdirSync(join(repoRoot, 'scripts', 'golden'), { recursive: true });
  writeFileSync(GOLDEN, actual, 'utf8');
  console.log(`golden 已保存：${GOLDEN}（${threads.length} 线程，指纹哈希化不含原文）`);
} else if (process.argv.includes('--check')) {
  if (!existsSync(GOLDEN)) {
    console.error(`golden 不存在：${GOLDEN}——先跑 --save`);
    process.exit(2);
  }
  const diff = compareGolden(actual, readFileSync(GOLDEN, 'utf8'));
  if (diff) {
    console.error('指纹漂移（内核折叠行为变化或数据增长）：\n' + diff);
    process.exit(1);
  }
  console.log('PASS：全部线程指纹与 golden 一致');
} else {
  console.log('指定 --save 或 --check');
}

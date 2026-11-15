// SQLite 迁移真机探针（ADR-0023 已执行）：
// 阶段① 复制真实 .loomery-data 到探针 userData → 启动（SQLite 引擎）→ 断言导入日志/DB 存在/任务与事件可读
// 阶段② 二次启动 → 断言不重导（无导入日志）且数据仍完整
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const realRoot = path.join(repoRoot, '.loomery-data');
const ud = path.join(os.tmpdir(), 'loomery-probe-sqlite');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
for (const f of ['config.json', 'secrets.enc', 'Local State']) {
  if (fs.existsSync(path.join(realRoot, f))) fs.copyFileSync(path.join(realRoot, f), path.join(ud, f));
}
if (fs.existsSync(path.join(realRoot, 'memory', 'facts.json'))) {
  fs.mkdirSync(path.join(ud, 'memory'), { recursive: true });
  fs.copyFileSync(path.join(realRoot, 'memory', 'facts.json'), path.join(ud, 'memory', 'facts.json'));
  console.log('[runner] facts.json copied (' + JSON.parse(fs.readFileSync(path.join(realRoot, 'memory', 'facts.json'), 'utf8')).length + ' facts)');
}
const sessDir = path.join(realRoot, 'sessions');
let realThreads = 0;
let biggestThread = '';
let biggestSize = 0;
if (fs.existsSync(sessDir)) {
  for (const f of fs.readdirSync(sessDir)) {
    fs.copyFileSync(path.join(sessDir, f), path.join(ud, 'sessions', f));
    realThreads += 1;
    const sz = fs.statSync(path.join(sessDir, f)).size;
    if (sz > biggestSize) { biggestSize = sz; biggestThread = f.replace(/\.jsonl$/, ''); }
  }
}
console.log(`[runner] source threads=${realThreads} biggest=${biggestThread.slice(0, 20)} (${(biggestSize / 1e6).toFixed(2)}MB)`);

const probe = (tag) => `(async () => {
  const out = (t, v) => console.log('[drag-log][sqlite-probe] ' + t + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    for (let i = 0; i < 40 && !window.loomery; i++) await sleep(200);
    const threads = await window.loomery.invoke('thread.list', {});
    out('${tag}', {
      threadCount: threads.length,
      titled: threads.filter((t) => t.title && t.title !== '新会话').length,
      usageSum: threads.reduce((s, t) => s + (t.usageTokens ?? 0), 0),
    });
    const big = threads.find((t) => t.id === ${JSON.stringify(biggestThread)});
    if (big) {
      const events = await window.loomery.invoke('thread.export', { threadId: big.id });
      out('E-${tag}', { biggestExportable: events.length, types: [...new Set(events.map((e) => e.type))].length });
      const facts = await window.loomery.invoke('memory.list', { threadId: big.id });
      out('F-${tag}', { taskFacts: Array.isArray(facts) ? facts.length : -1 });
    }
    const m = await window.loomery.invoke('metrics.get', {});
    out('M-${tag}', { seedCount: m.seedCount, foldMs: m.foldListThreadsMs });
  } catch (e) { out('F-${tag}', { fail: String(e) }); }
})()`;

const boot = (env) => new Promise((resolve) => {
  const child = spawn('pnpm', ['exec', 'electron', '.'], {
    cwd: path.join(repoRoot, 'packages', 'shell'),
    env: { ...process.env, ...env, LOOMERY_USER_DATA: ud, LOOMERY_SELF_SHOT: path.join(ud, `probe-${env.TAG}.png`), LOOMERY_SELF_SHOT_PROBE: probe(env.TAG) },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', () => {});
  setTimeout(() => {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
    try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }
    resolve(stdout);
  }, 32000);
});

(async () => {
  // 阶段①：首次启动 → 导入
  const out1 = await boot({ TAG: 'boot1' });
  const uiLog1 = fs.existsSync(path.join(ud, 'electron-debug.log')) ? fs.readFileSync(path.join(ud, 'electron-debug.log'), 'utf8') : '';
  const lines1 = [...uiLog1.split(/\r?\n/), ...out1.split(/\r?\n/)].filter((l) => l.includes('sqlite-probe') || l.includes('[store]'));
  console.log('---- 阶段①（首次启动=导入） ----');
  console.log(lines1.join('\n') || '(无输出)');
  const dbExists = fs.existsSync(path.join(ud, 'loomery.db'));
  const imported = fs.existsSync(path.join(ud, 'sessions-imported')) ? fs.readdirSync(path.join(ud, 'sessions-imported')).length : 0;
  const sessionsLeft = fs.existsSync(path.join(ud, 'sessions')) ? fs.readdirSync(path.join(ud, 'sessions')).length : -1;
  console.log(`[filesystem] loomery.db=${dbExists} sessions-imported=${imported} sessions残留=${sessionsLeft}`);
  // 副本完整性：userDataSet 复制出的 loomery.db 必须 integrity_check 通过且事件数一致
  const migratedDb = path.join(ud + '-migrated', 'loomery.db');
  if (fs.existsSync(migratedDb)) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const d2 = new DatabaseSync(migratedDb);
      const integrity = d2.prepare('PRAGMA integrity_check').get();
      const evCount = d2.prepare('SELECT COUNT(*) AS n FROM events').get();
      const metaCount = d2.prepare('SELECT COUNT(*) AS n FROM thread_meta').get();
      const factsCount = d2.prepare('SELECT COUNT(*) AS n FROM facts').get();
      console.log(`[migrated-copy] integrity=${JSON.stringify(integrity)} events=${Number(evCount.n)} threads=${Number(metaCount.n)} facts=${Number(factsCount.n)}`);
      d2.close();
    } catch (e) { console.log('[migrated-copy] 检查失败: ' + e); }
  } else {
    console.log('[migrated-copy] 副本不存在（userDataSet 未触发？）');
  }

  // 阶段②：二次启动 → 不重导
  const out2 = await boot({ TAG: 'boot2' });
  const uiLog2 = fs.existsSync(path.join(ud, 'electron-debug.log')) ? fs.readFileSync(path.join(ud, 'electron-debug.log'), 'utf8') : '';
  const lines2 = [...uiLog2.split(/\r?\n/), ...out2.split(/\r?\n/)].filter((l) => l.includes('sqlite-probe') || l.includes('[store]'));
  console.log('---- 阶段②（二次启动=不重导） ----');
  console.log(lines2.join('\n') || '(无输出)');
  const reimported = out2.includes('导入完成');
  console.log(`[filesystem] 二次启动重导=${reimported}`);
  process.exit(0);
})();

// 残行容错真机探针（#1）：合成线程 JSONL 注入①半截残行②uuid 重复行 →
// 启动后断言任务仍可列出/导出（不抛错），且 electron-debug.log 留有 [journal] 告警
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const realRoot = path.join(repoRoot, '.loomery-data');
const ud = path.join(os.tmpdir(), 'loomery-probe-journal');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
for (const f of ['config.json', 'secrets.enc', 'Local State']) {
  if (fs.existsSync(path.join(realRoot, f))) fs.copyFileSync(path.join(realRoot, f), path.join(ud, f));
}
const sessDir = path.join(realRoot, 'sessions');
if (fs.existsSync(sessDir)) {
  for (const f of fs.readdirSync(sessDir)) fs.copyFileSync(path.join(sessDir, f), path.join(ud, 'sessions', f));
}

// 合成 3 轮线程 + 注入损伤
const tid = 'thread_probe_journal';
const now = Date.now();
const lines = [];
let seq = 0;
const ev = (type, payload, extra = {}) => {
  seq += 1;
  return JSON.stringify({ seq, id: crypto.randomUUID(), schemaVersion: 1, ts: now + seq * 100, threadId: tid, type, payload, ...extra });
};
lines.push(ev('threadCreated', { threadId: tid, title: '探针-残行容错' }));
for (let i = 1; i <= 3; i++) {
  lines.push(ev('turnStarted', { turnId: `turn_${i}`, mode: 'edit', model: 'main', userMessageId: `msg_u_${i}`, userText: `第${i}轮的问题` }, { turnId: `turn_${i}` }));
  lines.push(ev('textDelta', { messageId: `msg_a_${i}`, text: `第${i}轮的回复内容，足够用于重放验证。` }, { turnId: `turn_${i}` }));
}
const firstLine = lines[0];
const jsonl = path.join(ud, 'sessions', `${tid}.jsonl`);
fs.writeFileSync(jsonl, [...lines, firstLine, '{"seq":9,"id":"broken-uuid","schemaVersion":1,"thr'].join('\n') + '\n', 'utf8');
console.log('[runner] synthetic thread + 1 duplicate + 1 truncated line written');

const probe = `(async () => {
  const out = (tag, v) => console.log('[drag-log][journal-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    for (let i = 0; i < 60 && !window.loomery; i++) await sleep(200);
    const threads = await window.loomery.invoke('thread.list', {});
    const me = threads.find((t) => t.title === '探针-残行容错');
    if (!me) { out('F', { fail: 'thread missing from list', total: threads.length }); return; }
    const events = await window.loomery.invoke('thread.export', { threadId: me.id });
    out('R', {
      listed: true,
      exportedEvents: events.length, // 9 条有效（1 重复去重 + 1 残行跳过）
      userMsgs: events.filter((e) => e.type === 'turnStarted').length,
    });
  } catch (e) { out('F', { fail: String(e) }); }
})()`;

const shellDir = path.join(repoRoot, 'packages', 'shell');
const child = spawn('pnpm', ['exec', 'electron', '.'], {
  cwd: shellDir,
  env: { ...process.env, LOOMERY_USER_DATA: ud, LOOMERY_SELF_SHOT: path.join(ud, 'probe.png'), LOOMERY_SELF_SHOT_PROBE: probe },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});
let mainStdout = '';
child.stdout.on('data', (d) => { mainStdout += String(d); });
child.stderr.on('data', () => {});
setTimeout(() => {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
  try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }
  const logPath = path.join(ud, 'electron-debug.log');
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const probeLines = log.split(/\r?\n/).filter((l) => l.includes('journal-probe')).join('\n');
  // 主进程 console.warn 走 stdout（已被管道丢弃）， electron-debug.log 只收渲染层——两处都翻
  const journalWarnings = [...log.split(/\r?\n/), ...mainStdout.split(/\r?\n/)].filter((l) => l.includes('[journal]')).join('\n');
  console.log('---- 探针结果 ----');
  console.log(probeLines || '(无 journal-probe 记录)');
  console.log('---- [journal] 告警 ----');
  console.log(journalWarnings || '(无)');
  process.exit(0);
}, 35000);

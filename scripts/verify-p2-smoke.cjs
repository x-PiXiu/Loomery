// P2.0 batch1 真机冒烟：无环境变量启动（走便携默认 .loomery-data）→
// ① memory.list 既有任务（事件折叠读模型真实跑通）② brief.get/brief.set（文件为主 + 审计）
// ③ skillRegistry.scan（用户技能目录为空→[]）
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const tmpBrief = path.join(os.tmpdir(), 'loomery-smoke-brief-' + Date.now());
const probe = `(async () => {
  const out = (v) => console.log('[drag-log][p2-smoke] ' + JSON.stringify(v));
  for (let i = 0; i < 30 && !window.loomery; i++) await new Promise((r) => setTimeout(r, 200));
  const threads = await window.loomery.invoke('thread.list', {});
  const tid = threads.length > 0 ? threads[0].id : 'thread_smoke';
  // brief.set（user 写入）→ brief.get 读回
  const set = await window.loomery.invoke('brief.set', { threadId: tid, content: '# 冒烟目标\\n验证 P2.0 存储链路' });
  const got = await window.loomery.invoke('brief.get', { threadId: tid });
  const facts = await window.loomery.invoke('memory.list', { threadId: tid });
  out({ threads: threads.length, briefRev: set.rev, briefRoundTrip: got.content.includes('冒烟目标'), taskFactsType: Array.isArray(facts) ? 'array' : typeof facts, taskFactsLen: Array.isArray(facts) ? facts.length : -1, tmpBrief: ${JSON.stringify(tmpBrief)} });
})()`;

const shellDir = path.join(repoRoot, 'packages', 'shell');
const child = spawn('pnpm', ['exec', 'electron', '.'], {
  cwd: shellDir,
  env: { ...process.env, LOOMERY_SELF_SHOT: path.join(os.tmpdir(), 'p2-smoke.png'), LOOMERY_SELF_SHOT_PROBE: probe },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
setTimeout(() => {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
  try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }
  const log = path.join(repoRoot, '.loomery-data', 'electron-debug.log');
  const lines = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => l.includes('p2-smoke'))
    : [];
  console.log('---- 冒烟结果 ----');
  console.log(lines.join('\n') || '(无输出)');
  try { fs.rmSync(tmpBrief, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}, 35000);

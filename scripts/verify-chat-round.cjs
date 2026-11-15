// 验证四项聊天流改动（用真实会话=用户截图那两轮）：
// ① 每轮一个计时（.task-timer 数 == 用户请求数）② 被停止的轮显示"回复可能不完整"标记
// ③ 助手操作行有两个复制（总结/全文）④ 用户气泡的复制/重编辑在气泡外右下角（结构断言）
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const realRoot = path.join(process.env.APPDATA, '@loomery', 'shell');
const ud = path.join(os.tmpdir(), 'loomery-probe-chat-round');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
const sessDir = path.join(realRoot, 'sessions');
if (fs.existsSync(sessDir)) {
  for (const f of fs.readdirSync(sessDir)) fs.copyFileSync(path.join(sessDir, f), path.join(ud, 'sessions', f));
}
console.log('[runner] sessions copied: ' + (fs.existsSync(sessDir) ? fs.readdirSync(sessDir).length : 0));

const probe = `(async () => {
  const out = (tag, v) => console.log('[drag-log][chat-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  try {
    for (let i = 0; i < 25; i++) { if (q('.task-item')) break; await sleep(200); }
    // 打开最新任务（截图那个两轮会话）
    let opened = false;
    for (const it of qa('.task-item').slice(0, 4)) {
      it.click();
      await sleep(1000);
      if (qa('.user-msg-anchor').length >= 2) { opened = true; break; }
    }
    if (!opened) { out('F', { fail: 'task with >=2 user msgs not found' }); return 'f'; }
    await sleep(400);
    const timers = qa('.task-timer').map((t) => t.textContent.trim());
    const notes = qa('.turn-stopnote').map((n) => n.textContent.trim());
    const actions = qa('.msg-actions .tool-icon').map((el) => el.parentElement.getAttribute('title'));
    const pill = q('.user-msg-anchor .msg-user-pill-wrap');
    const actionsInBubble = !!q('.msg-user-pill .pill-actions');
    const actionsOutside = !!q('.msg-user-pill-wrap > .pill-actions');
    out('R', {
      userPills: qa('.user-msg-anchor').length,
      timers,
      stopNotes: notes,
      copyActions: actions,
      actionsInBubble, actionsOutside,
      pillWrapOk: !!pill,
    });
    return 'ok';
  } catch (e) { out('F', { fail: String(e) }); return 'e'; }
})()`;

const shellDir = path.join(repoRoot, 'packages', 'shell');
const child = spawn('pnpm', ['exec', 'electron', '.'], {
  cwd: shellDir,
  env: { ...process.env, LOOMERY_SELF_SHOT: path.join(ud, 'probe.png'), LOOMERY_USER_DATA: ud, LOOMERY_SELF_SHOT_PROBE: probe },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
const kill = () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ } try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ } };
setTimeout(() => {
  kill();
  const logPath = path.join(ud, 'electron-debug.log');
  let probeLines = '';
  if (fs.existsSync(logPath)) {
    probeLines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.includes('chat-probe')).join('\n');
  }
  console.log('---- 探针结果 ----');
  console.log(probeLines || '(无 chat-probe 记录)');
  process.exit(0);
}, 40000);

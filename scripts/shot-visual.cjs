// 视觉验收截图：打开文件 → mid 分隔条+互换钮/无状态栏/聊天头回滚钮
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }
const realRoot = path.join(repoRoot, '.loomery-data');
const ud = path.join(os.tmpdir(), 'loomery-probe-visual');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
for (const f of ['config.json', 'secrets.enc', 'Local State']) {
  if (fs.existsSync(path.join(realRoot, f))) fs.copyFileSync(path.join(realRoot, f), path.join(ud, f));
}
const target = path.join(repoRoot, 'package.json');
const probe = "(async () => { for (let i=0;i<40 && !window.loomery;i++) await new Promise(r=>setTimeout(r,200)); window.addEventListener('error', (e) => console.log('[drag-log][mm-probe] ERR ' + String(e.message).slice(0,140))); window.addEventListener('unhandledrejection', (e) => console.log('[drag-log][mm-probe] REJ ' + String(e.reason).slice(0,140))); await new Promise(r=>setTimeout(r,800)); document.querySelector('.model-btn')?.click(); await new Promise(r=>setTimeout(r,500)); const head=document.querySelector('.mm-head'); console.log('[drag-log][mm-probe] head-found=' + !!head); head?.click(); await new Promise(r=>setTimeout(r,600)); console.log('[drag-log][mm-probe] panel-after=' + !!document.querySelector('.model-panel') + ' rows=' + document.querySelectorAll('.mm-row').length + ' labels=' + JSON.stringify([...document.querySelectorAll('.mm-label')].map(l=>l.textContent))); return \"ok\"; })()";
const child = spawn('pnpm', ['exec', 'electron', '.'], {
  cwd: path.join(repoRoot, 'packages', 'shell'),
  env: { ...process.env, LOOMERY_USER_DATA: ud, LOOMERY_SELF_SHOT: path.join(ud, 'visual.png'), LOOMERY_SELF_SHOT_OPEN: target, LOOMERY_SELF_SHOT_CLICK: ".tree-row.dir", LOOMERY_SELF_SHOT_PROBE: probe },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
setTimeout(() => {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
  try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }
  console.log('shot: ' + path.join(ud, 'visual.png'));
  process.exit(0);
}, 15000);

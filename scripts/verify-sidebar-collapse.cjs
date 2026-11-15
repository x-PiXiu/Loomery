// 验证：左上角 logo 悬浮提示"收起左侧任务栏"，点击收起（列宽归零）；
// 收起后三件套（logo+←/→）移驻聊天头栏；点头栏 logo 展开还原。
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const realRoot = path.join(process.env.APPDATA, '@loomery', 'shell');
const ud = path.join(os.tmpdir(), 'loomery-probe-sidebar-collapse');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
const sessDir = path.join(realRoot, 'sessions');
if (fs.existsSync(sessDir)) {
  for (const f of fs.readdirSync(sessDir)) fs.copyFileSync(path.join(sessDir, f), path.join(ud, 'sessions', f));
}

const probe = `(async () => {
  const out = (tag, v) => console.log('[drag-log][sb-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  try {
    for (let i = 0; i < 25; i++) { if (q('.task-item')) break; await sleep(200); }
    const col = q('.sidebar-col');
    if (!col) { out('F', { fail: 'no sidebar-col' }); return 'f'; }
    const w = () => Math.round(col.getBoundingClientRect().width);
    const logo = q('.sidebar-top .logo-btn');
    out('0-state', {
      colW: w(),
      logoTitle: logo ? logo.getAttribute('title') : 'missing',
      headerNav: !!q('.chat-header-nav'),
    });
    // 收起
    logo.click();
    await sleep(500);
    const headerNav = q('.chat-header-nav');
    const hLogo = headerNav ? headerNav.querySelector('.logo-btn') : null;
    const navBtns = headerNav ? [...headerNav.querySelectorAll('.nav-group .icon-btn')].map((b) => b.getAttribute('title')) : [];
    out('1-collapsed', {
      colW: w(),
      headerNavExists: !!headerNav,
      headerLogoTitle: hLogo ? hLogo.getAttribute('title') : 'missing',
      navBtns,
      splitterCollapsed: !!q('.splitter.collapsed'),
    });
    // 展开
    if (hLogo) {
      hLogo.click();
      await sleep(500);
    }
    out('2-reexpanded', {
      colW: w(),
      headerNavGone: !q('.chat-header-nav'),
      logoTitleBack: (q('.sidebar-top .logo-btn') || {}).getAttribute ? q('.sidebar-top .logo-btn').getAttribute('title') : 'missing',
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
    probeLines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.includes('sb-probe')).join('\n');
  }
  console.log('---- 探针结果 ----');
  console.log(probeLines || '(无 sb-probe 记录)');
  process.exit(0);
}, 40000);

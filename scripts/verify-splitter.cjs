// 两列模式分隔条探针（UI-only，空 userData）：
// ① 未开编辑器（两列）时 .splitter 存在且有可见宽度 ② 合成拖拽 → 侧栏宽度联动到 0.32 钳制 + localStorage 持久化
// ③ 双击复位 0.21 ④ 侧栏收起后分隔条同步隐藏
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const ud = path.join(os.tmpdir(), 'loomery-probe-splitter');
fs.rmSync(ud, { recursive: true, force: true });

const probe = `(async () => {
  const out = (tag, v) => console.log('[drag-log][splitter-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  try {
    for (let i = 0; i < 30 && !q('.loomery-main'); i++) await sleep(200);
    await sleep(600);
    const main = q('.loomery-main');
    const rect = main.getBoundingClientRect();
    // ① 两列模式（未开编辑器）：分隔条存在且命中区 6px
    const splitters = [...document.querySelectorAll('.loomery-main > .splitter')];
    const leftSp = splitters[0];
    const w = leftSp ? leftSp.getBoundingClientRect().width : -1;
    const beforeRatio = q('.sidebar-col').getBoundingClientRect().width / rect.width;
    out('A', { splitterCount: splitters.length, hitWidth: w, leftRatioBefore: +beforeRatio.toFixed(3), collapsed: q('.sidebar-col').classList.contains('collapsed') });
    if (!leftSp) { out('F', { fail: 'splitter missing in 2-col mode' }); return; }
    // ② 合成拖拽：mousedown(0.25) → mousemove(0.4 → 钳制 0.32) → mouseup
    const me = (x) => new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: rect.top + 100 });
    leftSp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: rect.left + rect.width * 0.25, clientY: rect.top + 100 }));
    await sleep(50);
    window.dispatchEvent(me(rect.left + rect.width * 0.33));
    await sleep(40);
    window.dispatchEvent(me(rect.left + rect.width * 0.4));
    await sleep(40);
    window.dispatchEvent(me(rect.left + rect.width * 0.45));
    await sleep(40);
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await sleep(200);
    const afterRatio = q('.sidebar-col').getBoundingClientRect().width / rect.width;
    const stored = Number(localStorage.getItem('loomery.frac.left'));
    out('B', { leftRatioAfter: +afterRatio.toFixed(3), stored: +stored.toFixed(3) });
    // ③ 双击复位
    leftSp.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await sleep(200);
    const resetRatio = q('.sidebar-col').getBoundingClientRect().width / rect.width;
    out('C', { leftRatioReset: +resetRatio.toFixed(3), storedReset: Number(localStorage.getItem('loomery.frac.left')) });
    // ④ 收起侧栏（点 logo 按钮）→ 分隔条隐藏
    const logoBtn = q('.logo-btn');
    if (logoBtn) logoBtn.click();
    await sleep(400);
    const spW = leftSp.getBoundingClientRect().width;
    out('D', { collapsedSplitterWidth: spW, sidebarCollapsed: q('.sidebar-col').classList.contains('collapsed') });
    // 恢复展开（收起态 logo 移驻聊天头栏，仍叫 .logo-btn）
    const logoBtn2 = q('.chat-header .logo-btn') ?? q('.logo-btn');
    if (logoBtn2) logoBtn2.click();
    await sleep(400);
    return 'ok';
  } catch (e) { out('F', { fail: String(e) }); }
})()`;

const shellDir = path.join(repoRoot, 'packages', 'shell');
const child = spawn('pnpm', ['exec', 'electron', '.'], {
  cwd: shellDir,
  env: { ...process.env, LOOMERY_USER_DATA: ud, LOOMERY_SELF_SHOT: path.join(ud, 'probe.png'), LOOMERY_SELF_SHOT_PROBE: probe },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
setTimeout(() => {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
  try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }
  const logPath = path.join(ud, 'electron-debug.log');
  const lines = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.includes('splitter-probe')).join('\n')
    : '';
  console.log('---- 探针结果 ----');
  console.log(lines || '(无 splitter-probe 记录)');
  console.log('截图: ' + path.join(ud, 'probe.png'));
  process.exit(0);
}, 40000);

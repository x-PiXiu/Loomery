// 验证文件树目录收起/展开：
// ① 点目录行 → 其子项从列表消失、箭头失去 .open ② 再点 → 子项回来、箭头恢复
// ③ 文件行有无占位 span（图标对齐）④ localStorage 持久化写入
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const realRoot = path.join(process.env.APPDATA, '@loomery', 'shell');
const ud = path.join(os.tmpdir(), 'loomery-probe-tree-collapse');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
const sessDir = path.join(realRoot, 'sessions');
if (fs.existsSync(sessDir)) {
  for (const f of fs.readdirSync(sessDir)) fs.copyFileSync(path.join(sessDir, f), path.join(ud, 'sessions', f));
}

const probe = `(async () => {
  const out = (tag, v) => console.log('[drag-log][tc-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  try {
    for (let i = 0; i < 25; i++) { if (q('.task-item')) break; await sleep(200); }
    q('button[title="查看该项目文件"]').click();
    for (let i = 0; i < 10; i++) { await sleep(300); if (q('.tree-row')) break; }
    await sleep(400);
    const rowsBefore = qa('.tree-row').length;
    // 选一个有子级的目录行（取第一个 .tree-row.dir，真实仓库根下必有：docs 或 packages）
    const dirRow = q('.tree-row.dir');
    const dirName = dirRow ? dirRow.querySelector('span:last-child').textContent : '';
    const dirPath = dirRow ? dirRow.getAttribute('title') : '';
    if (!dirRow) { out('F', { fail: 'no dir row' }); return 'f'; }
    // 展开态断言：箭头 .open + 有子行（下一行深度更大 = 更深的缩进）
    const chev = dirRow.querySelector('.tree-chevron');
    const openClass = chev ? chev.className.includes('open') : false;
    const fileSpacers = qa('.tree-row.file .tree-chevron').filter((s) => !s.querySelector('svg')).length;
    // 收起
    dirRow.click();
    await sleep(400);
    const rowsAfter = qa('.tree-row').length;
    const collapsedClass = (q('.tree-row.dir .tree-chevron') || {}).className || '';
    const persisted = localStorage.getItem('loomery.treeCollapsed') || '';
    // 展开
    (qa('.tree-row.dir').find((r) => r.getAttribute('title') === dirPath) || q('.tree-row.dir')).click();
    await sleep(400);
    const rowsRestored = qa('.tree-row').length;
    // 几何复测：箭头紧贴图标（gap≈6px）、行内容从左侧小缩进开始（不再 flex 撞开）
    const dr = q('.tree-row.dir');
    const chevR = dr.querySelector('.tree-chevron').getBoundingClientRect();
    const iconL = dr.querySelector('svg:nth-of-type(1)') ? dr.querySelectorAll('svg')[0].getBoundingClientRect() : dr.querySelector('svg').getBoundingClientRect();
    const gap = Math.round(iconL.left - chevR.right);
    const rowL = dr.getBoundingClientRect().left;
    const startOffset = Math.round(chevR.left - rowL);
    const fr = q('.tree-row.file');
    const fileIconOffset = Math.round(fr.querySelector('svg').getBoundingClientRect().left - fr.getBoundingClientRect().left);
    out('G', { chevToIconGap: gap, startOffset, fileIconOffset });
    out('R', {
      dirName, rowsBefore, rowsAfter, rowsRestored,
      openClassBefore: openClass,
      collapsedAfter: rowsAfter < rowsBefore && !collapsedClass.includes('open'),
      restored: rowsRestored === rowsBefore,
      persistedWritten: persisted.includes(dirName) || persisted.length > 0,
      fileSpacersAligned: fileSpacers === qa('.tree-row.file').length,
      chevronsEveryDir: qa('.tree-row.dir .tree-chevron svg').length === qa('.tree-row.dir').length,
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
    probeLines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.includes('tc-probe')).join('\n');
  }
  console.log('---- 探针结果 ----');
  console.log(probeLines || '(无 tc-probe 记录)');
  process.exit(0);
}, 40000);

// 多项目二批探针（两阶段）：RPC 备数据（双项目/重命名/建任务/移动）→ reload → 按真实启动断言
// UI 分组（projectNames 显示名 + 任务归属）+ 文件模式切换器。
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const tmpA = path.join(os.tmpdir(), 'loomery-e2e-projA-' + Date.now());
const tmpB = path.join(os.tmpdir(), 'loomery-e2e-projB-' + Date.now());
fs.mkdirSync(tmpA, { recursive: true });
fs.mkdirSync(tmpB, { recursive: true });

const realRoot = path.join(process.env.APPDATA, '@loomery', 'shell');
const ud = path.join(os.tmpdir(), 'loomery-probe-projects2');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
const sessDir = path.join(realRoot, 'sessions');
if (fs.existsSync(sessDir)) {
  for (const f of fs.readdirSync(sessDir)) fs.copyFileSync(path.join(sessDir, f), path.join(ud, 'sessions', f));
}
for (const f of ['config.json']) {
  const p = path.join(realRoot, f);
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(ud, f));
}

const probe = `(async () => {
  const out = (tag, v) => console.log('[drag-log][p2b-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  try {
    for (let i = 0; i < 30 && !window.loomery; i++) await sleep(200);
    // ---- 阶段一：RPC 备数据 ----
    await window.loomery.invoke('project.add', { path: ${JSON.stringify(tmpA)} });
    await window.loomery.invoke('project.add', { path: ${JSON.stringify(tmpB)} });
    await window.loomery.invoke('project.rename', { path: ${JSON.stringify(tmpB)}, name: '备份项目' });
    const created = await window.loomery.invoke('thread.create', { workspaceRoot: ${JSON.stringify(tmpA)} });
    await sleep(400);
    const mv = await window.loomery.invoke('thread.move', { threadId: created.threadId, workspaceRoot: ${JSON.stringify(tmpB)} });
    out('1-prep', { moved: mv.ok });
    // ---- reload（阶段二由 PROBE2 在新页面上下文执行——页面上下文随 reload 销毁）----
    location.reload();
    return 'reloading';
  } catch (e) { out('F', { fail: String(e) }); return 'e'; }
})()`;

const probe2 = `(async () => {
  const out = (tag, v) => console.log('[drag-log][p2b-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  try {
    for (let i = 0; i < 30 && !window.loomery; i++) await sleep(200);
    for (let i = 0; i < 20 && !q('.project-group'); i++) await sleep(250);
    await sleep(500);
    const groups2 = qa('.project-group');
    const names2 = groups2.map((g) => g.querySelector('.project-name')?.textContent.trim());
    const taskInB = groups2.filter((g) => g.textContent.includes('新会话')).some((g) => g.querySelector('.project-name')?.textContent === '备份项目');
    // 文件模式切换器：B 组 ☰ → 头部项目名点击展开
    const bRow = groups2.map((g) => ({ g, btn: [...g.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '') === '查看该项目文件') })).find((x) => x.g.querySelector('.project-name')?.textContent === '备份项目');
    let switcher = { opened: false, options: 0, headName: '' };
    if (bRow && bRow.btn) {
      bRow.btn.click();
      for (let i = 0; i < 10 && !q('.sidebar-tree'); i++) await sleep(250);
      await sleep(300);
      switcher.headName = (q('.sidebar-project-name') || { textContent: '' }).textContent.trim();
      (q('.sidebar-project-name') || { click() {} }).click();
      await sleep(400);
      switcher.opened = !!q('.sidebar-files-head .dropdown');
      switcher.options = qa('.sidebar-files-head .dropdown button').length;
    }
    out('2-reload', { names: names2, taskInB, switcher });
    return 'ok';
  } catch (e) { out('F', { fail: String(e) }); return 'e'; }
})()`;

const shellDir = path.join(repoRoot, 'packages', 'shell');
const child = spawn('pnpm', ['exec', 'electron', '.'], {
  cwd: shellDir,
  env: { ...process.env, LOOMERY_SELF_SHOT: path.join(ud, 'probe.png'), LOOMERY_USER_DATA: ud, LOOMERY_SELF_SHOT_PROBE: probe, LOOMERY_SELF_SHOT_PROBE2: probe2 },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
setTimeout(() => {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
  try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }
  const log = path.join(ud, 'electron-debug.log');
  const lines = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => l.includes('p2b-probe'))
    : [];
  console.log('---- 探针结果 ----');
  console.log(lines.join('\n') || '(无输出)');
  try { fs.rmSync(tmpA, { recursive: true, force: true }); fs.rmSync(tmpB, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}, 45000);

// 多项目真机探针：project.add（path 直传）→ projectGroups 渲染 → thread.create 绑定根 → 清理
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const tmpProject = path.join(os.tmpdir(), 'loomery-e2e-project-' + Date.now());
fs.mkdirSync(tmpProject, { recursive: true });
fs.writeFileSync(path.join(tmpProject, 'README.md'), '# 测试项目\n', 'utf8');

const realRoot = path.join(process.env.APPDATA, '@loomery', 'shell');
const ud = path.join(os.tmpdir(), 'loomery-probe-projects');
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
  const out = (tag, v) => console.log('[drag-log][proj-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  for (let i = 0; i < 30 && !window.loomery; i++) await sleep(200);
  // ① 添加项目（path 直传）
  const add = await window.loomery.invoke('project.add', { path: ${JSON.stringify(tmpProject)} });
  out('1-add', { added: add.added, roots: (add.workspaceRoots ?? []).length });
  // ② 按新项目建任务
  const created = await window.loomery.invoke('thread.create', { workspaceRoot: ${JSON.stringify(tmpProject)} });
  out('2-create', { threadId: created.threadId });
  await sleep(600);
  const list = await window.loomery.invoke('thread.list', {});
  const newest = list.sort((a, b) => b.createdAt - a.createdAt)[0];
  out('3-bind', { newestRoot: newest.workspaceRoot === ${JSON.stringify(tmpProject)}, newestRootValue: newest.workspaceRoot ?? null });
  return 'ok';
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
setTimeout(() => {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
  try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }
  const log = path.join(ud, 'electron-debug.log');
  // runner 侧读新线程 JSONL 首行（threadId 从探针日志提取；线程已删则文件已清——改为读 app 写入时的临时副本不可得，跳过）
  const lines = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => l.includes('proj-probe'))
    : [];
  console.log('---- 探针结果 ----');
  console.log(lines.join('\n') || '(无输出)');
  try { fs.rmSync(tmpProject, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}, 40000);

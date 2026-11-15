// 目录树诊断：workspaceTree 原始行（缩进/深度）+ parseTree 复算，定位「无法展开/错层」
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }
const realRoot = path.join(repoRoot, '.loomery-data');
const ud = path.join(os.tmpdir(), 'loomery-probe-tree');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
for (const f of ['config.json', 'secrets.enc', 'Local State']) {
  if (fs.existsSync(path.join(realRoot, f))) fs.copyFileSync(path.join(realRoot, f), path.join(ud, f));
}

const probe = `(async () => {
  const out = (t, v) => console.log('[drag-log][tree-probe] ' + t + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    for (let i = 0; i < 40 && !window.loomery; i++) await sleep(200);
    const lines = await window.loomery.invoke('workspace.tree', {});
    out('N', { total: lines.length });
    // 原始行：前 45 行带缩进宽度
    lines.slice(0, 45).forEach((l, i) => out('L' + i, { indent: l.length - l.trimStart().length, raw: l.trim().slice(0, 60) }));
    // parseTree 复算（与 Sidebar 同逻辑）
    const stack = [{ depth: -1, path: 'ROOT' }];
    const rows = [];
    for (const line of lines.slice(1)) {
      const t = line.trim(); if (!t) continue;
      const depth = Math.floor((line.length - line.trimStart().length) / 2);
      while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
      const parent = stack[stack.length - 1];
      const isDir = t.endsWith('/');
      rows.push({ d: depth, parent: parent.path.split(/[\\\\/]/).pop(), name: isDir ? t.slice(0, -1) : t });
      if (isDir) stack.push({ depth, path: parent.path + '\\\\' + t.slice(0, -1) });
    }
    // 可疑行：根级文件但深度>1（错层证据）
    const wrong = rows.filter((r, i) => i > 0 && r.d > 1 && !r.name.includes('/') && rows.findIndex((x) => x.name === r.name) === i);
    // 输出 docs 附近（索引定位）
    const docsIdx = rows.findIndex((r) => r.name === 'docs');
    out('DOCS', { around: rows.slice(Math.max(0, docsIdx - 1), docsIdx + 6) });
    out('SUM', { rows: rows.length, depthMax: Math.max(...rows.map((r) => r.d)), sample: rows.filter((r) => r.d >= 1).slice(0, 30).map((r) => r.d + ':' + r.parent + '<-' + r.name) });
  } catch (e) { out('F', { fail: String(e) }); }
})()`;

const child = spawn('pnpm', ['exec', 'electron', '.'], {
  cwd: path.join(repoRoot, 'packages', 'shell'),
  env: { ...process.env, LOOMERY_USER_DATA: ud, LOOMERY_SELF_SHOT: path.join(ud, 'probe.png'), LOOMERY_SELF_SHOT_PROBE: probe },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});
let stdout = '';
child.stdout.on('data', (d) => { stdout += String(d); });
child.stderr.on('data', () => {});
setTimeout(() => {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
  try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }
  // [drag-log] 走渲染层 console-message → electron-debug.log（主进程 stdout 不含）
  const logPath = path.join(ud, 'electron-debug.log');
  const lines = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.includes('tree-probe'))
    : [];
  console.log(lines.join('\n') || '(无输出)');
  process.exit(0);
}, 25000);

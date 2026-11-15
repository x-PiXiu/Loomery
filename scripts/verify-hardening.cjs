// 加固批次真机探针（#5 埋点 / #7 watcher / #9 窗口记忆）：
// ① metrics.get RPC 形状 + [metrics] boot 日志 ② 运行中向工作区根写文件 → [watcher] 日志 + 渲染层 externalChanges
// ③ 关窗后 window-state.json 落盘
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const realRoot = path.join(repoRoot, '.loomery-data');
const ud = path.join(os.tmpdir(), 'loomery-probe-hardening');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
for (const f of ['config.json', 'secrets.enc', 'Local State']) {
  if (fs.existsSync(path.join(realRoot, f))) fs.copyFileSync(path.join(realRoot, f), path.join(ud, f));
}
const sessDir = path.join(realRoot, 'sessions');
if (fs.existsSync(sessDir)) {
  for (const f of fs.readdirSync(sessDir)) fs.copyFileSync(path.join(sessDir, f), path.join(ud, 'sessions', f));
}

const probe = `(async () => {
  const out = (tag, v) => console.log('[drag-log][hard-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    for (let i = 0; i < 40 && !window.loomery; i++) await sleep(200);
    const m = await window.loomery.invoke('metrics.get', {});
    out('M', { bootMs: typeof m.bootMs === 'number', seedCount: m.seedCount, foldMs: m.foldListThreadsMs, hydrateCount: m.hydrate?.count, taskTrigger: m.taskTrigger, resident: m.residentCount });
    // 外部变更 → 渲染层 runtime.externalChanges（横幅数据源）；通过 UI 无法直读 store，
    // 改由 [watcher] 主进程日志断言（见 runner）
    // 温和关窗（#9）：走真实 close 事件链 → window-state.json 落盘（taskkill /F 不走 close）
    // 延后 5s：等 runner 的外部写文件探针（@8s）先过 watcher
    await new Promise((r) => setTimeout(r, 5000));
    await window.loomery.invoke('window.control', { action: 'close' });
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

// 启动稳定后向工作区根写入一个文件（触发 #7 watcher；workspaceRoots 来自探针 config）
setTimeout(() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'));
    const root = (cfg.workspaceRoots ?? [])[0];
    if (root) {
      // 写进独立 tmp 子目录（勿污染真实工作区根——上次残留 loomery-watch-probe.txt 进了仓库树）
      const probeDir = path.join(root, '.loomery-watch-probe-tmp');
      fs.mkdirSync(probeDir, { recursive: true });
      fs.writeFileSync(path.join(probeDir, 'probe.txt'), 'external change probe ' + Date.now(), 'utf8');
      global.__probeWatchDir = probeDir;
      console.log('[runner] touched: ' + probeDir);
    } else {
      console.log('[runner] no workspaceRoots in probe config');
    }
  } catch (e) { console.log('[runner] touch failed: ' + e); }
}, 8000);

setTimeout(() => {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
  try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }
  const logPath = path.join(ud, 'electron-debug.log');
  const uiLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const probeLines = uiLog.split(/\r?\n/).filter((l) => l.includes('hard-probe')).join('\n');
  const metricsLog = mainStdout.split(/\r?\n/).filter((l) => l.includes('[metrics]')).join('\n');
  const watcherLog = mainStdout.split(/\r?\n/).filter((l) => l.includes('[watcher]')).join('\n');
  const wsState = fs.existsSync(path.join(ud, 'window-state.json'))
    ? fs.readFileSync(path.join(ud, 'window-state.json'), 'utf8')
    : '(window-state.json 不存在)';
  console.log('---- 探针（metrics.get） ----');
  console.log(probeLines || '(无)');
  console.log('---- [metrics] 主进程日志 ----');
  console.log(metricsLog || '(无)');
  console.log('---- [watcher] 主进程日志 ----');
  console.log(watcherLog || '(无)');
  console.log('---- window-state.json（#9） ----');
  console.log(wsState);
  try { fs.rmSync(global.__probeWatchDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}, 22000);

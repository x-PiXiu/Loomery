// 编辑器重开探针（复现用户报障：换位→开文件→关全部标签→再点文件→编辑器打不开）：
// 断言关闭后再点文件，编辑器列重现且标签打开（根因=editorBus.opener 死闭包，修复=卸载注销）
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const realRoot = path.join(repoRoot, '.loomery-data');
const ud = path.join(os.tmpdir(), 'loomery-probe-editor-reopen');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
for (const f of ['config.json', 'secrets.enc', 'Local State']) {
  if (fs.existsSync(path.join(realRoot, f))) fs.copyFileSync(path.join(realRoot, f), path.join(ud, f));
}

// 选一个真实存在的工作区文件
const cfg = JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'));
const root = (cfg.workspaceRoots ?? [])[0] ?? repoRoot;
let target = null;
for (const cand of ['package.json', 'README.md', 'pnpm-workspace.yaml']) {
  const p = path.join(root, cand);
  if (fs.existsSync(p)) { target = p; break; }
}
if (!target) { console.log('[runner] no workspace file found under ' + root); process.exit(1); }
console.log('[runner] target file: ' + target);

const probe = `(async () => {
  const out = (tag, v) => console.log('[drag-log][reopen-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const state = () => ({
    tabs: qa('.tab').length,
    editorHost: !!q('.editor-host'),
    swapBtn: !!q('.swap-handle'),
  });
  try {
    for (let i = 0; i < 40 && !q('.loomery-main'); i++) await sleep(200);
    await sleep(500);
    // ① 换位（聊天/编辑器互换）
    const swap = q('.swap-handle');
    if (!swap) { out('F', { fail: 'swap-btn not found' }); return; }
    swap.click();
    await sleep(400);
    out('S', { afterSwap: state() });
    // ② 第一次点文件 → 编辑器打开
    window.loomeryDev.openInEditor(${JSON.stringify(target)});
    for (let i = 0; i < 20 && qa('.tab').length === 0; i++) await sleep(300);
    out('O1', { firstOpen: state() });
    // ③ 关掉标签页 → 编辑器列关闭
    const close = q('.tab .tab-close');
    if (!close) { out('F', { fail: 'tab-close not found' }); return; }
    close.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(600);
    out('C', { afterClose: state() });
    // ④ 再次点文件（此前死闭包会在这里无声吞掉）
    window.loomeryDev.openInEditor(${JSON.stringify(target)});
    let reopened = false;
    for (let i = 0; i < 20; i++) { if (qa('.tab').length > 0 && q('.editor-host')) { reopened = true; break; } await sleep(300); }
    out('O2', { reopened, final: state() });
    if (!reopened) out('F', { fail: 'editor did not reopen after close (stale opener?)' });
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
    ? fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.includes('reopen-probe')).join('\n')
    : '';
  console.log('---- 探针结果 ----');
  console.log(lines || '(无 reopen-probe 记录)');
  process.exit(0);
}, 40000);

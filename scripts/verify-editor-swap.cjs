// 编辑器换位保状态探针：
// ① 开文件+打草稿 → ② 点骑线互换钮 → 断言标签/激活页/草稿全部保留（修复前：本地 state 随重挂清零）
// → ③ 关标签 → ④ 再点文件重开（回归 editorBus 死闭包修复）
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const realRoot = path.join(repoRoot, '.loomery-data');
const ud = path.join(os.tmpdir(), 'loomery-probe-editor-swap');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
for (const f of ['config.json', 'secrets.enc', 'Local State']) {
  if (fs.existsSync(path.join(realRoot, f))) fs.copyFileSync(path.join(realRoot, f), path.join(ud, f));
}

const cfg = JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'));
const root = (cfg.workspaceRoots ?? [])[0] ?? repoRoot;
let target = null;
for (const cand of ['package.json', 'README.md', 'pnpm-workspace.yaml']) {
  const p = path.join(root, cand);
  if (fs.existsSync(p)) { target = p; break; }
}
if (!target) { console.log('[runner] no workspace file under ' + root); process.exit(1); }

const probe = `(async () => {
  const out = (tag, v) => console.log('[drag-log][swap-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const snap = () => ({
    tabs: qa('.tab').map((t) => t.querySelector('.tab-name')?.textContent),
    editorHost: !!q('.editor-host'),
    draft: (q('.composer-card textarea') ?? q('textarea'))?.value ?? '(no-ta)',
    taCount: qa('textarea').length,
    moduleDraft: window.loomeryDev.getComposerDraft(),
  });
  try {
    // 错误钩子：渲染层异常经 [drag-log] 通道外泄（electron-debug.log 只收 drag-log）
    window.addEventListener('error', (e) => out('ERR', { msg: String(e.message).slice(0, 160), src: e.filename ? e.filename.split(/[\\\\/]/).pop() : '' }));
    window.addEventListener('unhandledrejection', (e) => out('REJ', { msg: String(e.reason).slice(0, 160) }));
    const origErr = console.error.bind(console);
    console.error = (...a) => { origErr(...a); out('CERR', { m: a.map((x) => String(x)).join(' ').slice(0, 160) }); };
    for (let i = 0; i < 40 && !q('.loomery-main'); i++) await sleep(200);
    await sleep(500);
    // ① 开文件 + 打草稿
    window.loomeryDev.openInEditor(${JSON.stringify(target)});
    for (let i = 0; i < 20 && qa('.tab').length === 0; i++) await sleep(300);
    window.loomeryDev.insertToComposer('换位草稿测试ABC');
    await sleep(300);
    out('O1', { afterOpen: snap() });
    // ② 换位（骑线钮）→ 断言全保留
    const handle = q('.swap-handle');
    if (!handle) { out('F', { fail: 'swap-handle not found' }); return; }
    handle.click();
    await sleep(800);
    const after = snap();
    const kept = after.tabs.includes('package.json') && after.editorHost && after.draft.includes('换位草稿测试ABC');
    out('SW', { afterSwap: after, preserved: kept });
    // ③ 关标签
    const close = q('.tab .tab-close');
    if (!close) { out('F', { fail: 'tab-close not found' }); return; }
    close.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(600);
    out('C', { afterClose: { tabs: qa('.tab').length, editorHost: !!q('.editor-host') } });
    // ④ 再点文件重开（死闭包回归）
    window.loomeryDev.openInEditor(${JSON.stringify(target)});
    let reopened = false;
    for (let i = 0; i < 20; i++) { if (qa('.tab').length > 0 && q('.editor-host')) { reopened = true; break; } await sleep(300); }
    out('O2', { reopened });
    if (!kept || !reopened) out('F', { fail: kept ? 'editor did not reopen' : 'state lost on swap' });
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
    ? fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.includes('swap-probe')).join('\n')
    : '';
  console.log('---- 探针结果 ----');
  console.log(lines || '(无 swap-probe 记录)');
  process.exit(0);
}, 45000);

// 验证：① 标签页文件名窄宽度从右向左省略（tab-name ellipsis、单行、close 钉死）
// ② 面包屑窄列单行不换行、diff 标签面包屑无 'diff:' 前缀
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const realRoot = path.join(process.env.APPDATA, '@loomery', 'shell');
const ud = path.join(os.tmpdir(), 'loomery-probe-tab-ellipsis');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
const sessDir = path.join(realRoot, 'sessions');
if (fs.existsSync(sessDir)) {
  for (const f of fs.readdirSync(sessDir)) fs.copyFileSync(path.join(sessDir, f), path.join(ud, 'sessions', f));
}
// 无模型也能跑：不点发送，只开文件

const probe = `(async () => {
  const out = (tag, v) => console.log('[drag-log][tab-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  for (let i = 0; i < 30 && !window.loomeryDev; i++) await sleep(200);
  // 开两个文件（深路径 + 普通），把编辑列压窄
  await window.loomeryDev.openInEditor('E:\\\\workspace\\\\Demo\\\\MyDemo\\\\Loomery\\\\e2e-ws\\\\test.txt');
  await sleep(800);
  await window.loomeryDev.openInEditor('E:\\\\workspace\\\\Demo\\\\MyDemo\\\\Loomery\\\\packages\\\\agent-core\\\\src\\\\adapters\\\\model-registry.ts');
  await sleep(800);
  const col = qa('.loomery-main > .col').find((c) => c.querySelector('.editor-panel'));
  if (!col) { out('F', { fail: 'no editor col' }); return 'f'; }
  col.style.flex = '0 0 300px'; col.style.width = '300px';
  await sleep(400);
  const name = q('.tab.active .tab-name');
  const nameStyle = name ? getComputedStyle(name) : null;
  const nameRect = name ? name.getBoundingClientRect() : null;
  const closeBtn = q('.tab.active .tab-close');
  const closeRect = closeBtn ? closeBtn.getBoundingClientRect() : null;
  const tabRect = q('.tab.active').getBoundingClientRect();
  // diff 面包屑：开 diff 标签
  const diffTab = qa('.tab').find((t) => t.textContent.includes('Diff'));
  let bcNoPrefix = 'no-diff-tab';
  let bcHeight = -1;
  if (diffTab) {
    diffTab.click();
    await sleep(1000);
    const bc = q('.breadcrumb');
    bcHeight = bc ? Math.round(bc.getBoundingClientRect().height) : -1;
    bcNoPrefix = bc ? !bc.textContent.includes('diff:') : 'no-bc';
  }
  // diff 面包屑：回任务列表开任务，点汇总卡审查开 diff 标签
  const back = q('button[title="返回任务列表"]');
  if (back) back.click();
  await sleep(500);
  for (const it of qa('.task-item').slice(0, 4)) { it.click(); await sleep(800); if (q('.turn-summary .ts-file')) break; }
  const review = q('.turn-summary .ts-file .ts-actions button');
  if (review) {
    review.click();
    for (let i = 0; i < 8; i++) { await sleep(500); if (q('.monaco-diff-editor')) break; }
    await sleep(800);
    const bc = q('.breadcrumb');
    const bcText = bc ? bc.textContent : '';
    out('B', {
      bcHeight: bc ? Math.round(bc.getBoundingClientRect().height) : -1,
      bcSingleLine: bc ? Math.round(bc.getBoundingClientRect().height) <= 40 : false,
      bcNoDiffPrefix: !bcText.includes('diff:'),
      bcTextHead: bcText.slice(0, 40),
    });
  }
  out('R', {
    tabNameEllipsis: nameStyle ? nameStyle.textOverflow : 'missing',
    tabNameNowrap: nameStyle ? nameStyle.whiteSpace : 'missing',
    nameFitsTab: nameRect && closeRect ? nameRect.right <= closeRect.left + 1 : false,
    tabWidth: Math.round(tabRect.width),
    diffBcNoPrefix: bcNoPrefix,
    bcSingleLine: bcHeight > 0 && bcHeight <= 40,
    bcHeight,
  });
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
  const lines = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => l.includes('tab-probe'))
    : [];
  console.log('---- 探针结果 ----');
  console.log(lines.join('\n') || '(无输出)');
  process.exit(0);
}, 40000);

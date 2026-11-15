// 验证：① workspaceTree 含第三层及更深文件（此前 depth>2 裁掉，docs/mockups/png/page-1.png 为第四层样本）
// ② 文件树点击图片 → 图片标签打开且真实渲染（img naturalWidth>0，src 为 data: base64）
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const realRoot = path.join(process.env.APPDATA, '@loomery', 'shell');
const ud = path.join(os.tmpdir(), 'loomery-probe-image-tree');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
const sessDir = path.join(realRoot, 'sessions');
if (fs.existsSync(sessDir)) {
  for (const f of fs.readdirSync(sessDir)) fs.copyFileSync(path.join(sessDir, f), path.join(ud, 'sessions', f));
}

const probe = `(async () => {
  const out = (tag, v) => console.log('[drag-log][img-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  try {
    for (let i = 0; i < 25; i++) { if (q('.task-item')) break; await sleep(200); }
    // ① 树数据：深层图片文件在不在
    const lines = await window.loomery.invoke('workspace.tree', {});
    const pngLines = lines.filter((l) => /\.(png|jpg|jpeg|gif|webp)$/i.test(l.trim()));
    out('0-tree', {
      totalLines: lines.length,
      imageFiles: pngLines.length,
      deepSample: lines.some((l) => l.includes('page-1.png')),
      depth4Sample: lines.filter((l) => l.trim().split('\\\\').length === 1 && (l.match(/\\S/g) || []).length > 0 && l.startsWith('    ')).length,
    });
    // ② 文件树点图片
    let filesBtn = q('button[title="查看该项目文件"]');
    out('0b-mode', { sidebar: !!q('.sidebar'), tasksMode: !!q('.sidebar-actions'), filesMode: !!q('.sidebar-files-head'), btn: !!filesBtn });
    if (!filesBtn && q('.tree-row.file')) filesBtn = null;
    if (filesBtn) filesBtn.click();
    for (let i = 0; i < 10; i++) { await sleep(300); if (q('.tree-row')) break; }
    const imgRow = qa('.tree-row.file').find((r) => /page-1\\.png$/i.test(r.textContent));
    if (!imgRow) { out('F', { fail: 'image row not in tree', rows: qa('.tree-row').length }); return 'f'; }
    imgRow.click();
    let imgEl = null;
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      imgEl = q('.image-view img');
      if (imgEl && imgEl.naturalWidth > 0) break;
    }
    out('R', {
      tabTitle: (qa('.editor-panel .tab').map((t) => t.textContent.trim().slice(0, 30))),
      imgTabOpen: !!q('.image-view'),
      srcIsData: imgEl ? imgEl.src.startsWith('data:image/') : false,
      naturalWidth: imgEl ? imgEl.naturalWidth : 0,
      rendered: imgEl ? imgEl.naturalWidth > 0 : false,
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
    probeLines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.includes('img-probe')).join('\n');
  }
  console.log('---- 探针结果 ----');
  console.log(probeLines || '(无 img-probe 记录)');
  process.exit(0);
}, 45000);

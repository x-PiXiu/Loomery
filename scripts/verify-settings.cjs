// 设置页真机探针：预设网格渲染 → 点预设建供应商 → 详情预填 → 展平 entries 断言
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const realRoot = path.join(process.env.APPDATA, '@loomery', 'shell');
const ud = path.join(os.tmpdir(), 'loomery-probe-settings');
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
  const out = (tag, v) => console.log('[drag-log][set-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  for (let i = 0; i < 25 && !window.loomery; i++) await sleep(200);
  // 打开设置（账户区齿轮 → loomery:open-settings 事件同源）
  window.dispatchEvent(new CustomEvent('loomery:open-settings'));
  await sleep(600);
  // 整页断言：覆盖全窗 + 返回按钮
  const page = q('.settings-page');
  const pr = page ? page.getBoundingClientRect() : null;
  out('0-page', {
    coversWindow: pr ? pr.width >= window.innerWidth - 2 && pr.height >= window.innerHeight - 2 : false,
    pageW: pr ? Math.round(pr.width) : -1,
    pageH: pr ? Math.round(pr.height) : -1,
    backBtn: !!q('.settings-page-head button'),
  });
  // 外观卡 + 数据目录行断言（切页即回）
  const navApp = qa('.settings-nav-item').find((b) => b.textContent === '外观');
  if (navApp) { navApp.click(); await sleep(400); }
  const themeCards = qa('.theme-card').length;
  const navData = qa('.settings-nav-item').find((b) => b.textContent === '数据目录');
  if (navData) { navData.click(); await sleep(400); }
  const dataRows = qa('.datadir-row').length;
  const navModels = qa('.settings-nav-item').find((b) => b.textContent === '模型设置');
  if (navModels) { navModels.click(); await sleep(400); }
  out('0-page2', { themeCards, dataRows });
  out('0-shell', {
    navItems: qa('.settings-nav-item').map((b) => b.textContent.trim()).slice(0, 5),
    modelsPane: !!q('.models-two-pane'),
  });
  // 添加供应商 → 预设网格
  const addBtn = qa('button').find((b) => b.textContent.includes('添加供应商'));
  if (!addBtn) { out('F', { fail: 'no add button' }); return 'f'; }
  addBtn.click();
  await sleep(500);
  const cards = qa('.preset-card');
  out('1-presets', { cards: cards.length, svgIcons: cards.filter((c) => c.querySelector('svg')).length, names: cards.slice(0, 12).map((c) => c.textContent.trim().slice(0, 10)) });
  // 点 DeepSeek 预设 → 详情预填
  const ds = cards.find((c) => c.textContent.includes('DeepSeek'));
  if (!ds) { out('F', { fail: 'no deepseek preset' }); return 'f'; }
  ds.click();
  await sleep(700);
  const urlInput = qa('.provider-form input').find((i) => (i.value || '').includes('deepseek'));
  out('2-detail', {
    detailShown: !!q('.provider-form'),
    urlPrefilled: urlInput ? urlInput.value : 'missing',
    modelRows: qa('.model-row').length,
    modelIds: qa('.model-row .model-id-input').map((i) => i.value),
  });
  // 展平断言：configGet.entries 应含 deepseek-chat 且 enabled
  const cfg = JSON.parse(await window.loomery.invoke('config.get', {}).then(JSON.stringify));
  const flat = (cfg.models.entries ?? []).filter((e) => (e.modelId || '').includes('deepseek'));
  out('3-flatten', {
    flatCount: flat.length,
    enabled: flat.map((e) => e.enabled),
    apiKeyRef: flat.map((e) => e.apiKeyRef),
  });
  // 返回工作区：点击后整页关闭
  (q('.settings-page-head button') || { click() {} }).click();
  await sleep(400);
  out('Z-close', { pageClosed: !q('.settings-page') });
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
    ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => l.includes('set-probe'))
    : [];
  console.log('---- 探针结果 ----');
  console.log(lines.join('\n') || '(无输出)');
  process.exit(0);
}, 40000);

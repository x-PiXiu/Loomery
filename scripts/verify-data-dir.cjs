// 双启动验证数据目录解析链（无环境变量介入）：
// 启动1：默认应为 <仓库>\.loomery-data（开发期便携）；调 userData.set 写指路条+迁移到临时目录
// 启动2：userData.get.current 应为临时目录（指路条重定向生效）
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
const tmpTarget = path.join(os.tmpdir(), 'loomery-data-redirect-target');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }
fs.rmSync(tmpTarget, { recursive: true, force: true });

// 清理启动1可能的指路条残留，保证从默认开始
const pointer = path.join(repoRoot, '.loomery-data', 'data-dir.txt');
if (fs.existsSync(pointer)) fs.rmSync(pointer);

function launch(probe, onDone) {
  const shellDir = path.join(repoRoot, 'packages', 'shell');
  const child = spawn('pnpm', ['exec', 'electron', '.'], {
    cwd: shellDir,
    env: { ...process.env, LOOMERY_SELF_SHOT: path.join(os.tmpdir(), 'dd-probe.png'), LOOMERY_SELF_SHOT_PROBE: probe },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  setTimeout(() => {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
    try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }
    onDone();
  }, 22000);
}

const probe1 = `(async () => {
  const out = (v) => console.log('[drag-log][dd-probe] L1 ' + JSON.stringify(v));
  for (let i = 0; i < 25 && !window.loomery; i++) await new Promise((r) => setTimeout(r, 200));
  const info = await window.loomery.invoke('userData.get', {});
  const isPortableDefault = info.current.toLowerCase().includes('.loomery-data');
  const set = await window.loomery.invoke('userData.set', { dir: ${JSON.stringify(tmpTarget)} });
  out({ current: info.current, isPortableDefault, set });
})()`;

const probe2 = `(async () => {
  const out = (v) => console.log('[drag-log][dd-probe] L2 ' + JSON.stringify(v));
  for (let i = 0; i < 25 && !window.loomery; i++) await new Promise((r) => setTimeout(r, 200));
  const info = await window.loomery.invoke('userData.get', {});
  const redirected = info.current === ${JSON.stringify(tmpTarget)};
  out({ current: info.current, redirected, redirect: info.redirect });
})()`;

launch(probe1, () => {
  console.log('---- L1 结果 ----');
  console.log(readLog('L1') || '(无)');
  launch(probe2, () => {
    console.log('---- L2 结果 ----');
    console.log(readLog('L2') || '(无)');
    // 清理：移除指路条与临时目录，恢复默认；目标目录若被应用使用中可能锁定，尽力清理
    try { fs.rmSync(pointer); } catch { /* ignore */ }
    try { fs.rmSync(tmpTarget, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(0);
  });
});

function readLog(tag) {
  // L1 落默认 .loomery-data；L2 营运指路条后落重定向目标（该文件里有迁移带过去的 L1 旧行，按 tag 过滤）
  const candidates = tag === 'L1'
    ? [path.join(repoRoot, '.loomery-data', 'electron-debug.log')]
    : [path.join(tmpTarget, 'electron-debug.log')];
  const lines = [];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      for (const l of fs.readFileSync(c, 'utf8').split(/\r?\n/)) if (l.includes('dd-probe') && l.includes(tag)) lines.push(l);
    }
  }
  return [...new Set(lines)].join('\n');
}

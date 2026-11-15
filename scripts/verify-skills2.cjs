// 技能导入修复探针：来源应含单文件 .md 形态 → 按目录名导入多个 → 断言 imported==选择数 → 检查行内无杂散文本
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const realRoot = path.join(process.env.APPDATA, '@loomery', 'shell');
const ud = path.join(os.tmpdir(), 'loomery-probe-skills2');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
const sessDir = path.join(realRoot, 'sessions');
if (fs.existsSync(sessDir)) {
  for (const f of fs.readdirSync(sessDir)) fs.copyFileSync(path.join(sessDir, f), path.join(ud, 'sessions', f));
}

const probe = `(async () => {
  const out = (tag, v) => console.log('[drag-log][skill2-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  for (let i = 0; i < 30 && !window.loomery; i++) await sleep(200);
  // ① 来源扫描：应包含单文件形态
  const sources = await window.loomery.invoke('skill.sources', {});
  const cc = sources.find((s) => s.id === 'claude-code');
  out('1-scan', {
    sources: sources.map((s) => s.id + ':' + s.count),
    singleFileCount: cc ? cc.skills.filter((k) => k.singleFile).length : -1,
  });
  // ② 选 6 个（混合目录/单文件）导入
  const picks = cc.skills.slice(0, 6).map((k) => ({ dirName: k.dirName, singleFile: !!k.singleFile }));
  const imp = await window.loomery.invoke('skill.import', { sourceDir: cc.dir, skills: picks });
  out('2-import', { picked: picks.length, imported: imp.imported, errors: imp.errors });
  // ③ 清单数量 + 行内无杂散文本
  await sleep(300);
  const list = await window.loomery.invoke('skill.list', {});
  const rows = qa('.skill-row');
  const stray = rows.filter((r) => {
    const kind = r.querySelector('.skill-body .skill-name')?.textContent || '';
    return />>|undefined/.test(kind);
  }).length;
  out('R', {
    listTotal: list.length,
    importedPresent: picks.filter((p) => list.some((s) => s.dirName === p.dirName)).length,
    rowSample: rows[0] ? rows[0].textContent.trim().slice(0, 60) : 'none',
    strayArtifacts: stray,
  });
  return 'ok';
})()`;
// 渲染层无独立 qa——改内联

const shellDir = path.join(repoRoot, 'packages', 'shell');
const child = spawn('pnpm', ['exec', 'electron', '.'], {
  cwd: shellDir,
  env: { ...process.env, LOOMERY_SELF_SHOT: path.join(ud, 'probe.png'), LOOMERY_USER_DATA: ud, LOOMERY_SELF_SHOT_PROBE: probe.replace("  function q2() { return q; }", "") },
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
    ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => l.includes('skill2-probe'))
    : [];
  console.log('---- 探针结果 ----');
  console.log(lines.join('\n') || '(无输出)');
  // runner 清理导入的技能（探针 userData 一次性，不必清）
  process.exit(0);
}, 40000);

// 技能设置探针：来源扫描（应发现本机 .claude/.zcode/.agents 技能）→ 导入一个到 userData/skills → 清理
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const realRoot = path.join(process.env.APPDATA, '@loomery', 'shell');
const ud = path.join(os.tmpdir(), 'loomery-probe-skills');
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
  const out = (tag, v) => console.log('[drag-log][skill-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 30 && !window.loomery; i++) await sleep(200);
  // ① 来源扫描
  const sources = await window.loomery.invoke('skill.sources', {});
  out('1-sources', { sources: sources.map((s) => ({ id: s.id, count: s.count, first: s.skills[0]?.name })) });
  // ② 导入第一个来源的第一个技能
  const src = sources.find((s) => s.count > 0);
  if (!src) { out('F', { fail: 'no source with skills' }); return 'f'; }
  const imp = await window.loomery.invoke('skill.import', { sourceDir: src.dir, names: [src.skills[0].name] });
  out('2-import', { imported: imp.imported, errors: imp.errors });
  // ③ 清单应包含新技能；停用开关走 config
  const list = await window.loomery.invoke('skill.list', {});
  out('3-list', { total: list.length, hasImported: list.some((s) => s.name === src.skills[0].name) });
  // ④ 停用 → config.skills.disabled 持久化
  await window.loomery.invoke('config.save', { skills: { disabled: [src.skills[0].name] } });
  const cfg = JSON.parse(await window.loomery.invoke('config.get', {}).then(JSON.stringify));
  out('4-disable', { disabledPersisted: (cfg.skills?.disabled ?? []).includes(src.skills[0].name) });
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
    ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => l.includes('skill-probe'))
    : [];
  console.log('---- 探针结果 ----');
  console.log(lines.join('\n') || '(无输出)');
  process.exit(0);
}, 40000);

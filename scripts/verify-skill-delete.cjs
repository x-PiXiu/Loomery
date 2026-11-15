// 技能删除探针：导入两个 → 删除一个（成功+disabled 联动）→ 删除项目级（拒绝）
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const realRoot = path.join(process.env.APPDATA, '@loomery', 'shell');
const ud = path.join(os.tmpdir(), 'loomery-probe-skilldel');
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
  const out = (tag, v) => console.log('[drag-log][del-probe] ' + tag + ' ' + JSON.stringify(v));
  for (let i = 0; i < 30 && !window.loomery; i++) await new Promise((r) => setTimeout(r, 200));
  // ① 导入两个技能（用户级）
  const sources = await window.loomery.invoke('skill.sources', {});
  const cc = sources.find((s) => s.id === 'claude-code');
  const picks = cc.skills.slice(0, 2).map((k) => ({ dirName: k.dirName, singleFile: !!k.singleFile }));
  const imp = await window.loomery.invoke('skill.import', { sourceDir: cc.dir, skills: picks });
  out('1-import', { imported: imp.imported });
  // ② 停用标记其中一个（验证删除联动清理）
  await window.loomery.invoke('config.save', { skills: { disabled: [picks[0].dirName] } });
  // ③ 删除第一个
  const del = await window.loomery.invoke('skill.delete', { name: picks[0].dirName });
  out('2-delete', { ok: del.ok });
  // ④ 清单核对：被删的不在，另一个还在
  const list = await window.loomery.invoke('skill.list', {});
  out('3-list', {
    deletedGone: !list.some((s) => s.dirName === picks[0].dirName),
    otherKept: list.some((s) => s.dirName === picks[1].dirName),
    tombstoneCleared: !((await window.loomery.invoke('config.get', {})).skills?.disabled ?? []).includes(picks[0].dirName),
  });
  // ⑤ 项目级删除拒绝
  const projSkill = list.find((s) => s.scope === 'project');
  if (projSkill) {
    const rej = await window.loomery.invoke('skill.delete', { name: projSkill.name });
    out('4-project', { rejected: !rej.ok, error: rej.error });
  } else {
    out('4-project', { skipped: '无项目级技能可测' });
  }
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
    ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => l.includes('del-probe'))
    : [];
  console.log('---- 探针结果 ----');
  console.log(lines.join('\n') || '(无输出)');
  process.exit(0);
}, 40000);

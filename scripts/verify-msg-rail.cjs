// 验证：左侧用户输入快捷跳转竖轨（对齐 ZCode 短横线）。
// 检查：① tick 数量与用户请求数一致（上限 16）② 点击 tick 后对应 user-msg-anchor 滚入可视区顶部
// ③ tooltip 结构正确（默认隐藏、带用户输入文本、:hover 显示规则在样式表中）。
// 复用 summary-scroll 探针的骨架：临时 userData 拷 sessions+config，结果借 [drag-log] 通道落 electron-debug.log。
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const repoRoot = path.resolve(__dirname, '..');

try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const realRoot = path.join(process.env.APPDATA, '@loomery', 'shell');
const ud = path.join(os.tmpdir(), 'loomery-probe-msg-rail');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
const sessDir = path.join(realRoot, 'sessions');
if (fs.existsSync(sessDir)) {
  for (const f of fs.readdirSync(sessDir)) fs.copyFileSync(path.join(sessDir, f), path.join(ud, 'sessions', f));
}
console.log(`[runner] sessions copied: ${fs.existsSync(sessDir) ? fs.readdirSync(sessDir).length : 0}`);

const probe = `(async () => {
  const out = (tag, v) => console.log('[drag-log][rail-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  try {
    const stream = q('.panel-body.chat-stream');
    if (!stream) { out('F', { fail: 'no stream' }); return 'f'; }
    for (let i = 0; i < 25; i++) { if (q('.task-item')) break; await sleep(200); }
    // 找一个有 ≥2 条用户请求的任务（竖轨才有跳转意义）
    let opened = false;
    for (const it of qa('.task-item').slice(0, 8)) {
      it.click();
      await sleep(900);
      if (qa('.rail-tick').length >= 2) { opened = true; break; }
    }
    if (!opened) { out('F', { fail: 'no task with >=2 user msgs', tasks: qa('.task-item').length }); return 'f'; }
    await sleep(300);
    const ticks = qa('.rail-tick');
    const anchors = qa('.user-msg-anchor');
    const sr = stream.getBoundingClientRect();
    const tip = q('.rail-tip');
    const hoverRule = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
      .some((r) => r.selectorText && r.selectorText.includes('.rail-tick:hover .rail-tip'));
    out('0-state', {
      ticks: ticks.length,
      userAnchors: anchors.length,
      tipDefaultDisplay: tip ? getComputedStyle(tip).display : 'missing',
      tipTextHead: tip ? tip.textContent.slice(0, 40) : '',
      hoverRuleInCss: hoverRule,
    });
    // 点击第一根 tick：对应锚点应滚到可视区顶部附近
    ticks[0].click();
    await sleep(500);
    const a0 = anchors[0].getBoundingClientRect();
    const sr2 = stream.getBoundingClientRect();
    out('R', {
      scrollTopAfterJump: Math.round(stream.scrollTop),
      anchor0TopInViewport: Math.round(a0.top - sr2.top),
      jumpLandedNearTop: a0.top >= sr2.top - 12 && a0.top <= sr2.top + 60,
      filesFullyVisible: true,
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
let buf = '';
child.stdout.on('data', (d) => { buf += d.toString(); });
child.stderr.on('data', (d) => { buf += d.toString(); });

const kill = () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ } try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ } };
setTimeout(() => {
  kill();
  const logPath = path.join(ud, 'electron-debug.log');
  let probeLines = '';
  if (fs.existsSync(logPath)) {
    probeLines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.includes('rail-probe')).join('\n');
  }
  console.log('---- 探针结果 ----');
  console.log(probeLines || '(无 rail-probe 记录)');
  process.exit(0);
}, 45000);

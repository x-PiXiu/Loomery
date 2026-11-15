// 验证：汇总卡"展开文件列表"在过程框展开（滚动区变长）后是否仍可见。
// 用户报告：过程框展开后点汇总卡展开按钮，列表像"空的"。
// 根因假设：汇总卡被推到滚动可视区底缘之下，展开的新内容在 fold 下方且滚动位置不动。
// 修复：ts-head 展开时 rAF scrollIntoView({block:'nearest'})。
// 本脚本：拷真实 sessions+config 到临时 userData → 打开有 ts-file 行的任务 → 滚到底 →
// 展开过程框 → 折叠再展开汇总卡（用户动作）→ 测量 .ts-files 是否完整落在滚动可视区内。
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const repoRoot = path.resolve(__dirname, '..');

// 0. 清理可能残留的探针孤儿 electron（占单实例锁会让新探针秒退）
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 没有残留 */ }

// 1. 临时 userData：只拷 sessions + config（运行中的真实 userData leveldb 被锁，不能整拷）
const realRoot = path.join(process.env.APPDATA, '@loomery', 'shell');
const ud = path.join(os.tmpdir(), 'loomery-probe-summary-scroll');
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
const sessionCount = fs.existsSync(sessDir) ? fs.readdirSync(sessDir).length : 0;
console.log(`[runner] sessions copied: ${sessionCount}`);

// 2. 探针 JS（6.5s 时在渲染层执行；所有出口统一走 [drag-log] 落盘通道）
const probe = `(async () => {
  const out = (tag, v) => console.log('[drag-log][summary-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  try {
    // 给 scrollIntoView 装记录仪：谁调的、参数、调用时自身 bottom
    window.__siv = [];
    const origSiv = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (o) {
      window.__siv.push([this.className, JSON.stringify(o), Math.round(this.getBoundingClientRect().top), Math.round(this.getBoundingClientRect().bottom)]);
      return origSiv.call(this, o);
    };
    const stream = q('.panel-body.chat-stream');
    if (!stream) { out('F', { fail: 'no stream' }); return 'f'; }
    for (let i = 0; i < 25; i++) { if (q('.task-item')) break; await sleep(200); }
    const items = qa('.task-item');
    let opened = false;
    for (const it of items.slice(0, 8)) {
      it.click();
      await sleep(900);
      if (q('.turn-summary .ts-file')) { opened = true; break; }
    }
    if (!opened) { out('F', { fail: 'no task with ts-file rows', tasks: items.length }); return 'f'; }
    const snap = (tag) => {
      const cards = qa('.turn-summary').map((c, i) => ({
        i,
        top: Math.round(c.getBoundingClientRect().top),
        bottom: Math.round(c.getBoundingClientRect().bottom),
        files: c.querySelectorAll('.ts-file').length,
      }));
      out(tag, {
        scrollTop: Math.round(stream.scrollTop), scrollH: stream.scrollHeight, clientH: stream.clientHeight,
        cards, sivCalls: window.__siv.splice(0),
      });
    };
    stream.scrollTop = stream.scrollHeight; // 用户盯着最新内容 = 滚动区在底部
    await sleep(250);
    snap('0-bottom');
    const proc = q('.turn-process summary');
    if (proc) { proc.click(); await sleep(500); }
    snap('1-procOpen');
    const heads = qa('.turn-summary .ts-head');
    const head = heads[heads.length - 1]; // 最后一张卡的头部（最新一轮）
    head.click(); await sleep(250);  // 折叠
    snap('2-collapsed');
    head.click(); await sleep(400);  // 再展开（用户动作，修复应在此锚回可视区）
    await sleep(300);
    snap('3-reexpanded');
    const sr = stream.getBoundingClientRect();
    const lastCard = qa('.turn-summary').pop();
    const files = lastCard ? lastCard.querySelector('.ts-files') : null;
    const fr = files ? files.getBoundingClientRect() : null;
    out('R', {
      streamBottom: Math.round(sr.bottom),
      lastCardFiles: fr ? { top: Math.round(fr.top), bottom: Math.round(fr.bottom), h: Math.round(fr.height) } : null,
      filesFullyVisible: fr ? fr.height > 0 && fr.top >= sr.top - 1 && fr.bottom <= sr.bottom + 1 : false,
    });
    return 'ok';
  } catch (e) { out('F', { fail: String(e) }); return 'e'; }
})()`;

// 3. 启动（直跑 electron：shell 主进程未改动无需重建；结果走 electron-debug.log 而非 stdout）
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
    probeLines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.includes('summary-probe')).join('\n');
  }
  console.log('---- 探针结果 ----');
  console.log(probeLines || '(无 summary-probe 记录)');
  console.log('---- stdout 尾部 ----');
  console.log(buf.slice(-600));
  process.exit(0);
}, 45000);

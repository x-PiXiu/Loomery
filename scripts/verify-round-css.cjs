// 验证本轮四项 CSS/渲染修改：
// ① diff compactMode：窄宽 inline 视图下原始行号列隐藏（original view-lines 宽度=0）
// ② 聊天头图标放大（width attr=18/19）③ 刻痕竖轨容器查询自动隐藏（强制改宽→隐藏→还原→滑出）
// ④ 工具行不换行收缩语义 + 文件树图标不消失（computed style 断言）
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const realRoot = path.join(process.env.APPDATA, '@loomery', 'shell');
const ud = path.join(os.tmpdir(), 'loomery-probe-round-css');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
const sessDir = path.join(realRoot, 'sessions');
if (fs.existsSync(sessDir)) {
  for (const f of fs.readdirSync(sessDir)) fs.copyFileSync(path.join(sessDir, f), path.join(ud, 'sessions', f));
}
console.log(`[runner] sessions copied: ${fs.existsSync(sessDir) ? fs.readdirSync(sessDir).length : 0}`);

const probe = `(async () => {
  const out = (tag, v) => console.log('[drag-log][css-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const cs = (el, p) => (el ? getComputedStyle(el)[p] : 'missing');
  try {
    const stream = q('.panel-body.chat-stream');
    if (!stream) { out('F', { fail: 'no stream' }); return 'f'; }
    for (let i = 0; i < 25; i++) { if (q('.task-item')) break; await sleep(200); }
    let opened = false;
    for (const it of qa('.task-item').slice(0, 8)) {
      it.click();
      await sleep(900);
      if (q('.turn-summary .ts-file')) { opened = true; break; }
    }
    if (!opened) { out('F', { fail: 'no task with ts-file rows' }); return 'f'; }
    await sleep(300);

    // ② 头部图标尺寸（svg width 属性）与触达区（含 padding 计算方式诊断）
    const headIcon = q('.chat-header-tools .tool-icon');
    out('A-header', {
      iconW: headIcon ? headIcon.getAttribute('width') : 'missing',
      hitBox: headIcon ? Math.round(headIcon.getBoundingClientRect().width) : 0,
      padding: cs(headIcon, 'padding'),
      boxSizing: cs(headIcon, 'boxSizing'),
      globalBoxSizing: cs(document.body, 'boxSizing'),
    });

    // ④ 文件树收缩语义：切到文件模式（项目行"查看该项目文件"按钮）后量 svg/名称
    const filesBtn = q('button[title="查看该项目文件"]');
    if (filesBtn) {
      filesBtn.click();
      for (let i = 0; i < 10; i++) { await sleep(300); if (q('.tree-row')) break; }
    }
    out('B-rows', {
      toolHeadWrap: cs(q('.tool-line-head'), 'flexWrap'),
      toolLabelNowrap: cs(q('.tool-line-label'), 'whiteSpace'),
      toolArgMinWidth: cs(q('.tool-line-arg'), 'minWidth'),
      treeSvgShrink: cs(q('.tree-row > svg'), 'flexShrink'),
      treeSpanMinWidth: cs(q('.tree-row > span'), 'minWidth'),
      treeSpanOverflow: cs(q('.tree-row > span'), 'textOverflow'),
    });

    // ③ 刻痕竖轨：容器查询随聊天列宽度自动隐藏/滑出（先强制宽档看滑出，再窄档看隐藏）
    const panel = q('.chat-panel');
    const rail = q('.msg-rail');
    if (!panel || !rail) { out('F', { fail: 'no rail', panel: !!panel }); return 'f'; }
    const railState = () => ({ w: Math.round(panel.getBoundingClientRect().width), opacity: cs(rail, 'opacity'), visibility: cs(rail, 'visibility') });
    panel.style.flex = '0 0 900px'; panel.style.width = '900px';
    await sleep(350);
    const wide = railState();
    panel.style.flex = '0 0 380px'; panel.style.width = '380px';
    await sleep(350);
    const narrow = railState();
    panel.style.flex = ''; panel.style.width = '';
    await sleep(350);
    const restored = railState();
    out('C-rail', {
      containerType: cs(panel, 'containerType'),
      wide, narrow, restored,
      hidesWhenNarrow: narrow.visibility === 'hidden',
      returnsWhenWide: wide.visibility === 'visible' && wide.opacity === '1',
    });

    // ① diff compactMode：点审查开 diff 标签（轮询 8s），量 original/modified 内容区宽度
    const btns = qa('.turn-summary .ts-file .ts-actions button');
    let diffOpened = false;
    for (const b of btns) {
      b.click();
      for (let i = 0; i < 8; i++) {
        await sleep(1000);
        if (q('.monaco-diff-editor')) { diffOpened = true; break; }
      }
      if (diffOpened) break;
    }
    if (diffOpened) {
      await sleep(1500);
      const geo = () => {
        const de = q('.monaco-diff-editor');
        const col = qa('.loomery-main > .col').find((c) => c.querySelector('.monaco-diff-editor'));
        return {
          colW: col ? Math.round(col.getBoundingClientRect().width) : -1,
          deW: de ? Math.round(de.getBoundingClientRect().width) : -1,
          sash: !!q('.monaco-diff-editor .sash'),
          editors: qa('.monaco-diff-editor > .monaco-editor').map((m) => Math.round(m.getBoundingClientRect().width)),
        };
      };
      const atOpen = geo();
      const diffCol = qa('.loomery-main > .col').find((c) => c.querySelector('.monaco-diff-editor'));
      let atNarrow = {};
      let atWide = {};
      if (diffCol) {
        diffCol.style.flex = '0 0 420px'; diffCol.style.width = '420px';
        await sleep(800);
        atNarrow = geo();
        diffCol.style.flex = ''; diffCol.style.width = '';
        await sleep(800);
        atWide = geo();
      }
      out('D-diff', { atOpen, atNarrow, atWide });
    } else {
      out('D-diff', { skipped: 'diff editor never appeared', editorPanel: !!q('.editor-panel'), reviewBtns: btns.length });
    }
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
    probeLines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.includes('css-probe') || l.includes('[diff]')).join('\n');
  }
  console.log('---- 探针结果 ----');
  console.log(probeLines || '(无 css-probe 记录)');
  process.exit(0);
}, 60000);

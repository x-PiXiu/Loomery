// 复现"点文件打不开编辑器"回归 + 找 diff 页"展开"控件。
// 链路：打开任务 → 切文件模式 → 点 .tree-row.file → 轮询编辑器列/文本标签/Monaco。
// 同时点汇总卡"打开"、点审查开 diff 并转储 diff 内可展开类控件。结果借 [drag-log] 落盘。
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const realRoot = path.join(process.env.APPDATA, '@loomery', 'shell');
const ud = path.join(os.tmpdir(), 'loomery-probe-editor-open');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
const sessDir = path.join(realRoot, 'sessions');
if (fs.existsSync(sessDir)) {
  for (const f of fs.readdirSync(sessDir)) fs.copyFileSync(path.join(sessDir, f), path.join(ud, 'sessions', f));
}

const probe = `(async () => {
  const out = (tag, v) => console.log('[drag-log][open-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  try {
    const stream = q('.panel-body.chat-stream');
    if (!stream) { out('F', { fail: 'no stream' }); return 'f'; }
    window.addEventListener('error', (e) => out('WIN-ERR', { msg: String(e.message) }));
    for (let i = 0; i < 25; i++) { if (q('.task-item')) break; await sleep(200); }
    for (const it of qa('.task-item').slice(0, 8)) {
      it.click();
      await sleep(900);
      if (q('.turn-summary .ts-file')) break;
    }
    // ① 文件树点文件
    const filesBtn = q('button[title="查看该项目文件"]');
    filesBtn.click();
    for (let i = 0; i < 10; i++) { await sleep(300); if (q('.tree-row')) break; }
    const fileRow = q('.tree-row.file');
    out('0-tree', { rows: qa('.tree-row').length, fileRow: fileRow ? fileRow.textContent.slice(0, 30) : 'missing' });
    if (fileRow) {
      fileRow.click();
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        if (q('.editor-panel .tab')) break;
      }
      out('1-afterTreeClick', {
        alive: !!q('.loomery-root'),
        cols: qa('.loomery-main > .col').length,
        editorPanel: !!q('.editor-panel'),
        tabs: qa('.editor-panel .tab').map((t) => t.textContent.slice(0, 24)),
        monacoText: !!q('.editor-panel .monaco-editor .view-lines'),
        chatAlive: !!q('.chat-panel'),
      });
    }
    // ② 汇总卡"打开"（先回任务列表再开任务，保证汇总卡在）
    const openBtn = q('.turn-summary .ts-file .ts-actions button:nth-child(2)');
    if (openBtn) {
      openBtn.click();
      for (let i = 0; i < 6; i++) { await sleep(500); if (q('.editor-panel .tab')) break; }
      out('2-afterOpenBtn', {
        tabs: qa('.editor-panel .tab').map((t) => t.textContent.slice(0, 24)),
        monacoText: !!q('.editor-panel .monaco-editor .view-lines'),
      });
    }
    // ③ diff：默认收起（单栏仅修改后）→ 点对照展开（双栏）→ 再收起
    const reviewBtn = q('.turn-summary .ts-file .ts-actions button');
    if (reviewBtn) {
      reviewBtn.click();
      for (let i = 0; i < 8; i++) { await sleep(500); if (q('.monaco-diff-editor')) break; }
      await sleep(1200);
      const geo = () => ({
        lnLefts: [...new Set(qa('.monaco-diff-editor .line-numbers').map((el) => Math.round(el.getBoundingClientRect().left)))],
        editors: qa('.monaco-diff-editor .monaco-editor').map((m) => Math.round(m.getBoundingClientRect().width)),
      });
      const collapsed = geo();
      let toggle = q('.diff-toggle');
      let expanded = null;
      let recollapsed = null;
      if (toggle) {
        toggle.click();
        await sleep(800);
        expanded = geo();
        toggle.click();
        await sleep(800);
        recollapsed = geo();
      }
      out('3-diff-toggle', {
        diffOpen: !!q('.monaco-diff-editor'),
        collapsed, expanded, recollapsed,
        toggleExists: !!toggle,
        expandWorks: !!expanded && expanded.lnLefts.length === 2,
        recollapseWorks: !!recollapsed && recollapsed.lnLefts.length === 1,
      });
      // ⑤ 竞态回归：展开后切到文本标签再切回 diff（触发重建），应保持双栏
      if (toggle) {
        toggle.click();
        await sleep(600);
        const textTab = qa('.editor-panel .tab').find((t) => !t.textContent.includes('Diff'));
        if (textTab) {
          textTab.click();
          await sleep(600);
          const diffTab = qa('.editor-panel .tab').find((t) => t.textContent.includes('Diff'));
          diffTab.click();
          await sleep(900);
          const afterSwitchBack = geo();
          toggle = q('.diff-toggle');
          if (toggle) { toggle.click(); await sleep(600); }
          const collapsedAgain = geo();
          out('4-race', {
            afterSwitchBackLn: afterSwitchBack.lnLefts,
            staysExpanded: afterSwitchBack.lnLefts.length === 2,
            collapsedAgainLn: collapsedAgain.lnLefts,
          });
        }
      }
    }
    // ④ 焦点模式重启清零：置 stale 标记后 reload，下次启动应打印清除日志（看 electron-debug.log）
    localStorage.setItem('loomery.focusRight', '1');
    location.reload();
    return 'reloading';
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
    probeLines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.includes('open-probe')).join('\n');
  }
  console.log('---- 探针结果 ----');
  console.log(probeLines || '(无 open-probe 记录)');
  process.exit(0);
}, 50000);

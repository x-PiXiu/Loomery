// 探针：elementFromPoint 实测终端按钮被谁遮挡
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { createRequire } = require('node:module');
const shellRequire = createRequire(path.join(process.cwd(), 'noop.js'));
app.whenReady().then(async () => {
  // 等窗口就绪
  await new Promise((r) => setTimeout(r, 10000));
  for (let i = 0; i < 20 && BrowserWindow.getAllWindows().length === 0; i++) await new Promise((r) => setTimeout(r, 500));
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.log('NO_WINDOW'); app.quit(); return; }
  const wc = win.webContents;
  const report = await wc.executeJavaScript(`(function(){
    const btns = [...document.querySelectorAll('.chat-header .tool-wrap')];
    const termBtn = btns.find((s) => s.querySelector('.lucide-square-terminal'));
    if (!termBtn) return 'NO_BTN(total=' + btns.length + ')';
    const r = termBtn.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    const chain = [];
    let el = top;
    while (el && chain.length < 5) { chain.push(el.tagName + '.' + (el.className || '').toString().slice(0, 40)); el = el.parentElement; }
    const covered = top && !termBtn.contains(top);
    const ls = localStorage.getItem('loomery.terminal.open');
    return JSON.stringify({ rect: { x: Math.round(cx), y: Math.round(cy), w: Math.round(r.width), h: Math.round(r.height) }, covered, topEl: chain, terminalOpenLS: ls, btnActive: termBtn.className });
  })()`);
  console.log('BTN_PROBE: ' + report);
  app.quit();
});

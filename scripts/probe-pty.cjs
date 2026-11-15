// Electron ABI 冒烟：加载 node-pty → 起 PowerShell → 读 banner → 写命令 → 退出
const { app } = require('electron');
const { createRequire } = require('node:module');
const path = require('node:path');
// node-pty 解析自 packages/shell（运行时 dist/main.js 同位解析）
const shellRequire = createRequire(path.join(process.cwd(), 'noop.js'));
app.whenReady().then(() => {
  try {
    const pty = shellRequire('node-pty');
    const shell = pty.spawn('powershell.exe', ['-NoProfile'], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: { ...process.env },
    });
    let buf = '';
    shell.onData((d) => { buf += d; });
    shell.write('exit\r');
    setTimeout(() => {
      console.log('PTY_OK bytes=' + buf.length + ' hasBanner=' + /PowerShell/i.test(buf));
      try { shell.kill(); } catch {}
      app.quit();
    }, 3000);
  } catch (err) {
    console.log('PTY_FAIL: ' + err.message);
    app.quit();
  }
});

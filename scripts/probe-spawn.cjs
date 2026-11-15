// 实锤：Electron main 下 child_process.spawn(shell:true) 的 close 是否触发
const { app } = require('electron');
const { spawn } = require('node:child_process');
function probe(label, command, opts = {}, waitMs = 10000) {
  return new Promise((resolve) => {
    const events = [];
    const t0 = Date.now();
    const child = spawn(command, { shell: true, cwd: opts.cwd || process.cwd(), windowsHide: true, env: { ...process.env } });
    let out = 0;
    child.stdout?.on('data', (b) => { out += b.length; });
    child.stderr?.on('data', (b) => { out += b.length; });
    child.on('error', (e) => { events.push('error:' + e.code); });
    child.on('exit', (c) => { events.push('exit:' + c + '@' + (Date.now() - t0) + 'ms'); });
    child.on('close', (c) => { events.push('close:' + c + '@' + (Date.now() - t0) + 'ms'); resolve({ label, out, events, pid: child.pid }); });
    setTimeout(() => { events.push('TIMEOUT@' + waitMs + 'ms(未close)'); try { child.kill(); } catch {} resolve({ label, out, events, pid: child.pid }); }, waitMs);
  });
}
app.whenReady().then(async () => {
  console.log('PATH=', (process.env.PATH || '').slice(0, 80));
  const r1 = await probe('echo-hello', 'echo hello');
  console.log('R1', JSON.stringify(r1));
  const r2 = await probe('big-output', 'dir /s /b "E:\workspace\Demo\MyDemo\Loomery\node_modules" 2>nul', {}, 15000);
  console.log('R2', JSON.stringify(r2));
  const r3 = await probe('env-inherit', 'echo PATH=%PATH:~0,40%', {}, 8000);
  console.log('R3', JSON.stringify(r3));
  app.quit();
});

// 12 §F2 E2E（LOOMERY_E2E=terminal）：终端 RPC 全链验证
// create → onData 流（ASCII+中文）→ resize → UI 面板展开 → kill → onExit
import { appendFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';

export function runTerminalE2E(getWin: () => BrowserWindow | undefined): void {
  const log = (msg: string): void => {
    const line = `${new Date().toISOString()} [e2e-term] ${msg}`;
    console.log(line);
    try {
      appendFileSync(process.env.LOOMERY_E2E_LOG ?? 'e2e-debug.log', line + '\n');
    } catch { /* ignore */ }
  };
  setTimeout(() => {
    const win = getWin();
    if (!win) { log('no window'); return; }
    const wc = win.webContents;
    const js = (code: string): Promise<string> => wc.executeJavaScript(code).then(String);
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    void (async () => {
      try {
        // step1: 订阅数据流收集器
        log('step1 subscribe collectors');
        await js(`(function(){
          window.__termChunks = [];
          window.__termExits = [];
          window.loomery.onTerminalData((p) => window.__termChunks.push(p.chunk));
          window.loomery.onTerminalExit((p) => window.__termExits.push(p.id));
          return 'subscribed';
        })()`);
        await sleep(300);

        // step2: 创建会话（cwd = 工作区根）
        log('step2 terminal.create');
        const meta = (await wc.executeJavaScript(
          `window.loomery.invoke('terminal.create', {}).then((m) => JSON.stringify(m))`,
        )) as unknown as string;
        const created = JSON.parse(meta) as { id: string; shellName: string };
        log(`created id=${created.id} shell=${created.shellName}`);
        await sleep(1200); // 等 PowerShell banner

        // step3: ASCII 数据流
        log('step3 ascii echo');
        await wc.executeJavaScript(
          `window.loomery.invoke('terminal.write', { id: ${JSON.stringify(created.id)}, data: 'echo PTY_E2E_MARKER\\r' }).then(() => 'written')`,
        );
        await sleep(1200);
        const asciiOk = await js(`window.__termChunks.join('').includes('PTY_E2E_MARKER') ? 'yes' : 'no'`);
        log(`ascii dataflow: ${asciiOk}`);

        // step4: 中文编码链（F2.4：PowerShell OutputEncoding=UTF8 预设）
        log('step4 utf8 echo');
        await wc.executeJavaScript(
          `window.loomery.invoke('terminal.write', { id: ${JSON.stringify(created.id)}, data: 'echo 中文编码_E2E\\r' }).then(() => 'written')`,
        );
        await sleep(1200);
        const utf8Ok = await js(`window.__termChunks.join('').includes('中文编码') ? 'yes' : 'no'`);
        log(`utf8 dataflow: ${utf8Ok}`);

        // step5: resize
        log('step5 resize');
        await wc.executeJavaScript(
          `window.loomery.invoke('terminal.resize', { id: ${JSON.stringify(created.id)}, cols: 100, rows: 30 }).then(() => 'resized')`,
        );
        await sleep(300);

        // step6: UI 面板展开（点 chat-header 终端按钮）→ .terminal-panel 可见
        log('step6 open panel');
        const openResult = await js(`(function(){
          const btn = [...document.querySelectorAll('.chat-header .tool-wrap')].find((s) => s.querySelector('.lucide-square-terminal'));
          if (!btn) return 'no-button';
          btn.click();
          return 'clicked';
        })()`);
        await sleep(800);
        const panelVisible = await js(`(function(){
          const p = document.querySelector('.terminal-panel');
          if (!p) return 'no-panel';
          const host = p.querySelector('.term-host .xterm');
          return p.offsetHeight > 50 && host ? 'visible+xterm' : 'panel-but-no-xterm';
        })()`);
        log(`panel: btn=${openResult} state=${panelVisible}`);

        // step7: kill → exit 事件
        log('step7 kill');
        await wc.executeJavaScript(
          `window.loomery.invoke('terminal.kill', { id: ${JSON.stringify(created.id)} }).then(() => 'killed')`,
        );
        await sleep(800);
        const exitOk = await js(`window.__termExits.includes(${JSON.stringify(created.id)}) ? 'yes' : 'no'`);
        log(`exit event: ${exitOk}`);

        const pass = asciiOk === 'yes' && utf8Ok === 'yes' && openResult === 'clicked' && panelVisible === 'visible+xterm' && exitOk === 'yes';
        log(pass ? 'TERMINAL_E2E_PASS' : `TERMINAL_E2E_FAIL(ascii=${asciiOk},utf8=${utf8Ok},panel=${panelVisible},exit=${exitOk})`);
      } catch (err) {
        log(`E2E_ERROR: ${String(err instanceof Error ? err.message : err)}`);
      } finally {
        // E2E 结束即退出（runner 截日志判 PASS/FAIL）
        setTimeout(() => undefined, 0);
      }
    })();
  }, 3500);
}

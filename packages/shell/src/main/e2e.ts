// E2E 驱动（LOOMERY_E2E=write-chain）：真实 UI 全链路
// 发消息 → 模型调用写工具 → 审批卡 → 点接受 → 写盘+checkpoint → 点回滚 → 验证恢复
import { appendFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';

export function runWriteChainE2E(getWin: () => BrowserWindow | undefined): void {
  const log = (msg: string): void => {
    const line = `${new Date().toISOString()} [e2e] ${msg}`;
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
        // step0: 强制审批策略 write=ask（保证出审批卡）
        log('step0 force write=ask');
        await js(`window.loomery.invoke('config.save', { approval: { read: 'auto', write: 'ask', execute: 'deny' } }); 'ok'`);
        await sleep(400);

        // step1: 注入消息并回车发送（React 受控 textarea 用原生 setter）
        log('step1 send message');
        await js(
          `(function(){
            const ta = document.querySelector('.composer-card textarea');
            if (!ta) return 'no-textarea';
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, '请把 test.txt 文件的内容改成两行：第一行 hello world，第二行 e2e test。用工具完成。');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            return 'set';
          })()`,
        );
        await sleep(300);
        await js(
          `document.querySelector('.composer-card textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); 'enter'`,
        );

        // step2: 轮询等审批卡（最多 120s）
        log('step2 wait approval card');
        let found = false;
        for (let i = 0; i < 60; i++) {
          await sleep(2000);
          const r = await js(
            `(function(){ const c = document.querySelector('.card.approval'); if (c) return 'found'; return 'waiting'; })()`,
          );
          if (r === 'found') { found = true; log(`approval card at poll ${i}`); break; }
        }
        if (!found) { log('FAIL: no approval card within 120s'); return; }

        // step2b: 点'查看完整 diff'验证 DiffPane
        log('step2b open diff pane');
        const clickResult = await js(
          `(function(){ const c = document.querySelector('.card.approval'); const btns = c ? [...c.querySelectorAll('button')].map((x) => x.textContent.trim()).join('|') : 'no-card'; const b = [...document.querySelectorAll('.card.approval .actions button')].find((x) => x.textContent.includes('diff')); if (b) { b.click(); return 'clicked'; } return 'none:' + btns; })()`,
        );
        log('step2b click result: ' + clickResult);
        await sleep(1500);
        const diffHost = await js(
          `(function(){ const d = document.querySelector('.diff-host'); return d && d.querySelector('.monaco-diff-editor, .monaco-editor') ? 'diff-open' : 'no-diff'; })()`,
        );
        log(`diff pane state: ${diffHost}`);
        if (diffHost !== 'diff-open') { log('FAIL: diff pane did not open'); }

        // step2c: 接受
        log('step2c accept');
        await js(
          `document.querySelector('.card.approval .actions button.primary').click(); 'accepted'`,
        );
        log('approval clicked');

        // step3: 等写盘完成（checkpointCreated 后状态栏出现回滚按钮）
        log('step3 wait write done (rollback button)');
        let rolled = false;
        for (let i = 0; i < 30; i++) {
          await sleep(2000);
          const r = await js(
            `(function(){ const b = document.querySelector('.chat-header .rollback'); if (b) { b.click(); return 'clicked'; } return 'waiting'; })()`,
          );
          if (r === 'clicked') { rolled = true; log(`rollback clicked at poll ${i}`); break; }
        }
        if (!rolled) { log('FAIL: no rollback button within 60s'); return; }
        await sleep(1500);
        log('E2E DONE — 文件与 checkpoint 状态由外部脚本校验');
        const shot = process.env.LOOMERY_SELF_SHOT;
        if (shot) {
          const img = await win.capturePage();
          (await import('node:fs')).writeFileSync(shot, img.toPNG());
          console.log(`[e2e] screenshot saved ${shot}`);
        }
        const quit = process.env.LOOMERY_E2E_QUIT;
        if (quit !== '0') {
          const { app } = await import('electron');
          app.quit();
        }
      } catch (err) {
        log(`FAIL: ${String(err)}`);
      }
    })();
  }, 3500);
}

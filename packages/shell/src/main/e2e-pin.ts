// P2.0 真机 E2E（LOOMERY_E2E=pin-recall）：记忆全链验证——
// 钉住（memory_pin 工具）→ 事件落 JSONL → 第二轮召回（memoryRecalled + 回复内容含钉住文本）
// 用真实模型（userData 配置的 key）；结束后删除测试任务，不污染用户数据。
// 驱动注意：不预建任务（thread.create RPC 不切 UI 活动线程，发送会落到别的线程）——
// 直接发送让 UI 自建任务，再按"最新 busy 线程"定位。
import { appendFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';

export function runPinRecallE2E(getWin: () => BrowserWindow | undefined): void {
  const log = (msg: string): void => {
    const line = `${new Date().toISOString()} [e2e-pin] ${msg}`;
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
    const FACT = 'E2E 钉住事实 9527：本任务只用 pnpm';
    void (async () => {
      let tid: string | null = null;
      try {
        log('step1 send pin instruction');
        await js(
          `(function(){
            const ta = document.querySelector('.composer-card textarea');
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, '调用 memory_pin 工具，把这条内容钉住：「${FACT}」。不要做别的事。');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            return 'sent';
          })()`,
        );
        for (let i = 0; i < 15 && !tid; i++) {
          await sleep(1000);
          const threads = JSON.parse(await js(`window.loomery.invoke('thread.list', {}).then(JSON.stringify)`)) as { id: string; busy: boolean; createdAt: number }[];
          const newest = threads.sort((a, b) => b.createdAt - a.createdAt)[0];
          if (newest?.busy) tid = newest.id;
        }
        if (!tid) { log('FAIL: no busy thread after send'); return; }
        log('thread ' + tid);
        let pinned = false;
        for (let i = 0; i < 75; i++) {
          await sleep(2000);
          const evs = JSON.parse(await js(`window.loomery.invoke('thread.export', { threadId: '${tid}' }).then(JSON.stringify)`)) as { type: string; payload?: { fact?: { content?: string } } }[];
          const hit = evs.find((e) => e.type === 'memoryPinned' && e.payload?.fact?.content?.includes('9527'));
          if (hit) { pinned = true; log(`memoryPinned at poll ${i}`); break; }
          const ended = evs.some((e) => e.type === 'loopTerminated');
          if (ended && i > 20) { log('loop ended without pin (poll ' + i + ')'); break; }
        }
        if (!pinned) { log('FAIL: memoryPinned not observed'); return; }
        log('step3 send recall request');
        await js(
          `(function(){
            const ta = document.querySelector('.composer-card textarea');
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, '查看任务记忆，原样输出之前钉住的那条事实里形如 9527 的四位数字。只输出数字。');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            return 'sent';
          })()`,
        );
        let recalled = false;
        let sawRecallEvent = false;
        for (let i = 0; i < 75; i++) {
          await sleep(2000);
          const evs = JSON.parse(await js(`window.loomery.invoke('thread.export', { threadId: '${tid}' }).then(JSON.stringify)`)) as { type: string; payload?: Record<string, unknown> }[];
          sawRecallEvent = evs.some((e) => e.type === 'memoryRecalled');
          const texts = evs.filter((e) => e.type === 'textDelta').map((e) => String((e.payload as { text?: string })?.text ?? '')).join('');
          const terminatedCount = evs.filter((e) => e.type === 'loopTerminated').length;
          if (texts.includes('9527')) { recalled = true; log(`recall content at poll ${i}`); break; }
          if (terminatedCount >= 2 && i > 20) { log('second turn ended without recall content'); break; }
        }
        log(`RESULT: recalled=${recalled} memoryRecalledEvent=${sawRecallEvent}`);
      } catch (err) {
        log('FAIL: ' + String(err));
      } finally {
        if (tid) {
          await js(`window.loomery.invoke('thread.delete', { threadId: '${tid}' }).then('deleted')`).catch(() => undefined);
          log('cleanup done for ' + tid);
        }
      }
    })();
  }, 3500);
}

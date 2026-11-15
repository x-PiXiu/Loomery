// P2.0 真机 E2E（LOOMERY_E2E=skill-use）：技能使用全链——
// 预置技能（runner 侧）→ agent 调 read_skill → 按 SKILL.md 指令执行 → 断言 skillUsed 事件 + 执行结果文本
import { appendFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';

export function runSkillUseE2E(getWin: () => BrowserWindow | undefined): void {
  const log = (msg: string): void => {
    const line = `${new Date().toISOString()} [e2e-skill] ${msg}`;
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
      let tid: string | null = null;
      try {
        log('step1 send skill-use instruction');
        await js(
          `(function(){
            const ta = document.querySelector('.composer-card textarea');
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, '调用 read_skill 工具读取技能 e2e-skill-use，然后严格按照技能内容执行。');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            return 'sent';
          })()`,
        );
        let tid2: string | null = null;
        for (let i = 0; i < 15 && !tid2; i++) {
          await sleep(1000);
          const threads = JSON.parse(await js(`window.loomery.invoke('thread.list', {}).then(JSON.stringify)`)) as { id: string; busy: boolean; createdAt: number }[];
          const newest = threads.sort((a, b) => b.createdAt - a.createdAt)[0];
          if (newest?.busy) tid2 = newest.id;
        }
        tid = tid2;
        if (!tid) { log('FAIL: no busy thread'); return; }
        log('thread ' + tid);
        // 轮询：skillUsed 事件 + 回复含暗号
        let used = false;
        let executed = false;
        for (let i = 0; i < 75; i++) {
          await sleep(2000);
          const evs = JSON.parse(await js(`window.loomery.invoke('thread.export', { threadId: '${tid}' }).then(JSON.stringify)`)) as { type: string; payload?: Record<string, unknown> }[];
          used = evs.some((e) => e.type === 'skillUsed');
          const texts = evs.filter((e) => e.type === 'textDelta').map((e) => String((e.payload as { text?: string })?.text ?? '')).join('');
          if (texts.includes('BANANA-7788')) { executed = true; log(`executed at poll ${i}`); break; }
          if (evs.some((e) => e.type === 'loopTerminated') && i > 20) { log('turn ended (poll ' + i + ') used=' + used); break; }
        }
        log(`RESULT: skillUsed=${used} executed=${executed}`);
      } catch (err) {
        log('FAIL: ' + String(err));
      } finally {
        if (tid) {
          await js(`window.loomery.invoke('thread.delete', { threadId: '${tid}' }).then('deleted')`).catch(() => undefined);
          log('cleanup done');
        }
      }
    })();
  }, 3500);
}

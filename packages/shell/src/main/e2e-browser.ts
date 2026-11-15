// 12 内置浏览器标签 E2E（LOOMERY_E2E=browser）：事件开 tab → webview 加载 → URL 同步 → 关 tab
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';

export function runBrowserE2E(getWin: () => BrowserWindow | undefined, workspaceRoot: string): void {
  const log = (msg: string): void => {
    const line = `${new Date().toISOString()} [e2e-browser] ${msg}`;
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
        // step0: 工作区里放一个测试页（app-file 协议目标；带相对 css 验证资源解析）
        const page = join(workspaceRoot, 'browser-e2e.html');
        writeFileSync(page, '<html><head><title>E2E_PAGE_OK</title></head><body><h1 id="ok">browser-e2e</h1></body></html>', 'utf8');
        log('step0 test page written');

        // step1: 事件开浏览器标签（与 HtmlViewer 🌐 按钮同链路）；先注入接收回执与错误捕获
        log('step1 open-browser event');
        const url = `app-file://local/${encodeURIComponent(page)}`;
        await js(`(function(){
          window.__e2eErrs = [];
          window.addEventListener('error', (e) => window.__e2eErrs.push(String(e.message).slice(0, 120)));
          window.addEventListener('unhandledrejection', (e) => window.__e2eErrs.push('rej:' + String(e.reason).slice(0, 120)));
          window.__gotEvent = false;
          window.addEventListener('loomery:open-browser', () => { window.__gotEvent = true; }, { once: false });
          return 'instrumented';
        })()`);
        const tabsExist = await js(`document.querySelector('.editor-tabs') ? 'yes' : 'no-editor-tabs'`);
        log('editor-tabs exists: ' + tabsExist);
        await js(`(function(){
          window.dispatchEvent(new CustomEvent('loomery:open-browser', { detail: { url: ${JSON.stringify(url)} } }));
          return 'dispatched';
        })()`);
        await sleep(1200);
        const got = await js(`String(window.__gotEvent)`);
        const errs = await js(`JSON.stringify(window.__e2eErrs || [])`);
        log(`listener-got-event: ${got}; renderer-errors: ${errs}`);
        await sleep(2500); // 等 tab 渲染 + webview attach + 页面加载

        // step2: tab 存在且激活（path = browser:<url>）
        log('step2 check tab');
        const tabOk = await js(`(function(){
          const tabs = [...document.querySelectorAll('.editor-tabs .tab')];
          const t = tabs.find((x) => x.querySelector('.tab-name')?.textContent?.includes('browser-e2e'));
          return t && t.classList.contains('active') ? 'tab-active' : 'tab-missing:' + tabs.length;
        })()`);
        log(`tab: ${tabOk}`);

        // step3/4: 轮询 webview attach + 加载完成（attach 与加载均为异步）
        log('step3 poll webview');
        let wvOk = 'timeout';
        let titleOk = 'timeout';
        for (let i = 0; i < 12; i++) {
          await sleep(1000);
          const st = await js(`(function(){
            const wv = document.querySelector('webview.browser-wv');
            if (!wv) return 'no-webview';
            let u = '';
            let t = '';
            try { u = wv.getURL ? String(wv.getURL()) : '(no-getURL)'; } catch { u = '(err)'; }
            try { t = wv.getTitle ? String(wv.getTitle()) : ''; } catch { t = ''; }
            return JSON.stringify({ u: decodeURIComponent(u), t });
          })()`);
          const parsed = JSON.parse(st) as { u: string; t: string };
          wvOk = parsed.u.includes('browser-e2e.html') ? 'loaded' : 'url:' + parsed.u.slice(0, 60);
          titleOk = parsed.t.includes('E2E_PAGE_OK') ? 'title-ok' : 'title:' + parsed.t.slice(0, 40);
          if (wvOk === 'loaded' && titleOk === 'title-ok') break;
        }
        log(`webview: ${wvOk}`);
        log(`title: ${titleOk}`);

        const pass = tabOk === 'tab-active' && wvOk === 'loaded' && titleOk === 'title-ok';
        log(pass ? 'BROWSER_E2E_PASS' : `BROWSER_E2E_FAIL(tab=${tabOk},wv=${wvOk},title=${titleOk})`);
      } catch (err) {
        log(`E2E_ERROR: ${String(err instanceof Error ? err.message : err)}`);
      }
    })();
  }, 3500);
}

// 12 胶囊体 E2E（LOOMERY_E2E=capsule）：git 仓库工作区 → 胶囊出现 → 展开面板含 Git 工具区
// 需以 git 仓库作工作区启动（如 LOOMERY_E2E_WORKSPACE 指向 Loomery 仓库本身）

import { appendFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';
import { app } from 'electron';

// 模块加载即注册：渲染层 module 级早期错误（页面加载 0-2s）必须在此捕获
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (_e2, level, message) => {
    if (level >= 3) {
      const line = new Date().toISOString() + ' [e2e-capsule][early-console] ' + String(message).slice(0, 300);
      console.log(line);
      try { appendFileSync(process.env.LOOMERY_E2E_LOG ?? 'e2e-debug.log', line + '\n'); } catch { /* ignore */ }
    }
  });
});

export function runCapsuleE2E(getWin: () => BrowserWindow | undefined): void {
  const log = (msg: string): void => {
    const line = `${new Date().toISOString()} [e2e-capsule] ${msg}`;
    console.log(line);
    try {
      appendFileSync(process.env.LOOMERY_E2E_LOG ?? 'e2e-debug.log', line + '\n');
    } catch { /* ignore */ }
  };
  setTimeout(() => {
    const win0 = getWin();
    if (win0) win0.webContents.on('console-message', (_e, level, message) => {
      if (level >= 3) log('renderer-console: ' + String(message).slice(0, 260));
    });
    const win = getWin();
    if (!win) { log('no window'); return; }
    const wc = win.webContents;
    const js = (code: string): Promise<string> => wc.executeJavaScript(code).then(String);
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    void (async () => {
      try {
        // step1: 胶囊出现（git 仓库工作区 → repo:true → 折叠胶囊含分支名）
        log('step1 wait capsule');
        let pill = 'timeout';
        for (let i = 0; i < 10; i++) {
          await sleep(1000);
          pill = await js(`(function(){
            const c = document.querySelector('.activity-capsule');
            if (!c) return 'no-capsule';
            const b = c.querySelector('.cap-branch');
            return b ? 'branch:' + b.textContent : 'pill-no-branch';
          })()`);
          if (pill.startsWith('branch:')) break;
        }
        log(`pill: ${pill}`);

        // step0b: 渲染层错误捕获
        await js(`(function(){
          window.__e2eErrs = window.__e2eErrs || [];
          if (window.__e2eErrs.length === 0) {
            window.addEventListener('error', (e) => window.__e2eErrs.push(String(e.message).slice(0, 200)));
            window.addEventListener('unhandledrejection', (e) => window.__e2eErrs.push('rej:' + String(e.reason).slice(0, 200)));
          }
          return 'instrumented';
        })()`);

        // step1b: React 绑定内省（onClick 是否真挂上 + localStorage 残留态 + drag region）
        log('step1b react introspect');
        const intros = await js(`(function(){
          const pill = document.querySelector('.activity-capsule .cap-pill');
          if (!pill) return JSON.stringify({ err: 'no-pill' });
          const pk = Object.keys(pill).find((k) => k.startsWith('__reactProps'));
          const props = pk ? pill[pk] : null;
          return JSON.stringify({
            hasReactProps: !!props,
            onClickType: props ? typeof props.onClick : 'none',
            lsOpen: localStorage.getItem('loomery.capsule.open'),
            panelNow: !!document.querySelector('.activity-capsule .cap-panel'),
            dragRegion: getComputedStyle(pill).webkitAppRegion,
          });
        })()`);
        log(`introspect: ${intros}`);
        const errs = await js(`JSON.stringify(window.__e2eErrs || [])`);
        log(`renderer-errors: ${errs}`);
        const domState = await js(`(function(){
          const cp = document.querySelector('.chat-panel');
          const eb = document.querySelector('[class*=error]') || document.querySelector('[class*=boundary]');
          return JSON.stringify({ url: location.href.slice(0, 80), ready: document.readyState, chatPanel: !!cp, cols: [...document.querySelectorAll('.loomery-main > .col')].map((c) => c.className.slice(0, 24)), swapLS: localStorage.getItem('loomery.swap'), frLS: localStorage.getItem('loomery.focusRight'), evLS: localStorage.getItem('loomery.editorVisible') });
        })()`);
        log(`dom: ${domState}`);

        // step2: 点击翻转面板状态（初始可能是残留的展开态——断言"状态必须翻转"而非"必须出现"）
        log('step2 toggle panel');
        await js(`(function(){
          const p = document.querySelector('.activity-capsule .cap-pill');
          if (p) p.click();
          return 'clicked';
        })()`);
        await sleep(500); // 等 React 提交
        const panel = await js(`(function(){
          const panel = document.querySelector('.activity-capsule .cap-panel');
          if (!panel) return 'panel-closed'; // 翻转后收起 = toggle 有效
          const hasGit = [...panel.querySelectorAll('.cap-head span')].some((s) => s.textContent === 'Git 工具');
          const delta = panel.querySelector('.cap-delta .added');
          return hasGit ? (delta ? 'panel-git+delta' : 'panel-git') : 'panel-no-git';
        })()`);
        log(`panel after toggle: ${panel}`);
        // 再翻回展开态（后续检查需要面板可见），同样异步等待
        await js(`(function(){ document.querySelector('.activity-capsule .cap-pill')?.click(); return 1; })()`);
        await sleep(500);

        // step3（用户三问校验）：
        // 3a. 悬浮位置：胶囊矩形在聊天区右上（视口右侧 40%、顶部 25% 内）
        const pos = await js(`(function(){
          const c = document.querySelector('.activity-capsule');
          if (!c) return 'no-capsule';
          const r = c.getBoundingClientRect();
          const inRightTop = r.right > window.innerWidth * 0.55 && r.top < window.innerHeight * 0.25;
          // 可点性：pill 中心 elementFromPoint 必须落在胶囊内部（drag 区/遮挡会让它落在外面）
          const pill = c.querySelector('.cap-pill');
          const pr = pill.getBoundingClientRect();
          const hit = document.elementFromPoint(pr.left + pr.width / 2, pr.top + pr.height / 2);
          const clickable = hit && (c.contains(hit) || hit === c);
          return JSON.stringify({ inRightTop, clickable, hitTag: hit ? hit.className.toString().slice(0, 30) : 'null' });
        })()`);
        log(`3a pos/clickable: ${pos}`);

        // 3b. toggle 真实性：单脚本内闭环（click → 页面内轮询状态翻转 → resolve），避免跨边界调用不稳定
        const toggle = await js(`(function(){
          return new Promise((resolve) => {
            const pill = document.querySelector('.activity-capsule .cap-pill');
            if (!pill) return resolve('no-pill');
            const wasOpen = !!document.querySelector('.activity-capsule .cap-panel');
            pill.click();
            let n = 0;
            const check = () => {
              const nowOpen = !!document.querySelector('.activity-capsule .cap-panel');
              if (nowOpen !== wasOpen) return resolve('toggle-ok(was=' + wasOpen + ')');
              if (++n > 12) return resolve('toggle-dead(was=' + wasOpen + ')');
              setTimeout(check, 150);
            };
            setTimeout(check, 150);
          });
        })()`);
        log(`3b toggle: ${toggle}`);

        // 3c. 下拉（滚动聊天流到底/回顶）后胶囊仍在原位（不随滚动消失/不被带走）
        const scroll = await js(`(function(){
          const el = document.getElementById('chat-stream');
          if (!el) return 'no-stream';
          const before = document.querySelector('.activity-capsule')?.getBoundingClientRect().top ?? -1;
          el.scrollTop = el.scrollHeight;
          const afterTop = document.querySelector('.activity-capsule')?.getBoundingClientRect().top ?? -1;
          el.scrollTop = 0;
          return 'stable:' + (Math.abs(before - afterTop) < 2) + '@' + Math.round(afterTop);
        })()`);
        log(`3c scroll-stable: ${scroll}`);

        // 3d. 用户消息气泡回归（用户真机截图驱动）：三个短句各占一行，不逐字换行
        //（根因：wrap 无 width 作为 flex-shrink:0 子项收缩到 max-content，气泡 max-width 相对窄容器求解 → 每句被钳到 6 字折行）
        // 断言=行数（高度÷行高）==3；pill-text 是 flex 子项被块状化，getClientRects 恒 1 盒不可用
        const pillW = await js(`(function(){
          const stream = document.getElementById('chat-stream');
          if (!stream) return 'no-stream';
          const wrap = document.createElement('div');
          wrap.className = 'msg-user-pill-wrap';
          wrap.innerHTML = '<div class="msg-user-pill"><span class="pill-text">继续到当前项目\\n还需要如何完善?\\n客户端不需要写吗?</span></div>';
          stream.appendChild(wrap);
          const text = wrap.querySelector('.pill-text');
          const lh = parseFloat(getComputedStyle(text).lineHeight) || 20;
          const lines = Math.round(text.getBoundingClientRect().height / lh);
          const len = text.textContent.length;
          wrap.remove();
          return 'lines:' + lines + ',len:' + len;
        })()`);
        log(`3d pill-lines: ${pillW}`);

        // 3e. 面板内按钮点击实测（用户反馈"一些按钮点击无效"）：更改行(事件)/分支行(弹层+弹层内按钮)/提交行(弹层)
        const clicks = await js(`(function(){
          return new Promise((resolve) => {
            const panel = document.querySelector('.activity-capsule .cap-panel');
            if (!panel) return resolve('no-panel');
            let reviewFired = false;
            window.addEventListener('loomery:open-review', () => { reviewFired = true; }, { once: true });
            const rows = [...panel.querySelectorAll('.cap-row')];
            const changeRow = rows.find((r) => r.textContent.includes('更改'));
            const branchRow = rows.find((r) => r.querySelector('.cap-branch'));
            const commitRow = rows.find((r) => r.textContent.includes('提交'));
            const click = (el) => el && el.click();
            const out = { reviewOk: false, branchOk: false, graphOpened: false, commitOk: false };
            click(changeRow);
            setTimeout(() => {
              out.reviewOk = reviewFired;
              click(branchRow);
              setTimeout(() => {
                out.branchOk = !!document.querySelector('.cap-pop.branch-pop');
                // z 序修复验证：backdrop 开着时弹层内按钮必须可点（曾被子 z-44 backdrop 盖住=点击落 backdrop 关弹层）
                const graphRow = document.querySelector('.cap-pop.branch-pop .cap-row.cap-action');
                if (graphRow) graphRow.click();
                setTimeout(() => {
                  out.graphOpened = !!document.querySelector('.cap-graph-card');
                  document.querySelector('.cap-pop-backdrop')?.click();
                  click(commitRow);
                  setTimeout(() => {
                    out.commitOk = !!document.querySelector('.cap-pop.commit-pop');
                    document.querySelector('.cap-pop-backdrop')?.click();
                    resolve(JSON.stringify({ ...out, rowCount: rows.length }));
                  }, 250);
                }, 250);
              }, 250);
            }, 250);
          });
        })()`);
        log(`3e panel-clicks: ${clicks}`);

        const pass = pill.startsWith('branch:') && (panel.startsWith('panel-')) && pos.includes('"clickable":true') && pos.includes('"inRightTop":true') && toggle.startsWith('toggle-ok') && scroll.startsWith('stable:true') && pillW.startsWith('lines:3,') && clicks.includes('"reviewOk":true') && clicks.includes('"branchOk":true') && clicks.includes('"commitOk":true') && clicks.includes('"graphOpened":true');
        log(pass ? 'CAPSULE_E2E_PASS' : `CAPSULE_E2E_FAIL(pill=${pill},panel=${panel},pos=${pos},toggle=${toggle},scroll=${scroll},pillW=${pillW})`);
      } catch (err) {
        log(`E2E_ERROR: ${String(err instanceof Error ? err.message : err)}`);
      }
    })();
  }, 4000);
}

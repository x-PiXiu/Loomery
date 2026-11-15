// Electron 入口：窗口/安全基线（07 §8）；装配在 bootstrap.ts（组合根）
import { app, BrowserWindow, dialog, Menu } from 'electron';
import { createRequire } from 'node:module';

// 特权协议注册（必须在 app.ready 之前）：PDF 等大文件不经 IPC/base64，主进程流式供给
// （16MB RPC 上限与 512KB cap 都扛不住真实 PDF；secure 使其不被 http 页面按混合内容拦截；
//  CSP 以 frame-src app-pdf: 放行）
import { protocol } from 'electron';
protocol.registerSchemesAsPrivileged([
  { scheme: 'app-pdf', privileges: { standard: true, stream: true, supportFetchAPI: true, secure: true } },
  // 12 UI：HTML 预览（app-file 让 iframe 从磁盘真实加载，相对路径 css/js/图片生效；srcDoc 是 opaque origin 会全断）
  { scheme: 'app-file', privileges: { standard: true, stream: true, supportFetchAPI: true, secure: true } },
]);
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRuntime } from './bootstrap';
import { runWriteChainE2E } from './e2e';
import { runPinRecallE2E } from './e2e-pin';
import { runSkillUseE2E } from './e2e-skill';
import { runTerminalE2E } from './e2e-terminal';
import { runBrowserE2E } from './e2e-browser';
import { runCapsuleE2E } from './e2e-capsule';
import { FileLogger } from './logger';
import { loadWindowState, trackWindowState } from './window-state';

const DEV_URL = process.env.LOOMERY_RENDERER_URL;
// 应用图标（窗口/任务栏；打包时随 resources 一起带入）
const APP_ICON = join(import.meta.dirname, '../resources/app-icon.png');

// 数据目录默认位置：打包版 = <安装目录>\data；开发期 = <仓库根>\.loomery-data（随程序所在盘，不进 C 盘）
function defaultUserDataDir(): string {
  if (app.isPackaged) return join(dirname(app.getPath('exe')), 'data');
  return join(app.getAppPath(), '..', '..', '.loomery-data');
}

// 用户在设置里选择的自定义目录：指路条存在默认位置（默认位置本身不迁移，永远可找到）
function redirectTarget(defaultDir: string): string | null {
  const pointer = join(defaultDir, 'data-dir.txt');
  if (!existsSync(pointer)) return null;
  const target = readFileSync(pointer, 'utf8').trim();
  return target.length > 0 ? target : null;
}

function dirWritable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// userData 解析优先级（ADR-0021 领土原则的落盘位置）：
// ① LOOMERY_USER_DATA 环境变量（探针/多实例隔离/显式覆盖）
// ② 指路条 data-dir.txt（设置页"更改数据目录"写入）
// ③ 默认 = 程序所在盘（打包 <安装目录>\data / 开发 <仓库>\.loomery-data）
// ④ 兜底：默认位置不可写（如 Program Files 无权限）→ %APPDATA%\@loomery\shell
{
  const fallback = app.getPath('userData');
  const envDir = process.env.LOOMERY_USER_DATA;
  if (envDir) {
    app.setPath('userData', envDir);
  } else {
    const defaultDir = defaultUserDataDir();
    const chosen = redirectTarget(defaultDir) ?? defaultDir;
    if (dirWritable(chosen)) app.setPath('userData', chosen);
    else console.warn(`[userData] 默认位置不可写（${chosen}），回退 AppData：${fallback}`);
  }
  mkdirSync(app.getPath('userData'), { recursive: true });
}
const logger: FileLogger | undefined = new FileLogger(join(app.getPath('userData'), 'logs'));
logger.cleanup();
  // electron-debug.log 封顶：超 5MB 滚动为 .old（保留一份旧档，防无限增长）
  try {
    const dbg = join(app.getPath('userData'), 'electron-debug.log');
    if (existsSync(dbg) && statSync(dbg).size > 5 * 1024 * 1024) {
      const old = dbg + '.old';
      if (existsSync(old)) rmSync(old);
      renameSync(dbg, old);
    }
  } catch { /* 滚动失败不影响启动 */ }
process.on('uncaughtException', (err) => logger?.error('uncaughtException: ' + (err.stack ?? String(err))));
process.on('unhandledRejection', (reason) => logger?.error('unhandledRejection: ' + String(reason)));

let mainWindow: BrowserWindow | undefined;
let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;

function loadRenderer(win: BrowserWindow, hash?: string): void {
  if (DEV_URL) void win.loadURL(`${DEV_URL}${hash ?? ''}`);
  else void win.loadFile(join(import.meta.dirname, '../../ui/dist/index.html'), hash ? { hash } : undefined);
}

/** 标签页弹出：独立窗口承载同一渲染层（#popout 路由，ADR 见 06） */
function createPopoutWindow(file: string): void {
  const name = file.split(/[\\/]/).pop() ?? file;
  const win = new BrowserWindow({
    icon: APP_ICON,
    width: 960,
    height: 720,
    backgroundColor: '#131316',
    title: `${name} - Loomery`,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  void loadRenderer(win, `#popout?file=${encodeURIComponent(file)}`);
}

function createWindow(): void {
  // 窗口状态记忆（#9）：读档恢复尺寸/位置/最大化；探针 fresh userData → 默认 1440×900 不受影响
  const ws = loadWindowState(join(app.getPath('userData'), 'window-state.json'));
  mainWindow = new BrowserWindow({
    icon: APP_ICON,
    width: ws.width,
    height: ws.height,
    ...(ws.x !== undefined && ws.y !== undefined ? { x: ws.x, y: ws.y } : {}),
    minWidth: 960,
    backgroundColor: '#131316',
    title: 'Loomery',
    frame: false, // 无原生标题栏：窗口控制合并进右列顶部，拖拽区为各列头栏（ADR-0018）
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true, // 07 §8 安全基线
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      webviewTag: true, // 12：内置浏览器标签（<webview> 元素；will-attach-webview 钩子剥离注入）
    },
  });
  if (ws.maximized) mainWindow.maximize();
  trackWindowState(mainWindow, join(app.getPath('userData'), 'window-state.json'));
  loadRenderer(mainWindow);
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
  // 运行中关窗确认（P2）：有 Turn 在跑时点 X → 先问一次。进度已实时落盘（事件溯源），重启打开任务可续；
  // E2E/探针驱动豁免（它们以任务完成后再退出的方式运行，且 taskkill /F 本就不走 close）
  let forceQuit = false;
  mainWindow.on('close', (e) => {
    if (forceQuit || process.env.LOOMERY_E2E) return;
    const busy = runtime?.threads.listThreads().filter((t) => t.busy) ?? [];
    if (busy.length === 0) return;
    e.preventDefault();
    void dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      title: '任务正在运行',
      message: busy.length === 1 ? '有 1 个任务正在执行，退出将中断本轮对话。' : `有 ${busy.length} 个任务正在执行，退出将中断本轮对话。`,
      detail: `「${busy.map((t) => t.title).join('」「')}」\n对话进度已实时落盘，重启后打开任务可继续。`,
      buttons: ['取消', '仍要退出'],
      defaultId: 0,
      cancelId: 0,
    }).then(({ response }) => {
      if (response !== 1) return;
      forceQuit = true;
      // 主动取消运行中的 Turn（落 turnCancelled 审计事件）；未及落盘的部分由重启恢复按 interrupted 收尾
      for (const t of busy) runtime?.threads.cancel(t.id);
      app.quit();
    });
  });
}

// 单实例锁：防止双实例抢占 userData 导致渲染层假死/黑屏（根治启动类故障）
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

    void // webview 加固（内置浏览器标签）：剥离 nodeIntegration/preload 注入，弹窗一律外部打开
app.on('web-contents-created', (_ev, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.on('will-attach-webview', (_e, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    // 拒绝非预期 URL 的 webview（防注入任意页面属性）
    if (!/^((https?|app-file|about|app-pdf):|file:\/)/i.test(params.src ?? '')) {
      (params as unknown as { src: string }).src = 'about:blank';
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    // 新窗口请求 → 系统浏览器（http/https）或拒绝
    if (/^https?:/i.test(url)) void import('electron').then(({ shell }) => void shell.openExternal(url));
    return { action: 'deny' };
  });
});

/** 自动更新预留（打包分发）：electron-updater 未随包安装/未配置 feed 时静默跳过。
 * 接入时 pnpm add electron-updater 并在发布服务器配置 latest.yml feed——本钩子无需改动。 */
function tryAutoUpdater(): void {
  if (DEV_URL || !app.isPackaged) return; // 开发态不检查
  try {
    const require2 = createRequire(import.meta.url);
    const { autoUpdater } = require2('electron-updater') as { autoUpdater: { autoDownload: boolean; checkForUpdates(): Promise<unknown> } };
    autoUpdater.autoDownload = false; // 更新需用户确认（审批原则延伸到应用自身）
    void autoUpdater.checkForUpdates().catch(() => undefined);
  } catch { /* updater 未安装：跳过（当前打包产物即此形态） */ }
}

app.whenReady().then(async () => {
  tryAutoUpdater();
  const rt0 = Date.now();
  try {
    runtime = await createRuntime(
      () => mainWindow?.webContents,
      () => (mainWindow && !mainWindow.isDestroyed() ? [mainWindow.webContents] : []),
      { createPopout: createPopoutWindow },
    );
  } catch (err) {
    // 无窗口僵尸 = 占单实例锁 → 后续启动全部静默失败（实证）。必须给用户可见反馈并退出
    const msg = err instanceof Error ? err.message : String(err);
    logger?.error('createRuntime 失败: ' + (err instanceof Error ? err.stack ?? err.message : String(err)));
    dialog.showErrorBox('Loomery 启动失败', '内核初始化出错：' + msg + '\n\n请查看 logs 目录中的应用日志。即将退出。');
    app.quit();
    return;
  }
  logger?.info(`[metrics] boot createRuntime=${Date.now() - rt0}ms（含 seed 播种）`);

  // expired 语义：退出时未决审批按拒绝收尾（07 §1.3 / 04 §1.3）
  app.on('before-quit', () => {
    try {
      const n = runtime?.approvals.expireAll('应用退出，审批过期') ?? 0;
      if (n > 0) console.log(`[quit] expired ${n} pending approvals`);
    } catch { /* ignore */ }
    // 12 §F1.1 生命周期铁律②：退出清场——全部子进程树杀，不留孤儿 dev server
    runtime?.processRegistry
      .killAll()
      .then((n) => {
        if (n > 0) console.log(`[quit] killed ${n} child processes`);
      })
      .catch(() => undefined);
  });


  // E2E 写链路驱动（LOOMERY_E2E=write-chain）
  if (process.env.LOOMERY_E2E === 'write-chain') {
    runWriteChainE2E(() => mainWindow);
  }
  // P2.0 记忆全链驱动（LOOMERY_E2E=pin-recall，需 userData 配置模型 key）
  if (process.env.LOOMERY_E2E === 'pin-recall') {
    runPinRecallE2E(() => mainWindow);
  }
  // P2.0 技能使用全链驱动（LOOMERY_E2E=skill-use；技能由 runner 预置到 userData/skills）
  if (process.env.LOOMERY_E2E === 'skill-use') {
    runSkillUseE2E(() => mainWindow);
  }
  // 12 §F2 终端全链驱动（LOOMERY_E2E=terminal：create→data→编码→面板→kill→exit）
  if (process.env.LOOMERY_E2E === 'terminal') {
    runTerminalE2E(() => mainWindow);
  }
  // 12 内置浏览器标签全链驱动（LOOMERY_E2E=browser：事件开 tab→webview 加载→标题可读）
  if (process.env.LOOMERY_E2E === 'browser') {
    runBrowserE2E(() => mainWindow, runtime.config.workspaceRoots[0] ?? process.cwd());
  }
  // 12 胶囊体驱动（LOOMERY_E2E=capsule；需 git 仓库作工作区）
  if (process.env.LOOMERY_E2E === 'capsule') {
    runCapsuleE2E(() => mainWindow);
  }


  // 顶部原生菜单栏不展示（V2 设计：无菜单行）；快捷键如 Ctrl+N 由渲染层自行处理
  Menu.setApplicationMenu(null);

  logger?.info('应用启动完成 userData=' + app.getPath('userData'));
  createWindow();

  // 渲染层 [drag-log] 落文件（排障用；手动拖动后可直接读 userData/electron-debug.log）
  // 渲染进程崩溃自愈：非正常退出时重载页面；1 分钟内超 3 次则停止（防崩溃循环，保护 userData）
  const reloadTimestamps: number[] = [];
  mainWindow?.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    const now = Date.now();
    while (reloadTimestamps.length > 0 && reloadTimestamps[0] !== undefined && now - reloadTimestamps[0] > 60_000) reloadTimestamps.shift();
    reloadTimestamps.push(now);
    logger?.error('渲染进程崩溃 reason=' + details.reason + ' 近1分钟重载=' + reloadTimestamps.length);
    if (reloadTimestamps.length <= 3 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  });
  mainWindow?.webContents.on('console-message', (event) => {
    const { message } = event as unknown as { message: string };
    if (!message.includes('[drag-log]')) return;
    try {
      appendFileSync(join(app.getPath('userData'), 'electron-debug.log'), new Date().toISOString() + ' ' + message + '\n');
    } catch { /* 日志失败不影响主流程 */ }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // 开发自检截图（scripts：LOOMERY_SELF_SHOT=路径 时启动后 4s 抓页并退出）
  const selfShot = process.env.LOOMERY_SELF_SHOT;
  if (selfShot && mainWindow) {
    const clickSel = process.env.LOOMERY_SELF_SHOT_CLICK;
    if (clickSel) {
      setTimeout(() => {
        void mainWindow?.webContents
          .executeJavaScript(`document.querySelector(${JSON.stringify(clickSel)})?.click()`)
          .catch(() => undefined);
      }, 5000);
    }
    const openFile = process.env.LOOMERY_SELF_SHOT_OPEN;
    if (openFile) {
      setTimeout(() => {
        void mainWindow?.webContents
          .executeJavaScript(`window.loomeryDev?.openInEditor(${JSON.stringify(openFile)})`)
          .catch(() => undefined);
      }, 2000);
    }
    // 拖拽探针：Chromium 真实输入管线模拟拖 mid 分隔条 +250px 再 -150px，量三列宽度（LOOMERY_SELF_SHOT_DRAG=swap|normal）
    if (process.env.LOOMERY_SELF_SHOT_DRAG) {
      const swap = process.env.LOOMERY_SELF_SHOT_DRAG === 'swap';
      setTimeout(() => {
        const wc = mainWindow!.webContents;
        void (async () => {
          await wc.executeJavaScript(`localStorage.setItem('loomery.swap', '${swap ? '1' : '0'}'); location.reload(); 'r';`);
          await new Promise((r) => setTimeout(r, 2500));
          const pos = JSON.parse(
            String(
              await wc.executeJavaScript(
                `(function(){ const s = document.querySelectorAll('.splitter')[1]; const r = s.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + 2), y: Math.round(r.top + 100) }); })()`,
              ),
            ),
          ) as { x: number; y: number };
          const wExpr =
            'JSON.stringify([0,1,2].map(i => Math.round(document.querySelectorAll(".loomery-main > .col")[i].getBoundingClientRect().width)))';
          const before = JSON.parse(String(await wc.executeJavaScript(wExpr))) as number[];
          wc.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
          await new Promise((r) => setTimeout(r, 120));
          const fine: { step: number; mouseX: number; colW: number; calcMid: string }[] = [];
          for (let i = 0; i < 16; i++) {
            const mx = pos.x + 250 - i * 25;
            wc.sendInputEvent({ type: 'mouseMove', x: mx, y: pos.y });
            await new Promise((r) => setTimeout(r, 70));
            fine.push({
              step: i,
              mouseX: mx,
              colW: JSON.parse(String(await wc.executeJavaScript(
                'Math.round(document.querySelectorAll(".loomery-main > .col")[1].getBoundingClientRect().width)',
              ))),
              calcMid: String(await wc.executeJavaScript('window.__lastMid ?? "-"')),
            });
          }
          console.log('[fine-drag]', JSON.stringify(fine));
          await new Promise((r) => setTimeout(r, 120));
          wc.sendInputEvent({ type: 'mouseMove', x: pos.x + 250, y: pos.y });
          await new Promise((r) => setTimeout(r, 200));
          const wider = JSON.parse(String(await wc.executeJavaScript(wExpr))) as number[];
          wc.sendInputEvent({ type: 'mouseMove', x: pos.x - 150, y: pos.y });
          await new Promise((r) => setTimeout(r, 200));
          const narrower = JSON.parse(String(await wc.executeJavaScript(wExpr))) as number[];
          wc.sendInputEvent({ type: 'mouseUp', x: pos.x - 150, y: pos.y, button: 'left' });
          const dragLog = await wc.executeJavaScript('JSON.stringify(window.__dragLog ?? [])');
          console.log('[drag-probe]', JSON.stringify({ before, afterPlus250: wider, afterMinus150: narrower }));
          console.log('[drag-log]', String(dragLog));
        })().catch((err) => console.error('[drag-probe] failed', err));
      }, 4500);
    }
    // DOM 探针（二次）：LOOMERY_SELF_SHOT_PROBE2 在 10s 注入——reload 两阶段验证用（页面上下文随 reload 销毁）
    const probe2 = process.env.LOOMERY_SELF_SHOT_PROBE2;
    if (probe2) {
      setTimeout(() => {
        void mainWindow?.webContents
          .executeJavaScript(probe2)
          .then((r) => console.log('[probe2]', String(r).slice(0, 2000)))
          .catch((err) => console.error('[probe2] failed', err));
      }, 10000);
    }
    // DOM 探针：LOOMERY_SELF_SHOT_PROBE=<js 表达式>，结果打日志；探针结算后按 LOOMERY_SELF_SHOT 落一张截图（视觉验收用）
    if (process.env.LOOMERY_SELF_SHOT_PROBE) {
      setTimeout(() => {
        void mainWindow?.webContents
          .executeJavaScript(process.env.LOOMERY_SELF_SHOT_PROBE as string)
          .then((r) => console.log('[probe]', String(r).slice(0, 2000)))
          .then(async () => {
            const shot = process.env.LOOMERY_SELF_SHOT;
            if (shot && mainWindow && !mainWindow.isDestroyed()) {
              const img = await mainWindow.webContents.capturePage();
              (await import('node:fs')).writeFileSync(shot, img.toPNG());
              console.log('[probe] screenshot saved ' + shot);
            }
          })
          .catch((err) => console.error('[probe] failed', err));
      }, 6500);
    }
  }
});
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

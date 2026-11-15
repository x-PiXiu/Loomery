import type { Diagnostic } from '@loomery/domain';

// ADR-0004：内核消费、渲染层实现
export interface EditRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface EditorGateway {
  openFile(path: string, opts?: { line?: number; col?: number }): Promise<void>;
  applyEdit(path: string, edit: EditRange & { newText: string }): Promise<boolean>;
  getSelection(): Promise<{ path: string; text: string } | null>;
  revealLine(path: string, line: number): Promise<void>;
  /** 12 UI：agent 控制内嵌 HTML 预览（刷新/导航；预览未打开时渲染层静默） */
  reloadPreview(path: string): Promise<void>;
  navigatePreview(path: string, target: string): Promise<void>;
  /** 2026-11-13：agent 在编辑区内置浏览器标签打开 URL（替代 start <url> 唤起系统浏览器的正确通道） */
  openBrowser(url: string, tab?: 'new' | 'active'): Promise<void>;
  /** 2026-11-13 P0①：编辑器实时诊断（Monaco markers）——agent 写完文件即时验证类型/语法（编辑器级验证闭环） */
  getDiagnostics(): Promise<Diagnostic[]>;
  /** 2026-11-13 P0②：页面渲染后文本提取（webview innerText / iframe postMessage）——agent"看见"页面内容 */
  getPageContent(target: { url?: string; path?: string }): Promise<string | null>;
  /** docs/16 P2：浏览器标签截图（rect=DIP 坐标，缺省全视口；webview capturePage → JPEG ≤1280w） */
  captureBrowserPage(
    url: string,
    rect?: { x: number; y: number; width: number; height: number },
  ): Promise<{ mime: 'image/jpeg'; base64: string; width: number; height: number } | null>;
  /** docs/16 P2：在浏览器标签内执行页面级 JS（点击/填值/滚动——webview 沙箱内，无宿主权限） */
  runBrowserJs(url: string, code: string): Promise<unknown>;
  /** docs/16 P2 批次 D：截图在编辑区以图片标签打开（用户直接看到 agent 看到的画面） */
  openImageTab(name: string, mime: string, base64: string): Promise<void>;
  /** docs/16 P2 批次 F：关闭浏览器标签 / 标签清单 */
  closeBrowserTab(url: string): Promise<void>;
  listBrowserTabs(): Promise<string[]>;
  /** docs/16 P2 批次 E：真实鼠标移动（CSS :hover 只有真实输入才触发——合成事件无效） */
  hoverBrowserPage(url: string, x: number, y: number): Promise<void>;
}

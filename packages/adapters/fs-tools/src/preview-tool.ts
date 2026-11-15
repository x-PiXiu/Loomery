// 12 UI：preview_control——agent 控制内嵌 HTML 预览（刷新/导航）+ 读取预览页 console + 内置浏览器标签 + 页面文本提取
// 这是"agent 自验证网页"的闭环件：写完 HTML → reload → console 拿报错 → content 看渲染结果 → 修复，不再盲写
// 2026-11-13：browser（内置浏览器标签，tab=active|new）+ content（渲染后文本提取）两动作实装
// （此前一轮 python 补丁静默未中——schema enum 无 browser 且 handler 无分支，模型调用会被 schema 校验拒绝。教训：补丁后必须 grep 实际落地）
import type { RegisteredTool, EditorGateway } from '@loomery/ports';

export interface PreviewToolDeps {
  /** 读预览页 console 缓冲（main 单例的 app-file 协议收集 buffer） */
  getConsoleLogs: (path: string) => { level: string; text: string; ts: number }[];
}

const MAX_LINES = 120;

export function createPreviewTool(deps: PreviewToolDeps): RegisteredTool {
  return {
    name: 'preview_control',
    description:
      '控制工作区 HTML 的内嵌预览与内置浏览器：action="console" 读取预览页 console 输出与报错（写完网页后先 reload 再读 console 验证）；' +
      'action="reload" 刷新预览；action="navigate" 预览跳转同项目另一页面；action="content" 提取页面渲染后的可见文本（验证接口数据/内容是否真的显示出来）；' +
      'action="browser" 在编辑区内置浏览器标签打开 url——展示网页一律用它，绝不 start <url> 唤起系统浏览器。',
    inputSchema: {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['console', 'reload', 'navigate', 'browser', 'content'],
          description:
            'console=读页面 console/报错（需 path）；reload=刷新预览（需 path）；navigate=预览跳转（需 path+target）；browser=内置浏览器标签打开 url（需 url）；content=提取渲染后文本（url 或 path 二选一）',
        },
        url: { type: 'string', description: 'action=browser/content 时：完整 URL（如 http://localhost:5173）' },
        tab: { type: 'string', enum: ['new', 'active'], description: 'action=browser 的标签语义：active=已有浏览器标签则原地换 URL（默认）；new=强制新标签' },
        path: { type: 'string', description: 'HTML 文件的工作区内绝对路径（console/reload/navigate/content 的预览目标页）', 'x-path': true },
        target: { type: 'string', description: 'action=navigate 时的目标页相对路径（如 "about.html"）' },
      },
    },
    sideEffect: 'read',
    source: 'builtin',
    handler: async (input, ctx) => {
      const raw = input as {
        action: 'console' | 'reload' | 'navigate' | 'browser' | 'content';
        path?: string;
        target?: string;
        url?: string;
        tab?: 'new' | 'active';
      };
      // 按动作校验必填：browser=需要 url；其余=需要 path
      if (raw.action === 'browser' && (typeof raw.url !== 'string' || raw.url.length === 0)) {
        return { ok: false, content: 'action="browser" 需要 url 参数（完整 http(s) URL，如 http://localhost:8080）', affectedPaths: [] };
      }
      if (raw.action !== 'browser' && (typeof raw.path !== 'string' || raw.path.length === 0)) {
        return { ok: false, content: `action="${raw.action}" 需要 path 参数（HTML 文件的工作区路径）`, affectedPaths: [] };
      }
      const path = raw.path ?? '';

      if (raw.action === 'console') {
        const logs = deps.getConsoleLogs(path);
        if (logs.length === 0) {
          return {
            ok: true,
            content: `（${path} 的预览暂无 console 输出/报错——若尚未打开预览或页面无输出，属正常）`,
            affectedPaths: [],
            evidence: { kind: 'preview', ok: true, detail: `预览 console 检查（${path.split(/[\\/]/).pop() ?? path}）：0 条输出` },
          };
        }
        const lines = logs.slice(-MAX_LINES).map((l) => `[${l.level}] ${l.text}`);
        const errCount = logs.filter((l) => l.level === 'error').length;
        return {
          ok: true,
          content: `预览 console（最近 ${lines.length} 条）：\n${lines.join('\n')}`,
          affectedPaths: [],
          // docs/15 升级 B：机器证据——console 报错数是"页面健康"的机器判定（零错误才算 ok）
          evidence: { kind: 'preview', ok: errCount === 0, detail: `预览 console 检查：${lines.length} 条输出、${errCount} 条 error` },
        };
      }

      const editor: EditorGateway | undefined = ctx.editor;
      if (!editor) return { ok: false, content: '编辑器网关不可用（预览由 UI 渲染层承载，当前无法控制）', affectedPaths: [] };

      if (raw.action === 'reload') {
        await editor.reloadPreview(path);
        return { ok: true, content: `已刷新预览：${path}。刷新后可用 preview_control(action="console") 查看页面 console 与报错。`, affectedPaths: [] };
      }

      if (raw.action === 'browser') {
        const tab = raw.tab === 'new' ? 'new' : 'active';
        await editor.openBrowser(raw.url as string, tab);
        const where = tab === 'new' ? '新标签页' : '浏览器标签页（已有标签则原地导航）';
        return {
          ok: true,
          content: `已在编辑区内置${where}打开 ${raw.url}。验证页面内容用 preview_control(action="content", url="${raw.url}")。`,
          affectedPaths: [],
        };
      }

      if (raw.action === 'content') {
        // P0②：页面渲染后可见文本——url（浏览器标签 webview executeJavaScript）或 path（HTML 预览 iframe 经注入 hook postMessage 应答）
        const text = await editor.getPageContent({
          ...(raw.url ? { url: raw.url } : {}),
          ...(raw.path ? { path } : {}),
        });
        if (!text || text.trim().length === 0) {
          return {
            ok: true,
            content:
              '（页面文本为空或目标页面未打开。浏览器标签用 url= 定位；HTML 预览用 path= 定位——若都未打开请先 preview_control(action="browser") 打开）',
            affectedPaths: [],
          };
        }
        const trimmed = text.length > 6000 ? text.slice(0, 6000) + '\n…（已截断）' : text;
        return { ok: true, content: `页面渲染后文本（${trimmed.length} 字符）：\n${trimmed}`, affectedPaths: [] };
      }

      // navigate
      await editor.navigatePreview(path, raw.target ?? '.');
      return { ok: true, content: `已导航预览到 ${raw.target ?? '.'}（基于 ${path} 同目录解析）。`, affectedPaths: [] };
    },
  };
}

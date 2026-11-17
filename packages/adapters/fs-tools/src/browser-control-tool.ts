// docs/16 P2：browser_control——编辑区内置浏览器标签的统一控制工具
// 截图（全视口/元素级，配额内图像进模型+编辑区图片标签+可存工作区）/ 页面交互（click/fill/press/hover/scroll）
// / 读取（read 文本、dom 大纲）/ 标签管理（close）。
// 与 preview_control 的域边界：preview_control=iframe 预览；browser_control=webview 浏览器标签。
// hover 用真实鼠标移动（sendInputEvent）——CSS :hover 合成事件无法触发。
import { toAbsolute } from './paths';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RegisteredTool, EditorGateway } from '@loomery/ports';

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
  });

const outlineJs = `(() => {
  const out = [];
  const walk = (el, depth) => {
    if (!el || depth > 3 || out.length > 100) return;
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '';
    const text = el.children.length === 0 ? (el.textContent || '').trim().slice(0, 40) : '';
    out.push('  '.repeat(depth) + tag + id + cls + (text ? ' — ' + text : ''));
    for (const c of el.children) walk(c, depth + 1);
  };
  walk(document.body, 0);
  return out.join('\\n');
})()`;

export interface BrowserControlDeps {
  /** 可达性探测（缺省：Node fetch 3s 超时）——空结果时自动诊断"服务是否在跑"，填平 LLM 的信息盲区 */
  probeUrl?: (url: string) => Promise<string>;
}

/** 缺省探测实现：HTTP 状态或不可达原因（单句，进观察文本） */
async function defaultProbe(url: string): Promise<string> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return `可达性探测：HTTP ${res.status}（服务在跑但页面可能未渲染）`;
  } catch (err) {
    return `可达性探测：目标不可达（${String(err instanceof Error ? err.message : err).slice(0, 80)}）——服务可能未启动。用 run_command(background=true) 启动服务后重试。`;
  }
}

export function createBrowserControlTool(deps: BrowserControlDeps = {}): RegisteredTool {
  const probeUrl = deps.probeUrl ?? defaultProbe;
  return {
    name: 'browser_control',
    description:
      // 11-17 上下文瘦身：截图配额/时序/预览前置与 SYSTEM_BASE「验证闭环」去重，括号参数细节交 schema
      '控制编辑区内置浏览器标签（dev 页面调试的眼睛和手）：screenshot 截图看布局（selector=元素级局部）、' +
      'wait 等元素出现/延时、click/fill/press/hover/scroll 操作页面、read 提取可见文本、' +
      'dom 返回简化 DOM 大纲、close 关闭标签——参数语义见 schema，截图配额与时序纪律见系统提示。' +
      '目标页未打开时先 preview_control(action="browser", url=…)。',
    inputSchema: {
      type: 'object',
      required: ['action', 'url'],
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['screenshot', 'wait', 'click', 'fill', 'press', 'hover', 'scroll', 'read', 'dom', 'close'],
          // 11-17 去重：动作语义已在工具说明逐项列出（enum 给名字），此处不再复述
          description: '动作语义见工具说明',
        },
        url: { type: 'string', description: '目标页完整 URL（定位对应浏览器标签）' },
        selector: { type: 'string', description: 'CSS 选择器：screenshot=元素级局部；click/fill/hover/scroll(wait)=目标元素' },
        text: { type: 'string', description: 'action=fill 时填入的文本' },
        key: { type: 'string', description: 'action=press 时的按键名（Enter/Escape/Tab/ArrowDown…）' },
        y: { type: 'number', description: 'action=scroll 的像素距离（正=向下）' },
        ms: { type: 'number', description: 'action=wait 且无 selector 时的固定延时（默认 1000）' },
        timeout: { type: 'number', description: 'action=wait 的等待上限 ms（默认 5000，上限 15000）' },
        open: { type: 'boolean', description: 'action=screenshot 时是否在编辑区打开图片标签（默认 true）' },
        save: { type: 'string', description: 'action=screenshot 时保存到工作区的相对路径（如 "screenshots/home.png"）' },
      },
    },
    sideEffect: 'read',
    source: 'builtin',
    handler: async (input, ctx) => {
      const raw = input as {
        action: 'screenshot' | 'wait' | 'click' | 'fill' | 'press' | 'hover' | 'scroll' | 'read' | 'dom' | 'close';
        url: string;
        selector?: string;
        text?: string;
        key?: string;
        y?: number;
        ms?: number;
        timeout?: number;
        open?: boolean;
        save?: string;
      };
      const editor: EditorGateway | undefined = ctx.editor;
      if (!editor) return { ok: false, content: '编辑器网关不可用（编辑器列未就绪）。', affectedPaths: [] };

      // ---- wait：异步页面的时序保障（截图前必用）----
      if (raw.action === 'wait') {
        const timeout = Math.min(Math.max(raw.timeout ?? 5000, 100), 15_000);
        if (raw.selector) {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const r = (await editor.runBrowserJs(raw.url, `!!document.querySelector(${JSON.stringify(raw.selector)})`)) as boolean | undefined;
            if (r === true) return { ok: true, content: `元素已出现：${raw.selector}（等待 ${timeout - (deadline - Date.now())}ms）。`, affectedPaths: [] };
            await sleep(250, ctx.signal);
          }
          return { ok: false, content: `等待超时（${timeout}ms）：元素未出现——${raw.selector}。接口可能失败或选择器错误，可用 action="read" 查看页面现状。`, affectedPaths: [] };
        }
        await sleep(Math.min(Math.max(raw.ms ?? 1000, 100), 15_000), ctx.signal);
        return { ok: true, content: `已延时 ${raw.ms ?? 1000}ms。`, affectedPaths: [] };
      }

      // ---- screenshot：截屏 + 编辑区图片标签 + 可选保存工作区 ----
      if (raw.action === 'screenshot') {
        let rect: { x: number; y: number; width: number; height: number } | undefined;
        if (raw.selector) {
          const rectJson = await editor.runBrowserJs(
            raw.url,
            `(() => { const el = document.querySelector(${JSON.stringify(raw.selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
          );
          if (!rectJson || typeof rectJson !== 'object') {
            return { ok: false, content: `元素未找到：${raw.selector}。先 action="dom" 查看 DOM 大纲挑选择器。`, affectedPaths: [] };
          }
          rect = rectJson as { x: number; y: number; width: number; height: number };
        }
        const shot = await editor.captureBrowserPage(raw.url, rect);
        if (!shot || shot.base64.length === 0) {
          const probe = await probeUrl(raw.url);
          return { ok: false, content: `截图失败：对应浏览器标签未打开（先 preview_control(action="browser") 打开）或页面崩溃。
${probe}`, affectedPaths: [] };
        }
        // 白屏检测：极小的 JPEG 多半是空页/连接拒绝页——把判断依据直接给模型
        if (shot.base64.length < 20000) {
          const probe = await probeUrl(raw.url);
          return {
            ok: true,
            content: `截图异常：捕获的图像过小（${shot.base64.length} 字节），页面大概率空白或为错误页。
${probe}
建议：确认服务已启动（run_command(background=true)）后再试，或用 read 查看页面文本。`,
            affectedPaths: [],
          };
        }
        const notes: string[] = [];
        // 保存到工作区（持久证据/回归基线）
        if (raw.save) {
          const savePath = toAbsolute(raw.save, ctx.workspaceRoots);
          await mkdir(dirname(savePath), { recursive: true });
          await writeFile(savePath, Buffer.from(shot.base64, 'base64'));
          notes.push(`已保存：${savePath}`);
        }
        // 编辑区图片标签（默认开——用户直接看到 agent 看到的画面）
        if (raw.open !== false) {
          await editor.openImageTab(`${Date.now()}-${raw.selector ? 'element' : 'page'}.jpg`, shot.mime, shot.base64);
          notes.push('已打开编辑区图片标签。');
        }
        const scope = raw.selector ? `元素 ${raw.selector}` : '全视口';
        return {
          ok: true,
          content: `已截图（${scope}，${shot.width}×${shot.height}，图像已随结果提供给模型）。${notes.join(' ')}`,
          affectedPaths: [],
          images: [{ mime: shot.mime, base64: shot.base64 }],
          evidence: { kind: 'preview', ok: true, detail: `浏览器截图：${scope} ${shot.width}×${shot.height}` },
        };
      }

      // ---- press：键盘事件（表单回车提交/Escape 关弹窗）----
      if (raw.action === 'press') {
        const key = raw.key ?? 'Enter';
        const targetSel = raw.selector;
        const js = `(() => {
          const el = ${targetSel ? `document.querySelector(${JSON.stringify(targetSel)})` : 'document.activeElement'};
          if (!el) return { ok: false, error: '目标元素不存在' };
          el.focus && el.focus();
          const init = { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true };
          el.dispatchEvent(new KeyboardEvent('keydown', init));
          el.dispatchEvent(new KeyboardEvent('keypress', init));
          el.dispatchEvent(new KeyboardEvent('keyup', init));
          return { ok: true };
        })()`;
        const r = (await editor.runBrowserJs(raw.url, js)) as { ok?: boolean; error?: string } | undefined;
        if (!r?.ok) return { ok: false, content: `按键失败：${r?.error ?? '目标元素不存在'}。`, affectedPaths: [] };
        return { ok: true, content: `已按下 ${key}${targetSel ? `（${targetSel}）` : ''}。查看结果：screenshot 或 read。`, affectedPaths: [] };
      }

      // ---- hover：真实鼠标移动（CSS :hover 菜单/tooltip）----
      if (raw.action === 'hover') {
        if (!raw.selector) return { ok: false, content: 'action="hover" 需要 selector 参数。', affectedPaths: [] };
        const rectJson = await editor.runBrowserJs(
          raw.url,
          `(() => { const el = document.querySelector(${JSON.stringify(raw.selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
        );
        const center = rectJson as { x: number; y: number } | null | undefined;
        if (!center) return { ok: false, content: `元素未找到：${raw.selector}。`, affectedPaths: [] };
        await editor.hoverBrowserPage(raw.url, Math.round(center.x), Math.round(center.y));
        return { ok: true, content: `已悬停 ${raw.selector}（真实鼠标移动，CSS :hover 已触发）。查看菜单：screenshot。`, affectedPaths: [] };
      }

      // ---- dom：简化 DOM 大纲（选择器发现的乘数）----
      if (raw.action === 'dom') {
        const outline = (await editor.runBrowserJs(raw.url, outlineJs)) as string | undefined;
        if (!outline) return { ok: false, content: 'DOM 大纲提取失败（标签未打开或页面错误）。', affectedPaths: [] };
        return { ok: true, content: `DOM 大纲（前 3 层，100 行封顶——据此挑选 click/fill/screenshot 的选择器）：\n${outline}`, affectedPaths: [] };
      }

      // ---- close：关闭浏览器标签 ----
      if (raw.action === 'close') {
        await editor.closeBrowserTab(raw.url);
        return { ok: true, content: `已关闭浏览器标签 ${raw.url}。`, affectedPaths: [] };
      }

      // ---- click / fill / scroll / read ----
      switch (raw.action) {
        case 'click': {
          if (!raw.selector) return { ok: false, content: 'action="click" 需要 selector 参数。', affectedPaths: [] };
          const r = (await editor.runBrowserJs(
            raw.url,
            `(() => { const el = document.querySelector(${JSON.stringify(raw.selector)}); if (!el) return { ok: false, error: '元素未找到' }; el.scrollIntoView({ block: 'center' }); el.click(); return { ok: true }; })()`,
          )) as { ok?: boolean; error?: string } | undefined;
          if (!r?.ok) return { ok: false, content: `点击失败：${r?.error ?? '元素未找到'}（${raw.selector}）`, affectedPaths: [] };
          return { ok: true, content: `已点击 ${raw.selector}。查看结果：screenshot 或 read。`, affectedPaths: [] };
        }
        case 'fill': {
          if (!raw.selector || typeof raw.text !== 'string') {
            return { ok: false, content: 'action="fill" 需要 selector 和 text 参数。', affectedPaths: [] };
          }
          const js = `(() => { const el = document.querySelector(${JSON.stringify(raw.selector)}); if (!el) return { ok: false, error: '元素未找到' }; const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (!setter) return { ok: false, error: '目标不是可填值元素' }; setter.call(el, ${JSON.stringify(raw.text)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; })()`;
          const r = (await editor.runBrowserJs(raw.url, js)) as { ok?: boolean; error?: string } | undefined;
          if (!r?.ok) return { ok: false, content: `填值失败：${r?.error ?? '未知原因'}（${raw.selector}）`, affectedPaths: [] };
          return { ok: true, content: `已向 ${raw.selector} 填入 ${raw.text.length} 字符。提交需显式 click 提交按钮或 press Enter。`, affectedPaths: [] };
        }
        case 'scroll': {
          const js = raw.selector
            ? `(() => { const el = document.querySelector(${JSON.stringify(raw.selector)}); if (!el) return { ok: false }; el.scrollIntoView({ block: 'center' }); return { ok: true }; })()`
            : `window.scrollBy(0, ${raw.y ?? 600}); ({ ok: true })`;
          await editor.runBrowserJs(raw.url, js);
          return { ok: true, content: '已滚动。', affectedPaths: [] };
        }
        case 'read': {
          const text = await editor.getPageContent({ url: raw.url });
          if (!text || text.trim().length === 0) {
            const probe = await probeUrl(raw.url);
            return { ok: true, content: `（页面文本为空或标签未打开）
${probe}
下一步建议：服务未启动→run_command(background=true) 启动；已启动→稍候重试或 screenshot 看渲染状态。`, affectedPaths: [] };
          }
          const trimmed = text.length > 6000 ? text.slice(0, 6000) + '\n…（已截断）' : text;
          return { ok: true, content: `页面可见文本（${trimmed.length} 字符）：\n${trimmed}`, affectedPaths: [] };
        }
      }
      return { ok: false, content: `未知动作：${raw.action}`, affectedPaths: [] };
    },
  };
}

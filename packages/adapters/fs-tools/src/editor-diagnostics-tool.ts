// 2026-11-13 P0① 编辑器级验证闭环：agent 写完文件后直接查询 Monaco TS 语言服务的实时诊断
// （红波浪线）——比 run_command tsc 快 100 倍且信息更精准（错误位置+原因）。
// read 类免审；诚实边界：Monaco 只为"打开过/加载过"的文件维护模型——未打开的文件无诊断，此时提示用 tsc 兜底。
import type { RegisteredTool } from '@loomery/ports';

export function createEditorDiagnosticsTool(): RegisteredTool {
  return {
    name: 'editor_diagnostics',
    description:
      '查询编辑器实时诊断（TS 语言服务/ESLint 的错误与警告——编辑器里的红/黄波浪线）。写完 TS/JS/TSX 文件后先查这个：' +
      '零 error 即类型与语法正确，比跑 tsc 快得多。可选 path 过滤只看某文件。' +
      '注意：只覆盖编辑器已加载的文件（本会话打开过的）——刚创建且未打开的文件查不到，此时用 run_command tsc --noEmit 兜底。',
    inputSchema: {
      type: 'object',
      required: [],
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '只看该文件的诊断（可选；绝对路径或文件名包含匹配）。缺省=全部已加载文件' },
        severity: { type: 'string', enum: ['error', 'warning', 'all'], description: '最低严重级别，默认 error' },
      },
    },
    sideEffect: 'read',
    source: 'builtin',
    handler: async (input, ctx) => {
      const editor = ctx.editor;
      if (!editor) {
        return { ok: false, content: '编辑器网关不可用（编辑器列未就绪）。请改用 run_command 跑 tsc --noEmit 验证。', affectedPaths: [] };
      }
      const raw = input as { path?: string; severity?: 'error' | 'warning' | 'all' };
      const list = await editor.getDiagnostics();
      if (!list || list.length === 0) {
        return {
          ok: true,
          content: '编辑器当前没有任何诊断记录（已加载文件均无错误/警告）。注意：只覆盖本会话打开过的文件——若目标文件未在编辑器打开过，请用 run_command 跑 tsc --noEmit 兜底验证。',
          affectedPaths: [],
          evidence: { kind: 'preview', ok: true, detail: 'editor_diagnostics：0 条' },
        };
      }
      const pathFilter = raw.path?.toLowerCase();
      const filtered = list.filter((d) => {
        if (pathFilter && !d.file.toLowerCase().includes(pathFilter.toLowerCase())) return false;
        if (raw.severity === 'all') return true;
        return raw.severity === 'warning' ? d.severity === 'error' || d.severity === 'warning' : d.severity === 'error';
      });
      const errors = filtered.filter((d) => d.severity === 'error').length;
      const warnings = filtered.filter((d) => d.severity === 'warning').length;
      if (filtered.length === 0) {
        return {
          ok: true,
          content: `诊断干净：${errors} 个错误、${warnings} 个警告（过滤条件：${raw.path ?? '全部已加载文件'}）。`,
          affectedPaths: [],
          evidence: { kind: 'preview', ok: true, detail: `editor_diagnostics：${errors}e/${warnings}w` },
        };
      }
      const lines = filtered
        .slice(0, 50)
        .map((d) => `- [${d.severity}] ${d.file}:${d.range.startLine}:${d.range.startCol}${d.source ? ` (${d.source})` : ''} ${d.message}`);
      const verdict = errors === 0 ? '✅ 无错误' : `❌ ${errors} 个错误需要修复`;
      return {
        ok: true,
        content: `${verdict}（${warnings} 个警告）。共 ${filtered.length} 条${filtered.length >= 50 ? '（截断）' : ''}：\n${lines.join('\n')}`,
        affectedPaths: [],
        evidence: { kind: 'preview', ok: errors === 0, detail: `editor_diagnostics：${errors}e/${warnings}w` },
      };
    },
  };
}

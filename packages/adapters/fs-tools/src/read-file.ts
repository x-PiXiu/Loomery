import { readFile } from 'node:fs/promises';
import { decodeText } from '@loomery/domain';
import type { RegisteredTool } from '@loomery/ports';
import { toAbsolute } from './paths';
import { isBinary } from './binary-detect';

/** 默认/最大读取行数：大文件默认只读头部（不产物化、模型可判断相关性后按 offset 精读） */
export const READ_FILE_DEFAULT_LINES = 400;
export const READ_FILE_MAX_LINES = 2000;

export function createReadFile(): RegisteredTool {
  return {
    name: 'read_file',
    description:
      '读取工作区内文本文件内容，输出带行号（格式 "   N| line"）。' +
      'path 必须为工作区内绝对路径；行号仅用于定位，apply_diff 的 oldLines 必须是不含行号前缀的原始行。' +
      '自动探测编码（UTF-8/GBK/Big5/UTF-16），非 UTF-8 文件也能正确读取。' +
      '大文件默认只读前 400 行并用提示标注剩余行数——先读开头判断相关性，用 offset/limit 精读所需段落，避免通读长文档。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        offset: { type: 'number', description: '起始行（1-based，与输出行号一致）。续读传上次提示的 offset 值' },
        limit: { type: 'number', description: `本次读取行数，默认 ${READ_FILE_DEFAULT_LINES}，上限 ${READ_FILE_MAX_LINES}` },
      },
    },
    sideEffect: 'read',
    source: 'builtin',
    handler: async (input, ctx) => {
      const raw = input as { path: string; offset?: number; limit?: number };
      const path = toAbsolute(raw.path, ctx.workspaceRoots);
      const buf = await readFile(path);
      if (isBinary(buf)) {
        return { ok: true, content: `[二进制文件：${buf.length} 字节，内容未显示]`, affectedPaths: [] };
      }
      // 编码探测解码（domain 纯规则）：GBK/Big5/UTF-16 文件不再乱码
      const { text } = decodeText(buf);
      const lines = text.split('\n');
      const total = lines.length;
      const start = Math.max(1, Math.floor(raw.offset ?? 1));
      const limit = Math.min(Math.max(1, Math.floor(raw.limit ?? READ_FILE_DEFAULT_LINES)), READ_FILE_MAX_LINES);
      const end = Math.min(total, start + limit - 1);
      // 05 §9：带行号输出（行号 = 文件内绝对行号，便于 apply_diff 定位与 offset 续读）
      const numbered = lines
        .slice(start - 1, end)
        .map((line, i) => `${String(start + i).padStart(6)}| ${line}`)
        .join('\n');
      const notes: string[] = [];
      if (start > total) return { ok: true, content: `[offset=${start} 超出文件总行数（共 ${total} 行）]`, affectedPaths: [] };
      if (end < total) {
        notes.push(`[文件共 ${total} 行，本次显示 ${start}-${end} 行（超出部分未读取）。继续读：offset=${end + 1}${end + limit <= total ? '' : '（至文件尾）'}]`);
      }
      if (start === 1 && end >= total && total > 1) {
        notes.push(`[全文件 ${total} 行]`);
      }
      const content = (numbered.length > 0 ? numbered : '（空文件）') + (notes.length > 0 ? '\n\n' + notes.join('\n') : '');
      return { ok: true, content, affectedPaths: [] };
    },
  };
}

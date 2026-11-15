import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RegisteredTool } from '@loomery/ports';
import { toAbsolute } from './paths';
import { isBinary } from './binary-detect';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'coverage']);
const MAX_DEPTH = 12;

export function createSearchText(): RegisteredTool {
  return {
    name: 'search_text',
    description: '在工作区内按子串（大小写不敏感）搜索文本文件，返回 file:line: text 列表。',
    inputSchema: {
      type: 'object',
      required: ['path', 'pattern'],
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '搜索起点（工作区内绝对路径）' },
        pattern: { type: 'string', description: '搜索子串' },
        maxResults: { type: 'number', description: '最大命中行数，默认 200' },
      },
    },
    sideEffect: 'read',
    source: 'builtin',
    handler: async (input, ctx) => {
      const raw = input as { path: string; pattern: string; maxResults?: number };
      const path = toAbsolute(raw.path, ctx.workspaceRoots);
      const { pattern, maxResults = 200 } = raw;
      const lower = pattern.toLowerCase();
      const lines: string[] = [];
      let walkTruncated = false;

      const walk = async (dir: string, depth: number): Promise<void> => {
        if (lines.length >= maxResults) return;
        if (depth > MAX_DEPTH) {
          walkTruncated = true;
          return;
        }
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          if (lines.length >= maxResults) return;
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
              await walk(join(dir, e.name), depth + 1);
            }
            continue;
          }
          if (!e.isFile()) continue;
          const full = join(dir, e.name);
          const buf = await readFile(full).catch(() => null);
          if (!buf || isBinary(buf)) continue;
          const fileLines = buf.toString('utf8').split('\n');
          for (const [i, line] of fileLines.entries()) {
            if (line.toLowerCase().includes(lower)) {
              lines.push(`${full}:${i + 1}: ${line.trim().slice(0, 200)}`);
              if (lines.length >= maxResults) return;
            }
          }
        }
      };

      await walk(path, 0);
      const capped = walkTruncated || lines.length >= maxResults;
      if (lines.length === 0) return { ok: true, content: `未找到匹配 "${pattern}"`, affectedPaths: [] };
      return {
        ok: true,
        content: `${capped ? '（结果达到上限，可能不完整）\n' : ''}${lines.join('\n')}`,
        affectedPaths: [],
      };
    },
  };
}

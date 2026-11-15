import { readdir } from 'node:fs/promises';
import { toAbsolute } from './paths';
import type { RegisteredTool } from '@loomery/ports';

export function createListDir(): RegisteredTool {
  return {
    name: 'list_dir',
    description: '列出一层目录内容。path 必须为工作区内绝对路径。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '目录绝对路径' },
      },
    },
    sideEffect: 'read',
    source: 'builtin',
    handler: async (input, ctx) => {
      const path = toAbsolute((input as { path: string }).path, ctx.workspaceRoots);
      // ENOTDIR/ENOENT 友好化（实证：模型猜路径失败 3 次，每次只拿到裸 ENOTDIR，恢复成本高）
      const entries = await readdir(path, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOTDIR') throw new Error(`"${path}" 是文件不是目录——请用 read_file 读取它。`);
        if (err.code === 'ENOENT') throw new Error(`目录不存在："${path}"。可先 list_dir 工作区根逐层确认结构。`);
        throw err;
      });
      const lines = entries
        .slice(0, 1000)
        .map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}${e.isDirectory() ? '/' : ''}`)
        .sort();
      return {
        ok: true,
        content: lines.length > 0 ? lines.join('\n') : '（空目录）',
        affectedPaths: [],
      };
    },
  };
}

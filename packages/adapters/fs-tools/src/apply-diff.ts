import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { toAbsolute } from './paths';
import type { RegisteredTool } from '@loomery/ports';
import type { CheckpointPort } from '@loomery/ports';
import { applyHunks, makeHunkProposal, resolveHunks } from './diff-engine';

const hunkSchema = {
  type: 'object',
  required: ['oldStart', 'oldLines', 'newStart', 'newLines'],
  additionalProperties: false,
  properties: {
    oldStart: { type: 'number', description: '旧内容起始行（1-based）' },
    oldLines: { type: 'array', items: { type: 'string' }, description: '待替换原行（内容锚点：在文件中唯一出现即可自动定位，行尾空白差异容忍）' },
    newStart: { type: 'number', description: '新内容起始行' },
    newLines: { type: 'array', items: { type: 'string' }, description: '替换后的行' },
  },
};

export function createApplyDiff(checkpoint: CheckpointPort): RegisteredTool {
  return {
    name: 'apply_diff',
    description: '按 hunk 修改文件。审批卡展示 diff。oldLines 是上下文锚点：在文件中唯一出现即可自动定位（行号不必精确，行尾空白差异容忍）；' +
      '匹配到多处会被拒绝——请在 oldLines 多带上下文行；oldLines 为空=在该位置插入新行。',
    inputSchema: {
      type: 'object',
      required: ['path', 'hunks'],
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '目标文件绝对路径' },
        hunks: { type: 'array', items: hunkSchema, description: '补丁块列表（oldLines 为内容锚点，行号允许漂移）' },
      },
    },
    sideEffect: 'write',
    source: 'builtin',
    prepareApproval: async (input, ctx) => {
      const raw = input as { path: string; hunks: Parameters<typeof resolveHunks>[1] };
      const path = toAbsolute(raw.path, ctx.workspaceRoots);
      const current = await readFile(path, 'utf8').catch(() => null);
      const v = resolveHunks(current, raw.hunks);
      if (!v.ok) throw new Error(v.error);
      return makeHunkProposal(path, v.resolved, ctx.toolCallId ?? 'unknown');
    },
    handler: async (input, ctx) => {
      const rawIn = input as { path: string; hunks: Parameters<typeof resolveHunks>[1] };
      const path = toAbsolute(rawIn.path, ctx.workspaceRoots);
      const snapshotted: string[] = [];
      if (ctx.turnId && (await checkpoint.snapshot(ctx.turnId, path))) snapshotted.push(path);
      const current = await readFile(path, 'utf8').catch(() => null);
      const v = resolveHunks(current, rawIn.hunks);
      if (!v.ok) return { ok: false, content: `应用失败：${v.error}`, affectedPaths: [] };
      // 同 write_file：父目录缺失自动创建（新建子目录内文件不再 ENOENT）
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, applyHunks(current ?? '', v.resolved), 'utf8');
      const diffProposal = makeHunkProposal(path, v.resolved, ctx.toolCallId ?? 'unknown');
      return { ok: true, content: `已应用 ${v.resolved.length} 个 hunk 到 ${path}`, affectedPaths: [path], diffProposal, ...(snapshotted.length > 0 ? { checkpointCreated: snapshotted } : {}) };
    },
  };
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RegisteredTool } from '@loomery/ports';
import type { CheckpointPort } from '@loomery/ports';
import { makeFullFileProposal } from './diff-engine';
import { toAbsolute } from './paths';

export function createWriteFile(checkpoint: CheckpointPort): RegisteredTool {
  return {
    name: 'write_file',
    description: '写入整个文件（覆盖已有内容或新建）。写入前先经用户审批，审批卡展示旧/新内容对比。',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '目标文件绝对路径' },
        content: { type: 'string', description: '完整文件内容' },
      },
    },
    sideEffect: 'write',
    source: 'builtin',
    prepareApproval: async (input, ctx) => {
      const raw = input as { path: string; content: string };
      const path = toAbsolute(raw.path, ctx.workspaceRoots);
      const old = await readFile(path, 'utf8').catch(() => null);
      const content = raw.content;
      return makeFullFileProposal(path, old, content, ctx.toolCallId ?? 'unknown');
    },
    handler: async (input, ctx) => {
      const raw = input as { path: string; content: string };
      const path = toAbsolute(raw.path, ctx.workspaceRoots);
      const content = raw.content;
      const snapshotted: string[] = [];
      // ADR-0021：暂存区写入不进 checkpoint（回滚不波及暂存区）
      if (!ctx.inScratch && ctx.turnId && (await checkpoint.snapshot(ctx.turnId, path))) snapshotted.push(path);
      // 用例不变量"写入目标必须可写"：父目录缺失时自动创建（否则模型无建目录手段，重试至循环熔断）
      await mkdir(dirname(path), { recursive: true });
      // 旧内容在写盘前读（提案用：完全访问档无审批提案，汇总卡 ±统计与 diff 视图靠它）
      const prev = await readFile(path, 'utf8').catch(() => null);
      await writeFile(path, content, 'utf8');
      const diffProposal = makeFullFileProposal(path, prev, content, ctx.toolCallId ?? 'unknown');
      return { ok: true, content: `已写入 ${path}（${content.length} 字符）`, affectedPaths: [path], diffProposal, ...(snapshotted.length > 0 ? { checkpointCreated: snapshotted } : {}) };
    },
  };
}

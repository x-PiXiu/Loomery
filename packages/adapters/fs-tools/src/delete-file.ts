// 2026-11-13 P1④ 删除文件：重构场景的另一半（agent 此前只能写不能删）。
// 安全三道闸与 write_file 同级：write 类审批门（用户点头）+ checkpoint 快照（可回滚恢复内容）+ 路径护栏（x-path）。
// v1 只支持文件（目录拒绝并提示）；移动场景 = write_file 新路径 + delete_file 旧路径 组合完成。
import { readFile, rm, stat } from 'node:fs/promises';
import { toAbsolute } from './paths';
import type { RegisteredTool } from '@loomery/ports';
import type { CheckpointPort } from '@loomery/ports';
import { makeFullFileProposal } from './diff-engine';

export function createDeleteFile(checkpoint: CheckpointPort): RegisteredTool {
  return {
    name: 'delete_file',
    description:
      '删除一个文件（重构/改名后清理旧文件用）。走用户审批 + checkpoint 快照（可回滚恢复内容）。' +
      '只支持文件不支持目录；移动文件 = write_file 写新路径 + delete_file 删旧路径 组合完成。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '要删除的文件绝对路径（必须位于工作区内）', 'x-path': true },
      },
    },
    sideEffect: 'write',
    source: 'builtin',
    prepareApproval: async (input, ctx) => {
      const raw = input as { path: string };
      const path = toAbsolute(raw.path, ctx.workspaceRoots);
      const content = await readFile(path, 'utf8').catch(() => null);
      if (content === null) throw new Error(`文件不存在或不可读：${path}`);
      // 审批预览：整文件以"删除"形态呈现（全行 - 红色）
      return makeFullFileProposal(path, content, '', ctx.toolCallId ?? 'unknown');
    },
    handler: async (input, ctx) => {
      const raw = input as { path: string };
      const path = toAbsolute(raw.path, ctx.workspaceRoots);
      const st = await stat(path).catch(() => null);
      if (!st) return { ok: false, content: `文件不存在：${path}`, affectedPaths: [] };
      if (st.isDirectory()) {
        return { ok: false, content: `目标是目录不是文件：${path}。本工具只删除文件；目录清理请提示用户在文件树手动进行。`, affectedPaths: [] };
      }
      const snapshotted: string[] = [];
      if (ctx.turnId && (await checkpoint.snapshot(ctx.turnId, path))) snapshotted.push(path);
      await rm(path, { force: true });
      return {
        ok: true,
        content: `已删除 ${path}${snapshotted.length > 0 ? '（checkpoint 已快照，可回滚恢复）' : ''}`,
        affectedPaths: [path],
        ...(snapshotted.length > 0 ? { checkpointCreated: snapshotted } : {}),
      };
    },
  };
}

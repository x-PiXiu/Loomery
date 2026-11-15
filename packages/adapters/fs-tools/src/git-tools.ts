// 12 §F1.3 git 薄工具族：3 只读（免审）+ 1 提交（write 审批）
// 危险面从接口根除：git_commit schema 只给 message+files——--amend/--force/--no-verify 在接口上不存在；
// branch/checkout/reset/push 不做工具（走 run_command 自然进审批链 + 危险拦截）
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RegisteredTool, GitPort } from '@loomery/ports';

/** 当前任务的 git 根；非 git 仓库返回 null（实锤：启动只探 CLI，testLoomery 非 git 仓库时模型撞 128 错浪费步数） */
function gitRoot(ctx: { workspaceRoots: string[] }): string | null {
  const root = ctx.workspaceRoots[0] ?? process.cwd();
  if (!existsSync(join(root, '.git'))) return null;
  return root;
}

function notRepo(): { ok: false; content: string; affectedPaths: string[] } {
  return {
    ok: false,
    content: '当前工作区不是 git 仓库（未找到 .git）。如需版本管理请先在项目根执行 git init，或确认打开了正确的项目。',
    affectedPaths: [],
  };
}

export function createGitStatus(git: GitPort): RegisteredTool {
  return {
    name: 'git_status',
    description: '查看当前工作区（git 仓库）状态：分支与变更文件清单（porcelain v2 格式）。',
    inputSchema: { type: 'object', required: [], additionalProperties: false, properties: {} },
    sideEffect: 'read',
    source: 'builtin',
    handler: async (_input, ctx) => {
      const root = gitRoot(ctx);
      if (!root) return notRepo();
      return { ok: true, content: await git.status(root), affectedPaths: [] };
    },
  };
}

export function createGitDiff(git: GitPort): RegisteredTool {
  return {
    name: 'git_diff',
    description: '查看当前工作区的未提交差异。staged=true 查看暂存区（将随下次提交进入仓库的内容），否则查看工作区相对 HEAD 的差异。',
    inputSchema: {
      type: 'object',
      required: [],
      additionalProperties: false,
      properties: {
        staged: { type: 'boolean', description: 'true=暂存区差异，缺省=工作区差异' },
      },
    },
    sideEffect: 'read',
    source: 'builtin',
    handler: async (input, ctx) => {
      const root = gitRoot(ctx);
      if (!root) return notRepo();
      return { ok: true, content: await git.diff(root, (input as { staged?: boolean }).staged), affectedPaths: [] };
    },
  };
}

export function createGitLog(git: GitPort): RegisteredTool {
  return {
    name: 'git_log',
    description: '查看最近提交记录（oneline 格式）。',
    inputSchema: {
      type: 'object',
      required: [],
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: '条数，默认 10，上限 100' },
      },
    },
    sideEffect: 'read',
    source: 'builtin',
    handler: async (input, ctx) => {
      const root = gitRoot(ctx);
      if (!root) return notRepo();
      return { ok: true, content: await git.log(root, (input as { limit?: number }).limit ?? 10), affectedPaths: [] };
    },
  };
}

export function createGitCommit(git: GitPort): RegisteredTool {
  return {
    name: 'git_commit',
    description: '提交变更到 git 仓库。message 必填且应清晰描述本次变更；files 省略时提交当前已暂存的变更，给出 files 时先暂存这些文件再提交。不提供任何 git flags（amend/force 等不可用）。',
    inputSchema: {
      type: 'object',
      required: ['message'],
      additionalProperties: false,
      properties: {
        message: { type: 'string', description: '提交信息' },
        files: { type: 'array', items: { type: 'string', description: '仓库内相对/绝对路径' }, description: '要暂存并提交的文件；缺省=提交已暂存内容' },
      },
    },
    sideEffect: 'write',
    source: 'builtin',
    handler: async (input, ctx) => {
      const root = gitRoot(ctx);
      if (!root) return notRepo();
      const raw = input as { message: string; files?: string[] };
      const summary = await git.commit(root, raw.message, raw.files);
      return { ok: true, content: `提交完成：${summary}`, affectedPaths: [] };
    },
  };
}

/** git 工具全集（git 不可用/非 git 仓库时组合根不注册） */
export function createGitTools(git: GitPort): RegisteredTool[] {
  return [createGitStatus(git), createGitDiff(git), createGitLog(git), createGitCommit(git)];
}

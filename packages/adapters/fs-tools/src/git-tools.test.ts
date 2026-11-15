// F1.3：git 薄工具经真实管道（read 免审 / commit 审批 / 参数映射）
import { mkdirSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry, ToolPipeline, FanoutSink, FakeApprovals, FakeClock, RecordingSink } from '@loomery/agent-core';
import type { GitPort } from '@loomery/ports';
import { createGitTools } from './git-tools';
import type { GitBranches, GraphCommit, GitOverview, ReviewFile, ReviewMode } from '@loomery/ports';

let workspace = '';
afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

class FakeGit implements GitPort {
  calls: { op: string; args: unknown[] }[] = [];
  async available(): Promise<boolean> {
    return true;
  }
  async status(root: string): Promise<string> {
    this.calls.push({ op: 'status', args: [root] });
    return '# branch.head main\n1 1 M a.txt\n';
  }
  async diff(root: string, staged?: boolean): Promise<string> {
    this.calls.push({ op: 'diff', args: [root, staged] });
    return staged ? 'staged-diff' : 'worktree-diff';
  }
  async log(root: string, limit: number): Promise<string> {
    this.calls.push({ op: 'log', args: [root, limit] });
    return 'abc123 feat: x';
  }
  async commit(root: string, message: string, files?: string[]): Promise<string> {
    this.calls.push({ op: 'commit', args: [root, message, files] });
    return 'abc123 test commit';
  }
  async overview(root: string): Promise<GitOverview> {
    this.calls.push({ op: 'overview', args: [root] });
    return { repo: true, branch: 'main', changed: [], totalAdded: 0, totalRemoved: 0 };
  }
  async reviewList(root: string, mode: ReviewMode): Promise<ReviewFile[]> {
    this.calls.push({ op: 'reviewList', args: [root, mode] });
    return [];
  }
  async fileDiff(root: string, path: string, mode: ReviewMode): Promise<{ text: string; truncated: boolean }> {
    this.calls.push({ op: 'fileDiff', args: [root, path, mode] });
    return { text: '', truncated: false };
  }
  async branches(root: string): Promise<GitBranches> {
    this.calls.push({ op: 'branches', args: [root] });
    return { current: 'main', detached: false, local: ['main'], remote: [] };
  }
  async checkout(root: string, branch: string, create?: boolean): Promise<void> {
    this.calls.push({ op: 'checkout', args: [root, branch, create] });
  }
  async push(root: string, _remote?: string, _branch?: string): Promise<string> {
    this.calls.push({ op: 'push', args: [root] });
    return '已推送';
  }
  async add(root: string, files: string[]): Promise<void> {
    this.calls.push({ op: 'add', args: [root, files] });
  }
  async unstage(root: string, files: string[]): Promise<void> {
    this.calls.push({ op: 'unstage', args: [root, files] });
  }
  async merge(root: string, branch: string): Promise<string> {
    this.calls.push({ op: 'merge', args: [root, branch] });
    return 'merged';
  }
  async rebase(root: string, branch: string): Promise<string> {
    this.calls.push({ op: 'rebase', args: [root, branch] });
    return 'rebased';
  }
  async graphData(root: string, limit: number): Promise<GraphCommit[]> {
    this.calls.push({ op: 'graphData', args: [root, limit] });
    return [];
  }
}

function setup(git: GitPort, approval: Record<string, 'auto' | 'ask' | 'deny'> = { read: 'auto', write: 'ask', execute: 'deny' }) {
  // gitRoot 探测 .git：测试工作区预置（handler 级探测 Fix C）
  if (workspace) mkdirSync(join(workspace, '.git'), { recursive: true });
  const recorder = new RecordingSink();
  const sink = new FanoutSink([recorder], new FakeClock());
  const registry = new ToolRegistry();
  for (const t of createGitTools(git)) registry.register(t);
  const pipeline = new ToolPipeline(registry, new FakeApprovals(), new FakeClock(), {
    approvalPolicy: approval,
    toolResultCharCap: 20_000,
  });
  const emit = sink.scoped({ threadId: 't1', turnId: 'turn1' });
  return {
    pipeline,
    emit,
    recorder,
    ctx: {
      threadId: 't1',
      turnId: 'turn1',
      step: 1,
      mode: 'edit' as const,
      workspaceRoots: [workspace],
      signal: new AbortController().signal,
      injectionFlagged: false,
    },
  };
}

describe('git 薄工具（经真实管道）', () => {
  it('git_status：read 免审，root 取 workspaceRoots[0]', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    const git = new FakeGit();
    const { pipeline, ctx, emit } = setup(git, { read: 'auto', write: 'ask', execute: 'deny' });
    const r = await pipeline.execute({ toolCallId: 'c1', name: 'git_status', args: '{}' }, ctx, emit);
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('branch.head main');
    expect(git.calls[0]).toMatchObject({ op: 'status', args: [workspace] });
  });

  it('git_diff staged 参数透传；git_log limit 透传', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    const git = new FakeGit();
    const { pipeline, ctx, emit } = setup(git, { read: 'auto', write: 'ask', execute: 'deny' });
    const d = await pipeline.execute(
      { toolCallId: 'c1', name: 'git_diff', args: JSON.stringify({ staged: true }) },
      ctx,
      emit,
    );
    expect(d.observation).toBe('staged-diff');
    const l = await pipeline.execute(
      { toolCallId: 'c2', name: 'git_log', args: JSON.stringify({ limit: 25 }) },
      ctx,
      emit,
    );
    expect(l.observation).toContain('abc123');
    expect(git.calls.map((c) => c.op)).toEqual(['diff', 'log']);
    expect(git.calls[1]?.args[1]).toBe(25);
  });

  it('git_commit：write 类走审批，批准后调用（flags 在 schema 上不存在）', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    const git = new FakeGit();
    const { pipeline, ctx, emit, recorder } = setup(git);
    const r = await pipeline.execute(
      {
        toolCallId: 'c1',
        name: 'git_commit',
        args: JSON.stringify({ message: 'feat: 完成 F1.3', files: ['src/a.ts'] }),
      },
      ctx,
      emit,
    );
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('提交完成');
    expect(recorder.of('approvalRequired')).toHaveLength(1); // write=ask
    expect(git.calls[0]).toMatchObject({ op: 'commit', args: [workspace, 'feat: 完成 F1.3', ['src/a.ts']] });
  });

  it('非 git 仓库（无 .git）→ 友好报错不触达 git CLI（Fix C）', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-')); // 不建 .git
    const git = new FakeGit();
    const { pipeline, ctx, emit } = setup(git, { read: 'auto', write: 'ask', execute: 'deny' });
    // setup 会在有 workspace 时建 .git——这里删除以模拟非仓库
    rmSync(join(workspace, '.git'), { recursive: true, force: true });
    const r = await pipeline.execute({ toolCallId: 'c1', name: 'git_status', args: '{}' }, ctx, emit);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('不是 git 仓库');
    expect(git.calls).toHaveLength(0);
  });

  it('git_commit 危险参数被 schema 拒绝（additionalProperties 根除 flags）', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    const git = new FakeGit();
    const { pipeline, ctx, emit } = setup(git);
    const r = await pipeline.execute(
      { toolCallId: 'c1', name: 'git_commit', args: JSON.stringify({ message: 'x', amend: true, force: true }) },
      ctx,
      emit,
    );
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('schema 校验');
    expect(git.calls).toHaveLength(0); // 未触达 git
  });
});

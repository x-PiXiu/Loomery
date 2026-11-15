// F1.2：run_command 经真实管道（x-path cwd 护栏 / 归一化 / observation 语义）
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry, ToolPipeline, FanoutSink, FakeApprovals, FakeClock, RecordingSink } from '@loomery/agent-core';
import type { ProcessPort, ProcessResult, ProcessSpawnRequest } from '@loomery/ports';
import { createRunCommand } from './execute';

let workspace = '';
afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

class FakeProcessPort implements ProcessPort {
  calls: ProcessSpawnRequest[] = [];
  constructor(
    private readonly results: Partial<ProcessResult>[] = [],
    private readonly err?: Error,
  ) {}
  async spawn(req: ProcessSpawnRequest): Promise<ProcessResult> {
    this.calls.push(req);
    if (this.err) throw this.err;
    return { exitCode: 0, timedOut: false, output: 'ok', truncated: false, ...this.results.shift() };
  }
}

function setup(processPort: ProcessPort, approval: 'ask' | 'auto' = 'ask') {
  const recorder = new RecordingSink();
  const sink = new FanoutSink([recorder], new FakeClock());
  const registry = new ToolRegistry();
  registry.register(createRunCommand(processPort));
  const pipeline = new ToolPipeline(registry, new FakeApprovals(), new FakeClock(), {
    approvalPolicy: { read: 'auto', write: 'ask', execute: approval },
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

describe('run_command（经真实管道）', () => {
  it('成功命令：observation 含输出，ok=true', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    const port = new FakeProcessPort([{ output: 'build done', exitCode: 0 }]);
    const { pipeline, ctx, emit } = setup(port);
    const r = await pipeline.execute(
      { toolCallId: 'c1', name: 'run_command', args: JSON.stringify({ command: 'npm run build' }) },
      ctx,
      emit,
    );
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('build done');
    expect(port.calls[0]?.cwd).toBe(workspace); // cwd 缺省 = roots[0]
  });

  it('非零退出码：ok=false + 显式退出码（模型自纠信号）', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    const port = new FakeProcessPort([{ output: 'TS2345: error', exitCode: 2 }]);
    const { pipeline, ctx, emit } = setup(port);
    const r = await pipeline.execute(
      { toolCallId: 'c1', name: 'run_command', args: JSON.stringify({ command: 'tsc --noEmit' }) },
      ctx,
      emit,
    );
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('命令失败（exit=2）');
    expect(r.observation).toContain('TS2345');
  });

  it('超时：ok=false + 拆小提示', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    const port = new FakeProcessPort([{ timedOut: true, exitCode: null, output: 'partial' }]);
    const { pipeline, ctx, emit } = setup(port);
    const r = await pipeline.execute(
      { toolCallId: 'c1', name: 'run_command', args: JSON.stringify({ command: 'npm test', timeoutMs: 1000 }) },
      ctx,
      emit,
    );
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('超时');
    expect(port.calls[0]?.timeoutMs).toBe(1000);
  });

  it('x-path 元数据：cwd 相对路径归一化为绝对路径', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    const port = new FakeProcessPort();
    const { pipeline, ctx, emit } = setup(port);
    await pipeline.execute(
      { toolCallId: 'c1', name: 'run_command', args: JSON.stringify({ command: 'ls', cwd: 'sub/dir' }) },
      ctx,
      emit,
    );
    expect(port.calls[0]?.cwd).toBe(join(workspace, 'sub', 'dir'));
  });

  it('x-path 元数据：cwd 越界被路径护栏拦截（不再依赖 PATH_FIELDS 白名单）', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    const port = new FakeProcessPort();
    const { pipeline, ctx, emit, recorder } = setup(port);
    const outside = join(await mkdtemp(join(tmpdir(), 'outside-')), 'x');
    const r = await pipeline.execute(
      { toolCallId: 'c1', name: 'run_command', args: JSON.stringify({ command: 'ls', cwd: outside }) },
      ctx,
      emit,
    );
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('路径越界');
    expect(recorder.of('guardrailTriggered')[0]).toMatchObject({ rule: 'pathOutside' });
    expect(port.calls).toHaveLength(0);
    await rm(outside, { force: true });
  });

  it('spawn 抛错 → 失败观察回灌', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    const port = new FakeProcessPort([], new Error('no such cwd'));
    const { pipeline, ctx, emit } = setup(port);
    const r = await pipeline.execute(
      { toolCallId: 'c1', name: 'run_command', args: JSON.stringify({ command: 'x' }) },
      ctx,
      emit,
    );
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('命令无法启动');
  });
});

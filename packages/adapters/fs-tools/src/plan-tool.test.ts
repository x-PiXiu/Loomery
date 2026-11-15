// ADR-0026：plan_write 经真实管道（免审 read 类 / 校验失败回灌 / planUpdated 侧通道事件）
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry, ToolPipeline, FanoutSink, FakeApprovals, FakeClock, RecordingSink } from '@loomery/agent-core';
import { createPlanTool } from './plan-tool';

let workspace = '';
afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe('plan_write（经真实管道）', () => {
  it('合法清单：ok + planUpdated 事件（read 类免审直达）', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    const recorder = new RecordingSink();
    const sink = new FanoutSink([recorder], new FakeClock());
    const registry = new ToolRegistry();
    registry.register(createPlanTool());
    const pipeline = new ToolPipeline(registry, new FakeApprovals(), new FakeClock(), {
      approvalPolicy: { read: 'auto', write: 'ask', execute: 'deny' },
      toolResultCharCap: 20_000,
    });
    const emit = sink.scoped({ threadId: 't1', turnId: 'turn9' });
    const r = await pipeline.execute(
      {
        toolCallId: 'c1',
        name: 'plan_write',
        args: JSON.stringify({
          steps: [
            { title: '读取目录', status: 'completed' },
            { title: '写页面', status: 'in_progress' },
            { title: '验证', status: 'pending' },
          ],
        }),
      },
      { threadId: 't1', turnId: 'turn9', step: 1, mode: 'edit', workspaceRoots: [workspace], signal: new AbortController().signal, injectionFlagged: false },
      emit,
    );
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('共 3 步');
    const ev = recorder.of('planUpdated')[0] as { turnId: string; steps: { id: string; status: string }[] };
    expect(ev.turnId).toBe('turn9');
    expect(ev.steps).toHaveLength(3);
    expect(ev.steps[0]).toMatchObject({ id: 's1', status: 'completed' });
    expect(recorder.of('approvalRequired')).toHaveLength(0); // read 免审
  });

  it('非法清单：ok=false + 可自纠观察，无事件', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    const recorder = new RecordingSink();
    const sink = new FanoutSink([recorder], new FakeClock());
    const registry = new ToolRegistry();
    registry.register(createPlanTool());
    const pipeline = new ToolPipeline(registry, new FakeApprovals(), new FakeClock(), {
      approvalPolicy: { read: 'auto', write: 'ask', execute: 'deny' },
      toolResultCharCap: 20_000,
    });
    const emit = sink.scoped({ threadId: 't1', turnId: 'turn9' });
    const r = await pipeline.execute(
      { toolCallId: 'c1', name: 'plan_write', args: JSON.stringify({ steps: [{ title: 'only', status: 'pending' }] }) },
      { threadId: 't1', turnId: 'turn9', step: 1, mode: 'edit', workspaceRoots: [workspace], signal: new AbortController().signal, injectionFlagged: false },
      emit,
    );
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('未通过校验');
    expect(recorder.of('planUpdated')).toHaveLength(0);
  });
});

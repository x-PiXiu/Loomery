// 经真实 ToolPipeline 的 fs 工具集成测试（05 §4 管道 + 07 §2 写盘语义 + 07 §5 checkpoint）
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '@loomery/agent-core';
import { ToolPipeline } from '@loomery/agent-core';
import { FanoutSink } from '@loomery/agent-core';
import { FakeApprovals, FakeClock, RecordingSink } from '@loomery/agent-core';
import {
  CheckpointService,
  createBuiltinTools,
  rollbackTurn,
} from './index';

let workspace = '';
let checkpointRoot = '';
let recorder: RecordingSink;
let registry: ToolRegistry;
let pipeline: ToolPipeline;
let emit: ReturnType<FanoutSink['scoped']>;
let checkpoint: CheckpointService;

afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
  if (checkpointRoot) await rm(checkpointRoot, { recursive: true, force: true });
});

function setup(mode: 'edit' | 'plan' = 'edit') {
  recorder = new RecordingSink();
  const sink = new FanoutSink([recorder], new FakeClock());
  registry = new ToolRegistry();
  checkpoint = new CheckpointService(checkpointRoot);
  for (const tool of createBuiltinTools(checkpoint)) registry.register(tool);
  pipeline = new ToolPipeline(registry, new FakeApprovals(), new FakeClock(), {
    approvalPolicy: { read: 'auto', write: 'ask', execute: 'deny' },
    toolResultCharCap: 20_000,
  });
  emit = sink.scoped({ threadId: 't1', turnId: 'turn1' });
  return {
    pipeline,
    ctx: {
      threadId: 't1',
      turnId: 'turn1',
      step: 1,
      mode,
      workspaceRoots: [workspace],
      signal: new AbortController().signal,
      injectionFlagged: false,
    },
  };
}

describe('内置文件工具（经真实管道）', () => {
  it('read_file 读取文本', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    checkpointRoot = await mkdtemp(join(tmpdir(), 'loomery-ck-'));
    const { pipeline, ctx } = setup();
    const file = join(workspace, 'a.txt');
    await writeFile(file, 'hello\nworld', 'utf8');
    const r = await pipeline.execute(
      { toolCallId: 'c1', name: 'read_file', args: JSON.stringify({ path: file }) },
      ctx,
      emit,
    );
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('| hello');
    expect(r.observation).toContain('2| world');
  });

  it('read_file 拦截越界路径', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    checkpointRoot = await mkdtemp(join(tmpdir(), 'loomery-ck-'));
    const { pipeline, ctx } = setup();
    const outside = join(await mkdtemp(join(tmpdir(), 'outside-')), 'x.txt');
    const r = await pipeline.execute(
      { toolCallId: 'c1', name: 'read_file', args: JSON.stringify({ path: outside }) },
      ctx,
      emit,
    );
    expect(r.ok).toBe(false);
    expect(recorder.of('guardrailTriggered')[0]).toMatchObject({ rule: 'pathOutside' });
    await rm(outside, { force: true });
  });

  it('list_dir / search_text', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    checkpointRoot = await mkdtemp(join(tmpdir(), 'loomery-ck-'));
    const { pipeline, ctx } = setup();
    await writeFile(join(workspace, 'code.ts'), 'const answer = 42;\nexport {}', 'utf8');
    const ls = await pipeline.execute(
      { toolCallId: 'c1', name: 'list_dir', args: JSON.stringify({ path: workspace }) },
      ctx,
      emit,
    );
    expect(ls.observation).toContain('- code.ts');
    const search = await pipeline.execute(
      { toolCallId: 'c2', name: 'search_text', args: JSON.stringify({ path: workspace, pattern: 'answer' }) },
      ctx,
      emit,
    );
    expect(search.observation).toContain('code.ts:1');
  });

  it('write_file：审批通过 → 写盘 + checkpoint 懒快照（原始内容保留）', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    checkpointRoot = await mkdtemp(join(tmpdir(), 'loomery-ck-'));
    const { pipeline, ctx } = setup();
    const file = join(workspace, 'a.txt');
    await writeFile(file, 'v1', 'utf8');

    const r1 = await pipeline.execute(
      { toolCallId: 'c1', name: 'write_file', args: JSON.stringify({ path: file, content: 'v2' }) },
      ctx,
      emit,
    );
    expect(r1.ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('v2');
    // 快照保存的是写入前的 v1
    expect(await readFile(checkpoint.snapshotPath('turn1', file), 'utf8')).toBe('v1');

    // 第二次写：快照不应被覆盖（懒语义）
    await pipeline.execute(
      { toolCallId: 'c2', name: 'write_file', args: JSON.stringify({ path: file, content: 'v3' }) },
      ctx,
      emit,
    );
    expect(await readFile(checkpoint.snapshotPath('turn1', file), 'utf8')).toBe('v1');

    // 审批卡携带合成 diff（旧 v1 vs 新 v2）
    expect(recorder.of('approvalRequired')[0]?.diffProposal?.hunks[0]?.oldLines).toEqual(['v1']);
  });

  it('apply_diff：hunk 校验失败 → 审批材料抛错被拦截', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    checkpointRoot = await mkdtemp(join(tmpdir(), 'loomery-ck-'));
    const { pipeline, ctx } = setup();
    const file = join(workspace, 'a.txt');
    await writeFile(file, 'a\nb\nc', 'utf8');
    const r = await pipeline.execute(
      {
        toolCallId: 'c1',
        name: 'apply_diff',
        args: JSON.stringify({
          path: file,
          hunks: [{ oldStart: 2, oldLines: ['不匹配的行'], newStart: 2, newLines: ['X'] }],
        }),
      },
      ctx,
      emit,
    );
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('未找到');
    expect(await readFile(file, 'utf8')).toBe('a\nb\nc');
  });

  it('apply_diff：校验通过 → 审批 → 应用 hunk → diffResolved accepted', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    checkpointRoot = await mkdtemp(join(tmpdir(), 'loomery-ck-'));
    const { pipeline, ctx } = setup();
    const file = join(workspace, 'a.txt');
    await writeFile(file, 'a\nb\nc', 'utf8');
    const r = await pipeline.execute(
      {
        toolCallId: 'c1',
        name: 'apply_diff',
        args: JSON.stringify({
          path: file,
          hunks: [{ oldStart: 2, oldLines: ['b'], newStart: 2, newLines: ['X', 'Y'] }],
        }),
      },
      ctx,
      emit,
    );
    expect(r.ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('a\nX\nY\nc');
    expect(recorder.of('diffResolved')[0]).toMatchObject({ status: 'accepted' });
    expect(recorder.of('toolExecuted')[0]?.affectedPaths).toEqual([file]);

    // 回滚后回到初始内容
    const rollback = await rollbackTurn(checkpoint, 'turn1');
    expect(rollback.restored).toContain(file);
    expect(await readFile(file, 'utf8')).toBe('a\nb\nc');
  });

  it('apply_diff 新建文件：oldLines 为空合法', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    checkpointRoot = await mkdtemp(join(tmpdir(), 'loomery-ck-'));
    const { pipeline, ctx } = setup();
    const file = join(workspace, 'new.txt');
    const r = await pipeline.execute(
      {
        toolCallId: 'c1',
        name: 'apply_diff',
        args: JSON.stringify({
          path: file,
          hunks: [{ oldStart: 1, oldLines: [], newStart: 1, newLines: ['hello'] }],
        }),
      },
      ctx,
      emit,
    );
    expect(r.ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('hello');
    // 回滚删除新建文件
    const rollback = await rollbackTurn(checkpoint, 'turn1');
    expect(rollback.restored).toContain(file);
    expect(existsSync(file)).toBe(false);
  });

  it('read_file 大文件默认截断 + offset 续读行号连续（步数黑洞修复）', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    checkpointRoot = await mkdtemp(join(tmpdir(), 'loomery-ck-'));
    const { pipeline, ctx } = setup();
    const file = join(workspace, 'big.txt');
    await writeFile(file, Array.from({ length: 1000 }, (_, i) => 'line-' + (i + 1)).join(String.fromCharCode(10)), 'utf8');
    // 默认：前 400 行 + 续读提示
    const r1 = await pipeline.execute(
      { toolCallId: 'c1', name: 'read_file', args: JSON.stringify({ path: file }) },
      ctx,
      emit,
    );
    expect(r1.ok).toBe(true);
    expect(r1.observation).toContain('| line-1');
    expect(r1.observation).not.toContain('| line-401');
    expect(r1.observation).toContain('文件共 1000 行，本次显示 1-400 行');
    expect(r1.observation).toContain('offset=401');
    // 续读：行号从 401 连续
    const r2 = await pipeline.execute(
      { toolCallId: 'c2', name: 'read_file', args: JSON.stringify({ path: file, offset: 401, limit: 100 }) },
      ctx,
      emit,
    );
    expect(r2.observation).toContain('401| line-401');
    expect(r2.observation).toContain('500| line-500');
    expect(r2.observation).not.toContain('501| line-501');
    // offset 超界友好提示
    const r3 = await pipeline.execute(
      { toolCallId: 'c3', name: 'read_file', args: JSON.stringify({ path: file, offset: 5000 }) },
      ctx,
      emit,
    );
    expect(r3.observation).toContain('超出文件总行数');
    // 小文件全读不变（含全文件标注）
    const small = join(workspace, 'small.txt');
    await writeFile(small, 'a' + String.fromCharCode(10) + 'b', 'utf8');
    const r4 = await pipeline.execute(
      { toolCallId: 'c4', name: 'read_file', args: JSON.stringify({ path: small }) },
      ctx,
      emit,
    );
    expect(r4.observation).toContain('1| a');
    expect(r4.observation).toContain('2| b');
    expect(r4.observation).toContain('全文件 2 行');
  });

  it('write_file 父目录不存在时自动创建（F0.1：写子目录不再 ENOENT 死循环）', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    checkpointRoot = await mkdtemp(join(tmpdir(), 'loomery-ck-'));
    const { pipeline, ctx } = setup();
    const file = join(workspace, 'css', 'deep', 'style.css');
    const r = await pipeline.execute(
      { toolCallId: 'c1', name: 'write_file', args: JSON.stringify({ path: file, content: 'body{}' }) },
      ctx,
      emit,
    );
    expect(r.ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('body{}');
  });

  it('apply_diff 新建子目录内文件同样自动建父目录（F0.1）', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    checkpointRoot = await mkdtemp(join(tmpdir(), 'loomery-ck-'));
    const { pipeline, ctx } = setup();
    const file = join(workspace, 'js', 'app.js');
    const r = await pipeline.execute(
      {
        toolCallId: 'c1',
        name: 'apply_diff',
        args: JSON.stringify({
          path: file,
          hunks: [{ oldStart: 1, oldLines: [], newStart: 1, newLines: ['console.log(1)'] }],
        }),
      },
      ctx,
      emit,
    );
    expect(r.ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('console.log(1)');
  });

  it('plan 模式下写类工具被只读护栏拦截', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    checkpointRoot = await mkdtemp(join(tmpdir(), 'loomery-ck-'));
    const { pipeline, ctx } = setup('plan');
    const file = join(workspace, 'a.txt');
    const r = await pipeline.execute(
      { toolCallId: 'c1', name: 'write_file', args: JSON.stringify({ path: file, content: 'x' }) },
      ctx,
      emit,
    );
    expect(r.ok).toBe(false);
    expect(recorder.of('guardrailTriggered')[0]).toMatchObject({ rule: 'readonlyBlocked' });
    expect(existsSync(file)).toBe(false);
  });

  it('createBuiltinTools 注册 9 个工具且 plan 模式 schema 只见 6 个 read 工具（含 browser_control）', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    checkpointRoot = await mkdtemp(join(tmpdir(), 'loomery-ck-'));
    const { ctx: _c } = setup();
    expect(registry.listSpecs()).toHaveLength(9);
    const planTools = registry.listSpecs('plan').map((t) => t.name);
    expect(planTools).toEqual(['read_file', 'list_dir', 'search_text', 'plan_write', 'editor_diagnostics', 'browser_control']);
  });

  it('readdir 冒烟：checkpoint 目录按 Turn 归档', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
    checkpointRoot = await mkdtemp(join(tmpdir(), 'loomery-ck-'));
    const { pipeline, ctx } = setup();
    const file = join(workspace, 'a.txt');
    await writeFile(file, 'v1', 'utf8');
    await pipeline.execute(
      { toolCallId: 'c1', name: 'write_file', args: JSON.stringify({ path: file, content: 'v2' }) },
      ctx,
      emit,
    );
    const turns = await readdir(checkpointRoot);
    expect(turns).toEqual(['turn1']);
  });
});

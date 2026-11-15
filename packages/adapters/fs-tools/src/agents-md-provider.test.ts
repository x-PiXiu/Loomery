// AGENTS.md 贡献者回归锁：存在注入/缺省空态/截断保护/线程根优先
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProjectInstructionsProvider } from './agents-md-provider';

const noRoots = () => [] as string[];

describe('createProjectInstructionsProvider（AGENTS.md 项目级指令）', () => {
  it('根下存在 AGENTS.md → 注入贡献块', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'loomery-agents-'));
    await writeFile(join(ws, 'AGENTS.md'), '# 团队约定\n- 提交信息用中文', 'utf8');
    const p = createProjectInstructionsProvider(() => [ws]);
    const chunk = await p.provide({ threadId: 't1', mode: 'edit' });
    expect(chunk).not.toBeNull();
    expect(chunk!.text).toContain('AGENTS.md');
    expect(chunk!.text).toContain('提交信息用中文');
    expect(chunk!.tokens).toBeGreaterThan(0);
    await rm(ws, { recursive: true, force: true });
  });

  it('无文件/空文件 → null（正常空态）', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'loomery-agents-'));
    const p1 = createProjectInstructionsProvider(() => [ws]);
    expect(await p1.provide({ threadId: 't1', mode: 'edit' })).toBeNull();
    await writeFile(join(ws, 'AGENTS.md'), '   \n  ', 'utf8');
    expect(await p1.provide({ threadId: 't1', mode: 'edit' })).toBeNull();
    await rm(ws, { recursive: true, force: true });
  });

  it('超 8KB → 截断保护', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'loomery-agents-'));
    await writeFile(join(ws, 'AGENTS.md'), 'x'.repeat(9000), 'utf8');
    const p = createProjectInstructionsProvider(() => [ws]);
    const chunk = await p.provide({ threadId: 't1', mode: 'edit' });
    expect(chunk!.text.length).toBeLessThan(8600);
    expect(chunk!.text).toContain('已截断');
    await rm(ws, { recursive: true, force: true });
  });

  it('线程根优先于回退根（多项目归域）', async () => {
    const threadRoot = await mkdtemp(join(tmpdir(), 'loomery-agents-t-'));
    const globalRoot = await mkdtemp(join(tmpdir(), 'loomery-agents-g-'));
    await writeFile(join(threadRoot, 'AGENTS.md'), '线程根约定', 'utf8');
    await writeFile(join(globalRoot, 'AGENTS.md'), '全局根约定', 'utf8');
    const p = createProjectInstructionsProvider((ctx) =>
      ctx.workspaceRoots && ctx.workspaceRoots.length > 0 ? ctx.workspaceRoots : [globalRoot],
    );
    const viaThread = await p.provide({ threadId: 't1', mode: 'edit', workspaceRoots: [threadRoot] });
    expect(viaThread!.text).toContain('线程根约定');
    const viaFallback = await p.provide({ threadId: 't1', mode: 'edit' });
    expect(viaFallback!.text).toContain('全局根约定');
    await rm(threadRoot, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
  });

  it('无根可用 → null', async () => {
    const p = createProjectInstructionsProvider(noRoots);
    expect(await p.provide({ threadId: 't1', mode: 'edit' })).toBeNull();
  });
});

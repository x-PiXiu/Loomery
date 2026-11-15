import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonConfigStore, JsonMemoryStore, createDefaultConfig } from './index';
import type { LoopEvent } from '@loomery/domain';

let root = '';
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const ev = (threadId: string, seq: number, type: 'threadCreated' | 'turnStarted', extra?: Partial<LoopEvent>) =>
  ({
    seq,
    id: `e${seq}`,
    schemaVersion: 1 as const,
    ts: 1000 + seq,
    threadId,
    ...(type === 'turnStarted' ? { turnId: 'u1' } : {}),
    type,
    ...(type === 'threadCreated'
      ? { payload: { threadId, title: `标题${seq}` } }
      : { payload: { turnId: 'u1', mode: 'edit', model: 'm', userMessageId: 'x' } }),
    ...extra,
  }) as LoopEvent;

describe('JsonMemoryStore（ADR-0008 事件溯源）', () => {
  it('事件追加与按线程加载', async () => {
    root = await mkdtemp(join(tmpdir(), 'loomery-ms-'));
    const store = new JsonMemoryStore(root);
    await store.appendEvent('t1', ev('t1', 1, 'threadCreated'));
    await store.appendEvent('t1', ev('t1', 2, 'turnStarted'));
    await store.appendEvent('t2', ev('t2', 1, 'threadCreated'));
    expect(await store.loadEvents('t1')).toHaveLength(2);
    expect(await store.loadEvents('t2')).toHaveLength(1);
    expect((await store.readRawEvents('t1'))).toHaveLength(2);
  });

  it('listThreads 从 threadCreated 事件重建元数据', async () => {
    root = await mkdtemp(join(tmpdir(), 'loomery-ms-'));
    const store = new JsonMemoryStore(root);
    await store.appendEvent('t1', ev('t1', 1, 'threadCreated'));
    await store.appendEvent('t1', ev('t1', 2, 'turnStarted'));
    const threads = await store.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: 't1', title: '标题1', turnIds: ['u1'] });
  });

  it('长期记忆：保存/去重/查询', async () => {
    root = await mkdtemp(join(tmpdir(), 'loomery-ms-'));
    const store = new JsonMemoryStore(root);
    await store.saveFact({ id: 'f1', kind: 'preference', content: '用户偏好 TypeScript', createdAt: 1, source: 'extracted' });
    await store.saveFact({ id: 'f2', kind: 'preference', content: '用户偏好 TypeScript', createdAt: 2, source: 'extracted' }); // 同内容去重
    await store.saveFact({ id: 'f3', kind: 'convention', content: '本项目使用 pnpm', createdAt: 3, source: 'extracted' });
    const q = await store.queryFacts('TypeScript', 5);
    expect(q).toHaveLength(2); // f1 + f3（f3 时间倒序补足）
    expect(q[0]?.content).toContain('TypeScript');
  });

  it('JsonConfigStore：默认值 + 浅合并持久化', async () => {
    root = await mkdtemp(join(tmpdir(), 'loomery-ms-'));
    const file = join(root, 'config.json');
    const store = new JsonConfigStore(file);
    const loaded = await store.load();
    expect(loaded).toEqual(createDefaultConfig());
    expect(loaded.limits.maxSteps).toBe(100);

    await store.save({ limits: { ...loaded.limits, maxSteps: 50 } });
    const reloaded = await store.load();
    expect(reloaded.limits.maxSteps).toBe(50);
    expect(reloaded.limits.maxTurnTokens).toBe(50_000_000); // 未触碰字段保留默认（2026-11-13 用户定稿 5000 万）
    expect(reloaded.approval.write).toBe('ask');
  });
});

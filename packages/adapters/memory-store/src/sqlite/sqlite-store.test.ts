// SqliteMemoryStore 测试 + ADR-0023 双路径重放校验（同一事件流 JSON vs SQLite 逐字段一致）
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LoopEvent, MemoryFact } from '@loomery/domain';
import { ContentAddressedArtifactStore, JsonMemoryStore, SqliteMemoryStore, sqliteArtifactIndex } from '..';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const mkRoot = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'loomery-sqlite-'));
  dirs.push(d);
  return d;
};

let seqN = 0;
let idN = 0;
const ev = (type: string, threadId: string, payload: Record<string, unknown>, extra?: { turnId?: string; step?: number }): LoopEvent => {
  seqN += 1;
  idN += 1;
  return { seq: seqN, id: `ev${idN}`, schemaVersion: 1, ts: 1700000000000 + seqN * 1000, threadId, type, payload, ...extra } as unknown as LoopEvent;
};

/** 两轮会话的规范事件流：标题改名/用量/turnIds/workspaceRoot/记忆全都有 */
function buildStream(threadId: string): LoopEvent[] {
  seqN = 0;
  idN = 0;
  return [
    ev('threadCreated', threadId, { threadId, title: '初始标题', workspaceRoot: 'E:/ws/a' }),
    ev('turnStarted', threadId, { turnId: 'u1', mode: 'edit', model: 'm', userMessageId: 'mu1', userText: '第一轮' }, { turnId: 'u1' }),
    ev('textDelta', threadId, { messageId: 'ma1', text: '回复一' }, { turnId: 'u1' }),
    ev('usageDelta', threadId, { inputTokens: 100, outputTokens: 50 }, { turnId: 'u1' }),
    ev('turnCompleted', threadId, { outcome: 'completed' }, { turnId: 'u1' }),
    ev('threadTitleChanged', threadId, { threadId, title: '改名后的标题' }),
    ev('turnStarted', threadId, { turnId: 'u2', mode: 'edit', model: 'm', userMessageId: 'mu2', userText: '第二轮' }, { turnId: 'u2' }),
    ev('usageDelta', threadId, { inputTokens: 200, outputTokens: 25 }, { turnId: 'u2' }),
    ev('memoryPinned', threadId, { fact: { id: 'f1', kind: 'fact', content: '钉住的事实', createdAt: 1, source: 'user-pinned' } }),
    ev('memoryExtracted', threadId, { facts: [{ id: 'f2', kind: 'convention', content: '约定一条', createdAt: 2, source: 'extracted', scope: 'task' }] }, { turnId: 'u2' }),
    ev('checkpointCreated', threadId, { turnId: 'u2', files: ['a.ts'] }, { turnId: 'u2' }),
    ev('turnCompleted', threadId, { outcome: 'completed' }, { turnId: 'u2' }),
    ev('threadMoved', threadId, { threadId, workspaceRoot: 'E:/ws/b' }),
  ];
}

const fact = (id: string, content: string, createdAt: number): MemoryFact => ({ id, kind: 'fact', content, createdAt, source: 'extracted' });

describe('SqliteMemoryStore（ADR-0023）', () => {
  it('append→loadEvents 序列与可选字段保真', async () => {
    const root = await mkRoot();
    const store = new SqliteMemoryStore(root);
    const stream = buildStream('t1');
    for (const e of stream) await store.appendEvent('t1', e);
    const loaded = await store.loadEvents('t1');
    expect(loaded).toEqual(stream);
  });

  it('listThreads 折叠：标题后到者胜/用量求和/turnIds 去重/workspaceRoot 后到者胜', async () => {
    const root = await mkRoot();
    const store = new SqliteMemoryStore(root);
    for (const e of buildStream('t1')) await store.appendEvent('t1', e);
    const rows = await store.listThreads();
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.title).toBe('改名后的标题');
    expect(r.usageTokens).toBe(375);
    expect(r.turnIds).toEqual(['u1', 'u2']);
    expect(r.workspaceRoot).toBe('E:/ws/b');
    expect(r.createdAt).toBeGreaterThan(0);
  });

  it('rewriteEvents（存储 GC）：保留子集生效，元数据与保留集折叠一致', async () => {
    const root = await mkRoot();
    const store = new SqliteMemoryStore(root);
    const stream = buildStream('t1');
    for (const e of stream) await store.appendEvent('t1', e);
    // 保留：threadCreated/改名/usage/turn2/pinned（丢弃轮1的生成事件）
    const kept = stream.filter((e) => !(e.type === 'textDelta' || (e.type === 'turnStarted' && (e.payload as { turnId: string }).turnId === 'u1') || (e.type === 'turnCompleted' && e.turnId === 'u1')));
    await store.rewriteEvents('t1', kept);
    expect(await store.loadEvents('t1')).toEqual(kept);
    const r = (await store.listThreads())[0]!;
    expect(r.turnIds).toEqual(['u2']); // 轮1被 GC，turnIds 折叠同步收缩
    expect(r.usageTokens).toBe(375); // usageDelta 全保留
    expect(r.title).toBe('改名后的标题');
  });

  it('uuid 幂等：重复 append 不产生重复事件也不重复折叠用量', async () => {
    const root = await mkRoot();
    const store = new SqliteMemoryStore(root);
    const e = ev('usageDelta', 't1', { inputTokens: 10, outputTokens: 5 });
    await store.appendEvent('t1', e);
    await store.appendEvent('t1', e); // 同 id 重复
    expect(await store.loadEvents('t1')).toHaveLength(1);
    expect((await store.listThreads())[0]?.usageTokens).toBe(15); // 只算一次
  });

  it('deleteThread 清事件与元数据', async () => {
    const root = await mkRoot();
    const store = new SqliteMemoryStore(root);
    for (const e of buildStream('t1')) await store.appendEvent('t1', e);
    await store.deleteThread('t1');
    expect(await store.loadEvents('t1')).toEqual([]);
    expect(await store.listThreads()).toEqual([]);
  });

  it('saveFact：id upsert + 同内容去重；queryFacts 相关性排序与 JsonFacts 同语义', async () => {
    const root = await mkRoot();
    const store = new SqliteMemoryStore(root);
    await store.saveFact(fact('f1', '使用 pnpm 管理', 100));
    await store.saveFact(fact('f2', '禁用 any', 200));
    await store.saveFact(fact('f1', '使用 pnpm 管理（更新）', 150)); // id 冲突 → 替换
    await store.saveFact(fact('f3', '禁用 any', 300)); // 同内容 → 跳过
    const all = await store.queryFacts('', 10);
    expect(all.map((f) => f.id).sort()).toEqual(['f1', 'f2']);
    expect(all.find((f) => f.id === 'f1')?.content).toContain('更新');
    const hit = await store.queryFacts('ANY', 10);
    expect(hit[0]?.id).toEqual('f2'); // 大小写不敏感包含，匹配者排最前
    expect(hit.map((f) => f.id)).toContain('f1'); // 其余按时间倒序补足（JsonFacts 同语义）
  });

  it('queryTaskFacts：事件折叠读模型（pinned 优先/unpinned 置 superseded）', async () => {
    const root = await mkRoot();
    const store = new SqliteMemoryStore(root);
    for (const e of buildStream('t1')) await store.appendEvent('t1', e);
    const facts = await store.queryTaskFacts('t1', '', 10);
    expect(facts[0]?.id).toBe('f1'); // pinned 恒排最前
    expect(facts.map((f) => f.id)).toContain('f2');
  });

  it('JSONL→SQLite 导入：残行/重复跳过，文件归档 sessions-imported，标记防重导', async () => {
    const root = await mkRoot();
    const sessions = join(root, 'sessions');
    await mkdir(sessions, { recursive: true });
    const line = (seq: number, id: string, text: string): string =>
      JSON.stringify({ seq, id, schemaVersion: 1, ts: seq * 1000, threadId: 't1', type: 'textDelta', payload: { messageId: `m${seq}`, text } });
    await writeFile(join(sessions, 't1.jsonl'), [line(1, 'a', '好的'), 'not-json', line(2, 'b', '继续'), line(2, 'b', '继续')].join('\n') + '\n', 'utf8');
    const store = new SqliteMemoryStore(root);
    await store.init();
    const loaded = await store.loadEvents('t1');
    expect(loaded).toHaveLength(2);
    expect((await store.listThreads())[0]?.id).toBe('t1');
    // 归档：原文件已移走
    expect(existsSync(join(sessions, 't1.jsonl'))).toBe(false);
    expect(existsSync(join(root, 'sessions-imported', 't1.jsonl'))).toBe(true);
    // 导入后可继续 append（seq 续接不冲突——新事件 id 唯一）
    await store.appendEvent('t1', ev('threadTitleChanged', 't1', { threadId: 't1', title: '导入后改名' }));
    expect((await store.listThreads())[0]?.title).toBe('导入后改名');
    // 二次 init：标记生效，放进去的新文件也不导（防重导语义）
    await writeFile(join(sessions, 't2.jsonl'), line(1, 'z', 'late') + '\n', 'utf8');
    const store2 = new SqliteMemoryStore(root); // 新实例共享同一 DB
    await store2.init();
    expect(await store2.loadEvents('t2')).toEqual([]);
    expect(existsSync(join(sessions, 't2.jsonl'))).toBe(true); // 未被消费
  });

  it('双路径重放校验（ADR-0023）：同一事件流 JSON 与 SQLite 逐字段一致（含 GC 后）', async () => {
    const jsonRoot = await mkRoot();
    const sqliteRoot = await mkRoot();
    const json = new JsonMemoryStore(jsonRoot);
    const lite = new SqliteMemoryStore(sqliteRoot);
    const stream = buildStream('t1');
    for (const e of stream) {
      await json.appendEvent('t1', e);
      await lite.appendEvent('t1', e);
    }
    // 全量重放等价
    expect(await lite.loadEvents('t1')).toEqual(await json.loadEvents('t1'));
    expect(await lite.listThreads()).toEqual(await json.listThreads());
    // GC 后仍等价
    const kept = stream.filter((e) => e.type !== 'textDelta' && e.turnId !== 'u1');
    await json.rewriteEvents?.('t1', kept);
    await lite.rewriteEvents('t1', kept);
    expect(await lite.loadEvents('t1')).toEqual(await json.loadEvents('t1'));
    expect(await lite.listThreads()).toEqual(await json.listThreads());
    // 删除后等价
    await json.deleteThread('t1');
    await lite.deleteThread('t1');
    expect(await lite.listThreads()).toEqual(await json.listThreads());
  });

  it('旧 facts.json 一次性迁入：表空才导、文件保留原地、二次启动不重复', async () => {
    const root = await mkRoot();
    await mkdir(join(root, 'memory'), { recursive: true });
    await writeFile(join(root, 'memory', 'facts.json'), JSON.stringify([
      fact('g1', '回答用中文', 100),
      fact('g2', '偏好深色主题', 200),
    ]), 'utf8');
    const store = new SqliteMemoryStore(root);
    await store.init();
    expect((await store.queryFacts('', 10)).map((f) => f.id).sort()).toEqual(['g1', 'g2']);
    expect(existsSync(join(root, 'memory', 'facts.json'))).toBe(true); // 文件保留（JSON 引擎回退时仍可用）
    // 新实例二次 init：表非空 → 不重复导入
    const store2 = new SqliteMemoryStore(root);
    await store2.init();
    expect((await store2.queryFacts('', 10)).map((f) => f.id).sort()).toEqual(['g1', 'g2']);
  });

  it('产物索引后端：roundtrip + 集成 ContentAddressedArtifactStore', async () => {
    const root = await mkRoot();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(root, 'loomery.db'));
    db.exec(`CREATE TABLE IF NOT EXISTS artifact_index (
      hash TEXT PRIMARY KEY, kind TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
      threadId TEXT NOT NULL, turnId TEXT, createdAt INTEGER NOT NULL);`);
    const store = new ContentAddressedArtifactStore(join(root, 'artifacts'), 20000, 256 * 1024 * 1024, sqliteArtifactIndex(db));
    const ref = await store.put('产物内容'.repeat(100), { threadId: 't1', kind: 'tool-output', summary: '摘要' });
    const list = await store.list('t1');
    expect(list).toHaveLength(1);
    expect(list[0]?.hash).toBe(ref.hash);
    const page = await store.get(ref.hash, 0);
    expect(page.length).toBeGreaterThan(0);
    // deleteThread：无其他引用 → blob 清理 + 索引项移除
    await store.deleteThread('t1');
    expect(await store.list('t1')).toEqual([]);
  });
});

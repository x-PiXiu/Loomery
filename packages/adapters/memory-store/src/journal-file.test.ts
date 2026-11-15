// JsonJournal 容错与重写测试（#1 残行容错 / #3 存储 GC 的适配器层）
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonJournal, parseJournalLines } from './json/journal-file';
import type { LoopEvent } from '@loomery/domain';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const mk = async (): Promise<{ journal: JsonJournal; dir: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'loomery-journal-'));
  dirs.push(dir);
  return { journal: new JsonJournal(dir), dir };
};

const line = (seq: number, id: string, text: string): string =>
  JSON.stringify({ seq, id, schemaVersion: 1, ts: seq * 1000, threadId: 't1', type: 'textDelta', payload: { messageId: `m${seq}`, text } });

describe('parseJournalLines（残行容错）', () => {
  it('跳过残缺行与重复行，主体完整可读', () => {
    const text = [
      line(1, 'a', '好的'),
      'not-json-at-all', // 中段损坏
      line(2, 'b', '继续'),
      '{"seq":3,"id":"c","type":"tur', // 尾部残行（崩溃残留）
      line(2, 'b', '继续'), // uuid 重复（重写竞态残留）
      '',
    ].join('\n');
    const { events, corrupted, duplicates } = parseJournalLines(text);
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e.payload as { text: string }).text)).toEqual(['好的', '继续']);
    expect(corrupted).toBe(2);
    expect(duplicates).toBe(1);
  });

  it('空文本与纯空行直通', () => {
    expect(parseJournalLines('')).toEqual({ events: [], corrupted: 0, duplicates: 0 });
    expect(parseJournalLines('\n\n')).toEqual({ events: [], corrupted: 0, duplicates: 0 });
  });

  it('信封缺 type/threadId 视为残缺', () => {
    const { events, corrupted } = parseJournalLines(JSON.stringify({ seq: 1, id: 'x', foo: 1 }));
    expect(events).toHaveLength(0);
    expect(corrupted).toBe(1);
  });

  it('迁移边界：旧版本信封经默认链透传（当前 v1 无步骤），未来版本不抛错', () => {
    const v1 = JSON.stringify({ seq: 1, id: 'a', schemaVersion: 1, ts: 1, threadId: 't1', type: 'textDelta', payload: { text: 'x' } });
    const v99 = JSON.stringify({ seq: 2, id: 'b', schemaVersion: 99, ts: 2, threadId: 't1', type: 'future', payload: {} });
    const { events, corrupted } = parseJournalLines([v1, v99].join('\n'));
    expect(corrupted).toBe(0);
    expect(events).toHaveLength(2);
    expect(events[0]?.schemaVersion).toBe(1);
    expect(events[1]?.schemaVersion).toBe(99); // 保守透传
  });
});

describe('JsonJournal（load/rewrite）', () => {
  it('load 容错：文件含残行时返回其余事件而非抛错', async () => {
    const { journal, dir } = await mk();
    await writeFile(join(dir, 't1.jsonl'), [line(1, 'a', 'ok'), '{"broken'].join('\n'), 'utf8');
    const events = await journal.load('t1');
    expect(events).toHaveLength(1);
    expect(await journal.load('missing')).toEqual([]);
  });

  it('rewrite 原子替换：load 读到重写后的事件流', async () => {
    const { journal, dir } = await mk();
    const e = (s: string): LoopEvent => JSON.parse(line(1, s, 'x')) as LoopEvent;
    await journal.append('t1', e('a'));
    await journal.append('t1', e('b'));
    await journal.rewrite('t1', [e('c')]);
    const events = await journal.load('t1');
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe('c');
    // 临时文件不残留
    const raw = await readFile(join(dir, 't1.jsonl'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    await expect(readFile(join(dir, 't1.jsonl.tmp'), 'utf8')).rejects.toThrow();
  });
});

// ADR-0021/0022 四仓库测试：FileBriefStore / ContentAddressedArtifactStore / FsSkillRegistry / TaskFactReadModel
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBriefStore } from './brief-file';
import { ContentAddressedArtifactStore } from './artifact-store';
import { FsSkillRegistry } from './skill-registry';
import { TaskFactReadModel } from './task-facts';
import { JsonJournal } from './json/journal-file';
import type { LoopEvent } from '@loomery/domain';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loomery-ms-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FileBriefStore（文件为主，ADR-0021）', () => {
  it('write 落 md 文件且 rev 递增；同内容重写不递增', async () => {
    const store = new FileBriefStore(join(dir, 'tasks'));
    const b1 = await store.write('t1', '# 目标\n重构 X', 'agent');
    expect(b1.rev).toBe(1);
    expect(existsSync(join(dir, 'tasks', 't1.md'))).toBe(true);
    const b2 = await store.write('t1', '# 目标\n重构 X\n约束：不动 API', 'agent');
    expect(b2.rev).toBe(2);
    const b3 = await store.write('t1', '# 目标\n重构 X\n约束：不动 API', 'user');
    expect(b3.rev).toBe(2); // 同内容 hash 未变
  });
  it('read 现值（人类手编内容直接生效）', async () => {
    const tasks = join(dir, 'tasks');
    const store = new FileBriefStore(tasks);
    await store.write('t1', 'v1', 'agent');
    writeFileSync(join(tasks, 't1.md'), '人类手编的内容', 'utf8');
    const b = await store.read('t1');
    expect(b?.content).toBe('人类手编的内容');
    expect(await store.read('t-none')).toBeNull();
  });
});

describe('ContentAddressedArtifactStore（内容寻址，ADR-0021）', () => {
  it('put 落 blob+index，同内容幂等；get 分页取回', async () => {
    const store = new ContentAddressedArtifactStore(join(dir, 'artifacts'), 10);
    const big = '0123456789'.repeat(5); // 50 chars
    const r1 = await store.put(big, { threadId: 't1', kind: 'tool-output', summary: '大输出' });
    expect(r1.hash).toHaveLength(16);
    expect(r1.size).toBe(50);
    const r2 = await store.put(big, { threadId: 't1', kind: 'tool-output', summary: '同内容' });
    expect(r2.hash).toBe(r1.hash);
    const page1 = await store.get(r1.hash);
    expect(page1).toHaveLength(10);
    const page2 = await store.get(r1.hash, 40);
    expect(page2).toHaveLength(10);
    expect(await store.get('nonexistent')).toBe('');
  });
  it('list 按 threadId 过滤', async () => {
    const store = new ContentAddressedArtifactStore(join(dir, 'artifacts'));
    await store.put('a', { threadId: 't1', kind: 'plan', summary: 'a' });
    await store.put('b', { threadId: 't2', kind: 'report', summary: 'b' });
    const l = await store.list('t1');
    expect(l).toHaveLength(1);
    expect(l[0]!.summary).toBe('a');
  });
});

describe('FsSkillRegistry（双作用域，ADR-0022）', () => {
  it('扫描 frontmatter 并按 name 命中读取 body', async () => {
    const user = join(dir, 'skills');
    const project = join(dir, 'ws', '.loomery', 'skills');
    mkdirSync(join(user, 'release'), { recursive: true });
    writeFileSync(join(user, 'release', 'SKILL.md'), '---\nname: 发版流程\ndescription: 每次 release 的步骤\n---\n1. 跑测试\n2. 打标签', 'utf8');
    mkdirSync(join(project, 'commit-rule'), { recursive: true });
    writeFileSync(join(project, 'commit-rule', 'SKILL.md'), '---\nname: commit-rule\ndescription: 本仓库提交规范\n---\n conventional commits', 'utf8');
    const reg = new FsSkillRegistry(user, project);
    const all = await reg.scan();
    expect(all).toHaveLength(2);
    expect(all.find((s) => s.scope === 'project')?.name).toBe('commit-rule');
    const body = await reg.readBody('发版流程');
    expect(body).toContain('跑测试');
    await expect(reg.readBody('不存在')).rejects.toThrow(/不存在/);
  });

  it('技能附件：listFiles 清单 + readAttachment 读原文 + 逃逸拒绝', async () => {
    const user = join(dir, 'skills2');
    mkdirSync(join(user, 'handbook', 'references'), { recursive: true });
    writeFileSync(join(user, 'handbook', 'SKILL.md'), '---\nname: handbook\ndescription: 手册\n---\n详见 references/ch1.md', 'utf8');
    writeFileSync(join(user, 'handbook', 'references', 'ch1.md'), '第一章正文', 'utf8');
    const reg = new FsSkillRegistry(user);
    // 附件清单（SKILL.md 除外）
    expect(await reg.listFiles!('handbook')).toEqual(['references/ch1.md']);
    // 读原文
    expect(await reg.readAttachment!('handbook', 'references/ch1.md')).toBe('第一章正文');
    // 逃逸拒绝
    await expect(reg.readAttachment!('handbook', '../../escape.md')).rejects.toThrow(/越界/);
    await expect(reg.readAttachment!('handbook', '不存在.md')).rejects.toThrow(/不存在/);
  });
});

describe('TaskFactReadModel（事件折叠读模型，ADR-0021）', () => {
  it('从 memoryPinned/Extracted/Unpinned 折叠；落 json 读模型；unpin 置 superseded', async () => {
    const sessions = join(dir, 'sessions');
    const journal = new JsonJournal(sessions);
    const rm = new TaskFactReadModel({ loadEvents: (tid) => journal.load(tid) }, join(dir, 'tasks'));
    const now = Date.now();
    const evs: LoopEvent[] = [
      { seq: 1, id: 'e1', schemaVersion: 1, ts: now, threadId: 't1', type: 'memoryPinned', payload: { fact: { id: 'f1', kind: 'fact', content: '必须用 pnpm', createdAt: now, source: 'user-pinned' } } },
      { seq: 2, id: 'e2', schemaVersion: 1, ts: now + 1, threadId: 't1', type: 'memoryExtracted', payload: { facts: [{ id: 'f2', kind: 'convention', content: '本项目禁用 any', createdAt: now + 1, source: 'extracted' }] } },
    ];
    for (const e of evs) await journal.append('t1', e);
    let facts = await rm.rebuild('t1');
    expect(facts).toHaveLength(2);
    expect(existsSync(join(dir, 'tasks', 't1.json'))).toBe(true);
    expect((await rm.query('t1', '', 10))[0]!.source).toBe('user-pinned'); // pinned 恒排最前
    await journal.append('t1', { seq: 3, id: 'e3', schemaVersion: 1, ts: now + 2, threadId: 't1', type: 'memoryUnpinned', payload: { factId: 'f1' } });
    facts = await rm.rebuild('t1');
    expect(facts.find((f) => f.id === 'f1')?.status).toBe('superseded');
    expect(await rm.query('t1', '', 10)).toHaveLength(1); // superseded 不出查询
  });

  it('显式 global 的事实不进任务读模型（校验轮修复，ADR-0021）', async () => {
    const sessions2 = join(dir, 'sessions2');
    const journal2 = new JsonJournal(sessions2);
    const rm2 = new TaskFactReadModel({ loadEvents: (tid) => journal2.load(tid) }, join(dir, 'tasks2'));
    const now = Date.now();
    await journal2.append('t9', { seq: 1, id: 'e1', schemaVersion: 1, ts: now, threadId: 't9', type: 'memoryExtracted', payload: { facts: [
      { id: 'g1', kind: 'preference', content: '回答用中文', createdAt: now, source: 'extracted', scope: 'global' },
      { id: 'k1', kind: 'fact', content: '入口在 main.ts', createdAt: now, source: 'extracted' },
    ] } });
    const facts = await rm2.rebuild('t9');
    expect(facts.map((f) => f.id)).toEqual(['k1']);
  });

  it('LRU 封顶：超限按最旧逐出，新写入保留（ADR-0021）', async () => {
    const store = new ContentAddressedArtifactStore(join(dir, 'artifacts-lru'), 20_000, 250); // 上限 300 字节
    await store.put('A'.repeat(100), { threadId: 't1', kind: 'tool-output', summary: '旧1' });
    await new Promise((r) => setTimeout(r, 5));
    await store.put('B'.repeat(100), { threadId: 't1', kind: 'tool-output', summary: '旧2' });
    await new Promise((r) => setTimeout(r, 5));
    await store.put('C'.repeat(100), { threadId: 't1', kind: 'tool-output', summary: '新' });
    const after = await store.list('t1');
    expect(after.some((r) => r.summary === '新')).toBe(true);
    // 总量 300 > 上限 250：最旧的被逐出，其余保留
    expect(after.length).toBe(2);
    expect(after.some((r) => r.summary === '旧1')).toBe(false); // 最旧先逐出
    expect(after.some((r) => r.summary === '新')).toBe(true);
  });

});

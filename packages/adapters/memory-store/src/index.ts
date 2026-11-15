// MemoryStore JSON 实现（P1）：sessions/<threadId>.jsonl + memory/facts.json（11 §3 运行时目录）
// P2 以 SQLite 实现替换本包，端口不变（ADR-0003）
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LoopEvent, MemoryFact, Thread } from '@loomery/domain';
import type { MemoryStore } from '@loomery/ports';
import { JsonFacts } from './json/facts-file';
import { JsonJournal } from './json/journal-file';
import { FileBriefStore } from './brief-file';
import { ContentAddressedArtifactStore } from './artifact-store';
import { FsSkillRegistry } from './skill-registry';
import { TaskFactReadModel } from './task-facts';

export { JsonConfigStore, createDefaultConfig } from './json/config-file';
export { FileBriefStore } from './brief-file';
export { ContentAddressedArtifactStore, type ArtifactIndexBackend, type ArtifactIndexEntry } from './artifact-store';
export { FsSkillRegistry } from './skill-registry';
export { TaskFactReadModel } from './task-facts';
export { SkillConfirmStore } from './skill-confirm';
export { JsonJournal } from './json/journal-file';
export { JsonFacts } from './json/facts-file';
export { SqliteMemoryStore, sqliteArtifactIndex, importArtifactIndexFromFile } from './sqlite/sqlite-store';

export class JsonMemoryStore implements MemoryStore {
  private readonly journal: JsonJournal;
  private readonly facts: JsonFacts;

  private readonly taskFacts: TaskFactReadModel;

  constructor(
    /** userData 根目录（sessions/ 与 memory/ 的父目录） */
    private readonly rootDir: string,
    /** 项目级技能目录 <ws>/.loomery/skills（可选，ADR-0022） */
    private readonly projectSkillsDir?: string,
  ) {
    this.journal = new JsonJournal(join(rootDir, 'sessions'));
    this.facts = new JsonFacts(join(rootDir, 'memory', 'facts.json'));
    const tasksDir = join(rootDir, 'memory', 'tasks');
    const sigOf = async (threadId: string): Promise<string> => {
      const p = join(this.journal.dir, `${threadId}.jsonl`);
      if (!existsSync(p)) return '0';
      const s = await stat(p);
      return `${s.size}:${s.mtimeMs}`;
    };
    this.taskFacts = new TaskFactReadModel({ loadEvents: (tid) => this.journal.load(tid) }, tasksDir, sigOf);
  }

  /** 任务级技能扫描器（SkillRegistry 端口实现之一，bootstrap 亦可为 skills 模块单建） */
  skillRegistry(): FsSkillRegistry {
    return new FsSkillRegistry(join(this.rootDir, 'skills'), this.projectSkillsDir);
  }

  briefStore(): FileBriefStore {
    return new FileBriefStore(join(this.rootDir, 'memory', 'tasks'));
  }

  artifactStore(): ContentAddressedArtifactStore {
    return new ContentAddressedArtifactStore(join(this.rootDir, 'artifacts'));
  }

  /** ADR-0021：任务级条目记忆查询（事件溯源读模型）；pinned 恒排最前 */
  async queryTaskFacts(threadId: string, query: string, limit: number): Promise<MemoryFact[]> {
    return this.taskFacts.query(threadId, query, limit);
  }

  async appendEvent(threadId: string, event: LoopEvent): Promise<void> {
    await this.journal.append(threadId, event);
  }

  async loadEvents(threadId: string): Promise<LoopEvent[]> {
    return this.journal.load(threadId);
  }

  /** 存储 GC：原子替换为重放等价事件流（等价流由内核 compactForStorage 计算，这里只落盘） */
  async rewriteEvents(threadId: string, events: LoopEvent[]): Promise<void> {
    await this.journal.rewrite(threadId, events);
  }

  async deleteThread(threadId: string): Promise<void> {
    // ADR-0021 任务删除 GC：任务记忆读模型 + 简报 + 产物（事件日志由 JSONL 本体处理）
    await this.taskFacts.deleteThread(threadId);
    await this.briefStore().deleteThread(threadId);
    await this.artifactStore().deleteThread(threadId);
    await this.journal.remove(threadId);
  }

  async saveFact(fact: MemoryFact): Promise<void> {
    // ADR-0021：任务级事实由 memoryExtracted 事件承载（读模型=事件折叠），全局事实落 facts.json
    if (fact.scope === 'task') return;
    await this.facts.save(fact);
  }

  async queryFacts(query: string, limit: number): Promise<MemoryFact[]> {
    return this.facts.query(query, limit);
  }

  async listThreads(): Promise<Thread[]> {
    const dir = join(this.rootDir, 'sessions');
    if (!existsSync(dir)) return [];
    const threads: Thread[] = [];
    for (const name of (await readdir(dir)).filter((n) => n.endsWith('.jsonl'))) {
      const threadId = name.replace(/\.jsonl$/, '');
      const events = await this.journal.load(threadId);
      const created = events.find((e) => e.type === 'threadCreated');
      // 标题折叠：threadTitleChanged 后到者优先（自动标题/重命名），否则重启后回退"新会话"
      let title = created && created.type === 'threadCreated' ? created.payload.title : threadId;
      let workspaceRoot: string | undefined;
      if (created && created.type === 'threadCreated' && created.payload.workspaceRoot) workspaceRoot = created.payload.workspaceRoot;
      for (const e of events) {
        if (e.type === 'threadTitleChanged' && typeof e.payload.title === 'string' && e.payload.title.length > 0) {
          title = e.payload.title;
        }
        if (e.type === 'threadMoved' && typeof e.payload.workspaceRoot === 'string') {
          workspaceRoot = e.payload.workspaceRoot;
        }
      }
      threads.push({
        id: threadId,
        title,
        turnIds: [...new Set(events.filter((e) => e.turnId).map((e) => e.turnId as string))],
        createdAt: created?.ts ?? 0,
        usageTokens: events.filter((e) => e.type === 'usageDelta').reduce((sum, e) => {
          const p = e.payload as { inputTokens?: number; outputTokens?: number };
          return sum + (p.inputTokens ?? 0) + (p.outputTokens ?? 0);
        }, 0),
        maxSeq: events.reduce((mx, e) => Math.max(mx, e.seq), 0),
        ...(workspaceRoot ? { workspaceRoot } : {}),
      });
    }
    return threads.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 供测试/诊断读取原始事件 */
  async readRawEvents(threadId: string): Promise<string[]> {
    const file = join(this.rootDir, 'sessions', `${threadId}.jsonl`);
    if (!existsSync(file)) return [];
    return (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim().length > 0);
  }
}

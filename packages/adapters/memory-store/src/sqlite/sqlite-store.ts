// SqliteMemoryStore（ADR-0023 已执行）：事件/事实/产物索引三迁入库（node:sqlite，零编译），
// 简报 .md / 技能 SKILL.md / 产物 blob 本体仍留文件（三留，人类可编辑性与 hash 寻址是产品决策）。
// 端口不变（MemoryStore）——内核/UI 零改动；JSONL→SQLite 一次性导入幂等（init()）。
// 折叠语义单一来源：thread_meta 的折叠规则与 JSON 版逐字段同构，由双实现等价性测试锁定。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { migrateEvent, type LoopEvent, type MemoryFact, type Thread } from '@loomery/domain';
import type { MemoryStore } from '@loomery/ports';
import { parseJournalLines } from '../json/journal-file';
import { TaskFactReadModel } from '../task-facts';
import type { ArtifactIndexBackend, ArtifactIndexEntry } from '../artifact-store';

interface MetaRow {
  threadId: string;
  title: string;
  createdAt: number;
  workspaceRoot: string | null;
  usageTokens: number;
  turnIds: string;
  maxSeq: number;
  eventCount: number;
}

/** 单事件对元数据折叠（与 JSON 版 listThreads 折叠逐字段同构） */
function applyEventToMeta(meta: MetaRow, e: LoopEvent): void {
  switch (e.type) {
    case 'threadCreated':
      meta.title = e.payload.title;
      meta.createdAt = e.ts;
      if (typeof e.payload.workspaceRoot === 'string') meta.workspaceRoot = e.payload.workspaceRoot;
      break;
    case 'threadTitleChanged':
      if (typeof e.payload.title === 'string' && e.payload.title.length > 0) meta.title = e.payload.title;
      break;
    case 'threadMoved':
      if (typeof e.payload.workspaceRoot === 'string') meta.workspaceRoot = e.payload.workspaceRoot;
      break;
    case 'usageDelta':
      meta.usageTokens += e.payload.inputTokens + e.payload.outputTokens;
      break;
    case 'turnStarted': {
      const ids: string[] = JSON.parse(meta.turnIds) as string[];
      if (!ids.includes(e.payload.turnId)) ids.push(e.payload.turnId);
      meta.turnIds = JSON.stringify(ids);
      break;
    }
    default:
      break;
  }
  meta.maxSeq = Math.max(meta.maxSeq, e.seq);
  meta.eventCount += 1;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  threadId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  ts INTEGER NOT NULL,
  turnId TEXT,
  step INTEGER,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (threadId, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_id ON events(id);
CREATE TABLE IF NOT EXISTS thread_meta (
  threadId TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  createdAt INTEGER NOT NULL DEFAULT 0,
  workspaceRoot TEXT,
  usageTokens INTEGER NOT NULL DEFAULT 0,
  turnIds TEXT NOT NULL DEFAULT '[]',
  maxSeq INTEGER NOT NULL DEFAULT 0,
  eventCount INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'global',
  threadId TEXT,
  turnId TEXT,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  content TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS artifact_index (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  threadId TEXT NOT NULL,
  turnId TEXT,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export class SqliteMemoryStore implements MemoryStore {
  private readonly db: DatabaseSync;
  private readonly taskFacts: TaskFactReadModel;
  private inited = false;

  // 预编译语句（node:sqlite 同步 API；单写者=主进程，WAL 保障崩溃安全）
  private readonly insEvent;
  private readonly selEvents;
  private readonly selMeta;
  private readonly upsertMeta;
  private readonly insFact;
  private readonly selFactById;
  private readonly selFactByContent;
  private readonly updFact;
  private readonly selFacts;

  constructor(
    /** userData 根目录（导入源 sessions/ 与归档 sessions-imported/ 的定位基准） */
    private readonly rootDir: string,
    opts?: {
      /** 复用已打开的 DB 连接（组合根同时拿去建产物索引后端）；缺省在 rootDir/loomery.db 自开 */
      db?: DatabaseSync;
      /** 项目级技能目录（工厂方法用，ADR-0022） */
      projectSkillsDir?: string;
    },
  ) {
    this.db = opts?.db ?? new DatabaseSync(join(rootDir, 'loomery.db'));
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.db.exec(SCHEMA);
    this.insEvent = this.db.prepare(
      'INSERT OR IGNORE INTO events (threadId, seq, id, schemaVersion, ts, turnId, step, type, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.selEvents = this.db.prepare('SELECT seq, id, schemaVersion, ts, turnId, step, type, payload FROM events WHERE threadId = ? ORDER BY seq ASC');
    this.selMeta = this.db.prepare('SELECT threadId, title, createdAt, workspaceRoot, usageTokens, turnIds, maxSeq, eventCount FROM thread_meta WHERE threadId = ?');
    this.upsertMeta = this.db.prepare(
      `INSERT INTO thread_meta (threadId, title, createdAt, workspaceRoot, usageTokens, turnIds, maxSeq, eventCount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(threadId) DO UPDATE SET title=excluded.title, createdAt=excluded.createdAt, workspaceRoot=excluded.workspaceRoot,
         usageTokens=excluded.usageTokens, turnIds=excluded.turnIds, maxSeq=excluded.maxSeq, eventCount=excluded.eventCount`,
    );
    this.insFact = this.db.prepare(
      'INSERT INTO facts (id, scope, threadId, turnId, kind, source, status, content, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.selFactById = this.db.prepare('SELECT id FROM facts WHERE id = ?');
    this.selFactByContent = this.db.prepare('SELECT id FROM facts WHERE content = ?');
    this.updFact = this.db.prepare(
      'UPDATE facts SET scope=?, threadId=?, turnId=?, kind=?, source=?, status=?, content=?, createdAt=? WHERE id=?',
    );
    this.selFacts = this.db.prepare('SELECT id, scope, threadId, turnId, kind, source, status, content, createdAt FROM facts');
    this.taskFacts = new TaskFactReadModel(
      { loadEvents: (tid) => this.loadEvents(tid) },
      join(rootDir, 'memory', 'tasks'),
      async (tid) => {
        const m = this.selMeta.get(tid) as MetaRow | undefined;
        return m ? `${m.eventCount}:${m.maxSeq}` : '0';
      },
    );
  }

  /** 一次性导入（幂等）：sessions/*.jsonl → events 表；文件归档到 sessions-imported/ 不删除（可回退） */
  async init(): Promise<void> {
    if (this.inited) return;
    this.inited = true;
    if (this.getMetaValue('jsonl_import_done') === '1') return;
    const dir = join(this.rootDir, 'sessions');
    const files = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort() : [];
    const archiveDir = join(this.rootDir, 'sessions-imported');
    let imported = 0;
    let corrupted = 0;
    let duplicates = 0;
    for (const name of files) {
      const threadId = name.replace(/\.jsonl$/, '');
      const text = readFileSync(join(dir, name), 'utf8');
      const { events, corrupted: c, duplicates: d } = parseJournalLines(text);
      corrupted += c;
      duplicates += d;
      this.tx(() => {
        let inserted = 0;
        for (const e of events) {
          // 严格对齐 JsonJournal.load 语义：文件名即任务身份，异线程事件不入库（防串染/主键冲突）
          if (e.threadId !== threadId) continue;
          inserted += this.insertEvent(e);
        }
        imported += inserted;
        this.recomputeMeta(threadId);
      });
      // 归档（不删除——出问题可整体回退到 JSON 引擎）
      mkdirSync(archiveDir, { recursive: true });
      const dest = join(archiveDir, name);
      try {
        rmSync(dest, { force: true });
        renameSync(join(dir, name), dest);
      } catch (err) {
        console.warn(`[store] 归档失败（文件保留原位，靠标记防重导）: ${name}`, err);
      }
    }
    this.setMetaValue('jsonl_import_done', '1');
    if (files.length > 0) {
      console.log(`[store] JSONL→SQLite 导入完成：${files.length} 任务文件 / ${imported} 事件（残行 ${corrupted}、重复 ${duplicates} 跳过）`);
    }
    this.importLegacyFacts();
  }

  /** 一次性导入旧 facts.json（JSON 引擎遗产）：表空且文件存在 → 逐条 saveFact（upsert/内容去重幂等）；文件保留原地 */
  private importLegacyFacts(): void {
    const p = join(this.rootDir, 'memory', 'facts.json');
    if (!existsSync(p)) return;
    const count = Number((this.db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number | bigint }).n);
    if (count > 0) return; // 已有数据（二次启动/新引擎写入过）→ 不覆盖
    try {
      const facts = JSON.parse(readFileSync(p, 'utf8')) as MemoryFact[];
      if (!Array.isArray(facts) || facts.length === 0) return;
      let n = 0;
      for (const f of facts) {
        if (!f || typeof f.id !== 'string' || typeof f.content !== 'string') continue;
        void this.saveFact(f);
        n += 1;
      }
      console.log(`[store] facts.json 迁入 SQLite：${n} 条全局事实`);
    } catch (err) {
      console.warn('[store] facts.json 迁移失败（保留文件版）:', err);
    }
  }

  async appendEvent(threadId: string, event: LoopEvent): Promise<void> {
    this.tx(() => {
      const inserted = this.insertEvent(event);
      if (inserted === 0) return; // uuid 幂等：重复事件不折叠（与 JSON load 去重口径一致）
      const meta = (this.selMeta.get(threadId) as MetaRow | undefined) ?? this.newMeta(threadId);
      applyEventToMeta(meta, event);
      this.writeMeta(meta);
    });
  }

  async loadEvents(threadId: string): Promise<LoopEvent[]> {
    const rows = this.selEvents.all(threadId) as Array<{ seq: number; id: string; schemaVersion: number; ts: number; turnId: string | null; step: number | null; type: string; payload: string }>;
    return rows.map((r) => migrateEvent({
      seq: r.seq,
      id: r.id,
      schemaVersion: r.schemaVersion,
      ts: r.ts,
      threadId,
      ...(r.turnId !== null ? { turnId: r.turnId } : {}),
      ...(r.step !== null ? { step: r.step } : {}),
      type: r.type,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }));
  }

  async deleteThread(threadId: string): Promise<void> {
    this.tx(() => {
      this.db.prepare('DELETE FROM events WHERE threadId = ?').run(threadId);
      this.db.prepare('DELETE FROM thread_meta WHERE threadId = ?').run(threadId);
      // 任务级事实行（全局事实 threadId 为 NULL 不受影响）；JSON 引擎经 saveFact no-op 天然无此数据
      this.db.prepare('DELETE FROM facts WHERE threadId = ?').run(threadId);
    });
    // 任务记忆读模型缓存（memory/tasks/<id>.json，可重建但随删回收——与 JSON 引擎 deleteThread 同语义）
    await this.taskFacts.deleteThread(threadId);
  }

  /** 存储 GC（内核算好等价流）：事务内整表替换该任务事件 + 元数据从保留集重算（与 JSON 重放折叠等价） */
  async rewriteEvents(threadId: string, events: LoopEvent[]): Promise<void> {
    this.tx(() => {
      this.db.prepare('DELETE FROM events WHERE threadId = ?').run(threadId);
      for (const e of events) this.insertEvent(e);
      this.recomputeMeta(threadId);
    });
  }

  async saveFact(fact: MemoryFact): Promise<void> {
    // 与 JsonFacts 同语义：按 id upsert；同内容去重（不重复入库）
    this.tx(() => {
      if ((this.selFactById.get(fact.id) as { id: string } | undefined) !== undefined) {
        this.updFact.run(fact.scope ?? 'global', fact.threadId ?? null, fact.turnId ?? null, fact.kind, fact.source, fact.status ?? 'active', fact.content, fact.createdAt, fact.id);
        return;
      }
      if ((this.selFactByContent.get(fact.content) as { id: string } | undefined) !== undefined) return;
      this.insFact.run(fact.id, fact.scope ?? 'global', fact.threadId ?? null, fact.turnId ?? null, fact.kind, fact.source, fact.status ?? 'active', fact.content, fact.createdAt);
    });
  }

  async queryFacts(query: string, limit: number): Promise<MemoryFact[]> {
    // 行数小（条目记忆百级），JS 过滤保持与 JsonFacts 逐字段同语义（LIKE 的 %_ 通配符陷阱不加进来）；已删除不出结果
    const all = (this.selFacts.all() as Array<{ id: string; scope: string; threadId: string | null; turnId: string | null; kind: string; source: string; status: string; content: string; createdAt: number }>)
      .filter((r) => r.status !== 'superseded')
      .map((r) => this.rowToFact(r));
    const q = query.toLowerCase();
    const matched = all.filter((f) => q.length > 0 && f.content.toLowerCase().includes(q));
    const rest = all.filter((f) => !matched.includes(f)).sort((a, b) => b.createdAt - a.createdAt);
    return [...matched, ...rest].slice(0, limit);
  }

  async queryTaskFacts(threadId: string, query: string, limit: number): Promise<MemoryFact[]> {
    return this.taskFacts.query(threadId, query, limit);
  }

  async listThreads(): Promise<Thread[]> {
    const rows = this.db.prepare('SELECT threadId, title, createdAt, workspaceRoot, usageTokens, turnIds, maxSeq FROM thread_meta').all() as Array<{ threadId: string; title: string; createdAt: number; workspaceRoot: string | null; usageTokens: number; turnIds: string; maxSeq: number }>;
    return rows.map((r) => ({
      id: r.threadId,
      title: r.title || r.threadId,
      turnIds: JSON.parse(r.turnIds) as string[],
      createdAt: r.createdAt,
      usageTokens: r.usageTokens,
      maxSeq: r.maxSeq,
      ...(r.workspaceRoot ? { workspaceRoot: r.workspaceRoot } : {}),
    }));
  }

  // ---- 内部 ----

  private newMeta(threadId: string): MetaRow {
    return { threadId, title: '', createdAt: 0, workspaceRoot: null, usageTokens: 0, turnIds: '[]', maxSeq: 0, eventCount: 0 };
  }

  private writeMeta(meta: MetaRow): void {
    this.upsertMeta.run(meta.threadId, meta.title, meta.createdAt, meta.workspaceRoot, meta.usageTokens, meta.turnIds, meta.maxSeq, meta.eventCount);
  }

  /** 从 DB 现有事件全量重算元数据（导入/重写后调用；等价于 JSON 版对全文件的折叠） */
  private recomputeMeta(threadId: string): void {
    const events = this.loadEventsSync(threadId);
    const meta = this.newMeta(threadId);
    for (const e of events) applyEventToMeta(meta, e);
    this.writeMeta(meta);
  }

  private loadEventsSync(threadId: string): LoopEvent[] {
    const rows = this.selEvents.all(threadId) as Array<{ seq: number; id: string; schemaVersion: number; ts: number; turnId: string | null; step: number | null; type: string; payload: string }>;
    return rows.map((r) => ({
      seq: r.seq,
      id: r.id,
      schemaVersion: r.schemaVersion,
      ts: r.ts,
      threadId,
      ...(r.turnId !== null ? { turnId: r.turnId } : {}),
      ...(r.step !== null ? { step: r.step } : {}),
      type: r.type,
      payload: JSON.parse(r.payload),
    }) as unknown as LoopEvent);
  }

  /** 返回 changes（1=新插入，0=重复被 OR IGNORE 跳过） */
  private insertEvent(e: LoopEvent): number {
    const r = this.insEvent.run(
      e.threadId, e.seq, e.id, e.schemaVersion ?? 1, e.ts,
      e.turnId ?? null, e.step ?? null, e.type, JSON.stringify(e.payload),
    );
    return Number(r.changes);
  }

  private rowToFact(r: { id: string; scope: string; threadId: string | null; turnId: string | null; kind: string; source: string; status: string; content: string; createdAt: number }): MemoryFact {
    return {
      id: r.id,
      kind: r.kind as MemoryFact['kind'],
      content: r.content,
      createdAt: r.createdAt,
      source: r.source as MemoryFact['source'],
      scope: r.scope as MemoryFact['scope'],
      status: r.status as MemoryFact['status'],
      ...(r.threadId ? { threadId: r.threadId } : {}),
      ...(r.turnId ? { turnId: r.turnId } : {}),
    };
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private getMetaValue(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setMetaValue(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
}

/** ADR-0023 三迁：产物索引后端（SQLite 表）；blob 本体仍留文件（hash 寻址） */
export function sqliteArtifactIndex(db: DatabaseSync): ArtifactIndexBackend {
  const sel = db.prepare('SELECT hash, kind, summary, size, threadId, turnId, createdAt FROM artifact_index');
  return {
    async load(): Promise<ArtifactIndexEntry[]> {
      return (sel.all() as unknown as ArtifactIndexEntry[]).map((r) => ({
        hash: r.hash, kind: r.kind, summary: r.summary, size: r.size, threadId: r.threadId,
        ...(r.turnId ? { turnId: r.turnId } : {}), createdAt: r.createdAt,
      }));
    },
    async save(entries: ArtifactIndexEntry[]): Promise<void> {
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM artifact_index');
        const ins = db.prepare('INSERT OR REPLACE INTO artifact_index (hash, kind, summary, size, threadId, turnId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const e of entries) ins.run(e.hash, e.kind, e.summary, e.size, e.threadId, e.turnId ?? null, e.createdAt);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

/** 索引迁移（可选一次性）：文件 index.json → SQLite 表（有文件且表空时执行一次） */
export function importArtifactIndexFromFile(db: DatabaseSync, indexPath: string): void {
  if (!existsSync(indexPath)) return;
  const count = Number((db.prepare('SELECT COUNT(*) AS n FROM artifact_index').get() as { n: number | bigint }).n);
  if (count > 0) return;
  try {
    const entries = JSON.parse(readFileSync(indexPath, 'utf8')) as ArtifactIndexEntry[];
    if (entries.length === 0) return;
    const backend = sqliteArtifactIndex(db);
    void backend.save(entries);
    console.log(`[store] 产物索引迁入 SQLite：${entries.length} 条`);
  } catch (err) {
    console.warn('[store] 产物索引迁移失败（保留文件版）:', err);
  }
}

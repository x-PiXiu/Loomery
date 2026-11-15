// ADR-0021：任务条目记忆读模型——唯一写入者是事件折叠（memoryPinned/Unpinned/Extracted 落日志后由此重建）
// 文件 memory/tasks/<threadId>.json 是可重建缓存，删除无损
// 依赖倒置（ADR-0023 已执行）：只依赖最小读接口 + 签名函数——JSON 与 SQLite 引擎各自注入，折叠语义单一来源
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LoopEvent, MemoryFact } from '@loomery/domain';

export class TaskFactReadModel {
  private readonly cache = new Map<string, { sig: string; facts: MemoryFact[] }>();

  constructor(
    /** 事件读取（JSON=journal.load / SQLite=SQL 查询） */
    private readonly loader: { loadEvents(threadId: string): Promise<LoopEvent[]> },
    private readonly tasksDir: string,
    /** 缓存签名：数据变更时返回不同字符串（JSON=文件 size:mtime / SQLite=事件数:maxSeq）；缺省禁用缓存 */
    private readonly sigOf?: (threadId: string) => Promise<string>,
  ) {}

  private async cacheSig(threadId: string): Promise<string> {
    if (!this.sigOf) return 'nocache:' + Math.random().toString(36).slice(2);
    return this.sigOf(threadId);
  }

  /** 折叠事件 → 任务事实（pinned 与 extracted 合并；unpinned 置 superseded） */
  async rebuild(threadId: string): Promise<MemoryFact[]> {
    const sig = await this.cacheSig(threadId);
    const hit = this.cache.get(threadId);
    if (hit && hit.sig === sig) return hit.facts;
    const events: LoopEvent[] = await this.loader.loadEvents(threadId);
    const facts: MemoryFact[] = [];
    for (const ev of events) {
      if (ev.type === 'memoryExtracted') {
        for (const f of ev.payload.facts) {
          // ADR-0021：显式升全局的事实（preference）归 facts.json 管，不进任务读模型（防双份表示）；
          // 旧 P1 事件无 scope 标记，视为任务级折叠
          if (f.scope === 'global') continue;
          facts.push({ ...f, scope: 'task', threadId, ...(ev.turnId ? { turnId: ev.turnId } : {}), status: 'active' });
        }
      } else if (ev.type === 'memoryPinned') {
        facts.push({ ...ev.payload.fact, scope: 'task', threadId, status: 'active' });
      } else if (ev.type === 'memoryUnpinned') {
        for (const f of facts) {
          if (f.id === ev.payload.factId) f.status = 'superseded';
        }
      }
    }
    // 同内容去重：后到者保留
    const seen = new Set<string>();
    const deduped = facts.filter((f) => {
      if (seen.has(f.content)) return false;
      seen.add(f.content);
      return true;
    });
    this.cache.set(threadId, { sig, facts: deduped });
    // 读模型落盘（确定性 await：文件只是缓存，失败不抛——重建随时可来）
    const out = join(this.tasksDir, `${threadId}.json`);
    try {
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, JSON.stringify(deduped, null, 2), 'utf8');
    } catch {
      /* 读模型写盘失败不影响查询 */
    }
    return deduped;
  }

  /** 任务删除：清理读模型文件与缓存 */
  async deleteThread(threadId: string): Promise<void> {
    this.cache.delete(threadId);
    const out = join(this.tasksDir, threadId + '.json');
    if (existsSync(out)) rmSync(out);
  }

  /** 简单相关性：包含查询词者优先（pinned 恒排最前），按时间倒序补足；空查询=全量 */
  async query(threadId: string, query: string, limit: number): Promise<MemoryFact[]> {
    const all = (await this.rebuild(threadId)).filter((f) => f.status !== 'superseded');
    const q = query.toLowerCase();
    const matched = q.length === 0 ? all : all.filter((f) => f.content.toLowerCase().includes(q));
    const pinned = matched.filter((f) => f.source === 'user-pinned');
    const rest = matched.filter((f) => f.source !== 'user-pinned');
    const unmatched = all
      .filter((f) => !matched.includes(f))
      .sort((a, b) => b.createdAt - a.createdAt);
    return [...pinned, ...rest, ...unmatched].slice(0, limit);
  }
}

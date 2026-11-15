// JSONL 事件溯源日志：每 Thread 一个文件（11 §3 运行时目录规范）
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { migrateEvent, type LoopEvent } from '@loomery/domain';

/** 崩溃/断电可能在 append 中途留下残行——逐行容错解析，绝不让单行残缺拖垮整个任务的日志加载 */
export function parseJournalLines(text: string): { events: LoopEvent[]; corrupted: number; duplicates: number } {
  const events: LoopEvent[] = [];
  let corrupted = 0;
  let duplicates = 0;
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      // 迁移边界（#11）：旧版本信封沿链规范化到当前版本，未来版本保守透传
      const e = migrateEvent(JSON.parse(t) as Record<string, unknown>) as LoopEvent;
      // 信封最小完整性：type + threadId 缺一即视为残缺（半截 JSON 已被 catch 覆盖）
      if (e && typeof e === 'object' && typeof e.type === 'string' && typeof e.threadId === 'string') {
        // 幂等防线：uuid 重复 = 重写竞态/重放叠加的重复行，跳过保序取首见
        if (typeof e.id === 'string' && seen.has(e.id)) {
          duplicates += 1;
          continue;
        }
        if (typeof e.id === 'string') seen.add(e.id);
        events.push(e);
      } else {
        corrupted += 1;
      }
    } catch {
      corrupted += 1;
    }
  }
  return { events, corrupted, duplicates };
}

export class JsonJournal {
  constructor(private readonly sessionsDir: string) {}

  /** sessions 目录（任务记忆读模型重建时定位 JSONL 用，ADR-0021） */
  get dir(): string {
    return this.sessionsDir;
  }

  private path(threadId: string): string {
    return join(this.sessionsDir, `${threadId}.jsonl`);
  }

  async append(threadId: string, event: LoopEvent): Promise<void> {
    const file = this.path(threadId);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async remove(threadId: string): Promise<void> {
    await rm(this.path(threadId), { force: true });
  }

  async load(threadId: string): Promise<LoopEvent[]> {
    const file = this.path(threadId);
    if (!existsSync(file)) return [];
    const text = await readFile(file, 'utf8');
    const { events, corrupted, duplicates } = parseJournalLines(text);
    if (corrupted > 0) {
      console.warn(`[journal] ${threadId}: ${corrupted} 行事件残缺已跳过（崩溃残留；主体可读，不影响其余事件）`);
    }
    if (duplicates > 0) {
      console.warn(`[journal] ${threadId}: ${duplicates} 行重复事件已去重（uuid 幂等）`);
    }
    return events.filter((e) => e.threadId === threadId);
  }

  /** 存储 GC（ADR-0008 重放等价）：整文件原子替换为等价事件流（写临时文件 + 同目录 rename） */
  async rewrite(threadId: string, events: LoopEvent[]): Promise<void> {
    const file = this.path(threadId);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const body = events.map((e) => JSON.stringify(e)).join('\n');
    await writeFile(tmp, body.length > 0 ? body + '\n' : '', 'utf8');
    await rename(tmp, file);
  }
}

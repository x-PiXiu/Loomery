// 长期记忆 JSON 存储：按 id upsert；同内容去重
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryFact } from '@loomery/domain';

export class JsonFacts {
  constructor(private readonly filePath: string) {}

  private async loadAll(): Promise<MemoryFact[]> {
    if (!existsSync(this.filePath)) return [];
    return JSON.parse(await readFile(this.filePath, 'utf8')) as MemoryFact[];
  }

  private async saveAll(facts: MemoryFact[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(facts, null, 2), 'utf8');
  }

  async save(fact: MemoryFact): Promise<void> {
    const all = await this.loadAll();
    const byId = all.findIndex((f) => f.id === fact.id);
    if (byId >= 0) {
      all[byId] = fact;
    } else if (!all.some((f) => f.content === fact.content)) {
      all.push(fact);
    }
    await this.saveAll(all);
  }

  /** 简单相关性：包含查询词者优先，其余按时间倒序补足；已删除（superseded）不出结果 */
  async query(query: string, limit: number): Promise<MemoryFact[]> {
    const all = (await this.loadAll()).filter((f) => f.status !== 'superseded');
    const q = query.toLowerCase();
    const matched = all.filter((f) => q.length > 0 && f.content.toLowerCase().includes(q));
    const rest = all
      .filter((f) => !matched.includes(f))
      .sort((a, b) => b.createdAt - a.createdAt);
    return [...matched, ...rest].slice(0, limit);
  }

  async contents(): Promise<string[]> {
    return (await this.loadAll()).map((f) => f.content);
  }
}

// ADR-0021：产物存储——内容寻址不可变 blob（artifacts/<hash[:2]>/<hash>）+ index.json
// 事件与上下文只携带 ArtifactRef；get(hash, offset) 分页取回
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { ArtifactRef } from '@loomery/domain';
import type { ArtifactStore } from '@loomery/ports';

export interface ArtifactIndexEntry extends ArtifactRef {
  threadId: string;
  turnId?: string;
  createdAt: number;
}

/** ADR-0023：索引后端接缝——blob 永远在文件（hash 寻址），索引可换引擎（JSON 文件 / SQLite 表） */
export interface ArtifactIndexBackend {
  load(): Promise<ArtifactIndexEntry[]>;
  save(entries: ArtifactIndexEntry[]): Promise<void>;
}

export class ContentAddressedArtifactStore implements ArtifactStore {
  constructor(
    private readonly artifactsDir: string,
    /** 单 blob 分页读取的字符页大小 */
    private readonly pageSize = 20_000,
    /** ADR-0021：产物总容量上限（字节），超过按最旧逐出；缺省 256MB */
    private readonly maxTotalBytes = 256 * 1024 * 1024,
    /** 索引后端（ADR-0023 三迁：SQLite 引擎注入表后端；缺省 index.json 文件） */
    private readonly indexBackend?: ArtifactIndexBackend,
  ) {}

  private hashOf(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
  }

  private blobPath(hash: string): string {
    return join(this.artifactsDir, hash.slice(0, 2), hash);
  }

  private indexPath(): string {
    return join(this.artifactsDir, 'index.json');
  }

  private async loadIndex(): Promise<ArtifactIndexEntry[]> {
    if (this.indexBackend) return this.indexBackend.load();
    const p = this.indexPath();
    if (!existsSync(p)) return [];
    try {
      return JSON.parse(await readFile(p, 'utf8')) as ArtifactIndexEntry[];
    } catch {
      return [];
    }
  }

  private async saveIndex(entries: ArtifactIndexEntry[]): Promise<void> {
    if (this.indexBackend) return this.indexBackend.save(entries);
    await mkdir(this.artifactsDir, { recursive: true });
    await writeFile(this.indexPath(), JSON.stringify(entries, null, 2), 'utf8');
  }

  async put(content: string, meta: { threadId: string; turnId?: string; kind: ArtifactRef['kind']; summary: string }): Promise<ArtifactRef> {
    const hash = this.hashOf(content);
    const entries = await this.loadIndex();
    const existing = entries.find((e) => e.hash === hash);
    if (existing) return { hash, kind: existing.kind, summary: existing.summary, size: existing.size };
    const blob = this.blobPath(hash);
    await mkdir(dirname(blob), { recursive: true });
    await writeFile(blob, content, 'utf8');
    const entry: ArtifactIndexEntry = {
      hash, kind: meta.kind, summary: meta.summary,
      size: Buffer.byteLength(content, 'utf8'),
      threadId: meta.threadId, ...(meta.turnId !== undefined && { turnId: meta.turnId }),
      createdAt: Date.now(),
    };
    entries.push(entry);
    await this.saveIndex(entries);
    await this.evict();
    return { hash, kind: entry.kind, summary: entry.summary, size: entry.size };
  }

  async get(hash: string, offset = 0): Promise<string> {
    const p = this.blobPath(hash);
    if (!existsSync(p)) return '';
    const content = await readFile(p, 'utf8');
    return content.slice(offset, offset + this.pageSize);
  }

  /** ADR-0021 LRU 封顶：总容量超限时按 createdAt 最旧逐出（刚写入的除外），blob+索引同步删 */
  private async evict(): Promise<void> {
    const entries = await this.loadIndex();
    let total = entries.reduce((s, e) => s + e.size, 0);
    if (total <= this.maxTotalBytes) return;
    const sorted = [...entries].sort((a, b) => a.createdAt - b.createdAt);
    for (const e of sorted) {
      if (total <= this.maxTotalBytes) break;
      try {
        const blob = this.blobPath(e.hash);
        if (existsSync(blob)) rmSync(blob);
      } catch { /* 文件已被清理则跳过 */ }
      const idx = entries.findIndex((x) => x.hash === e.hash);
      if (idx >= 0) entries.splice(idx, 1);
      total -= e.size;
    }
    await this.saveIndex(entries);
  }

  /** 任务删除：清理归属该任务的索引项与 blob（内容寻址共享 hash 仅在无其他引用时删除） */
  async deleteThread(threadId: string): Promise<void> {
    const entries = await this.loadIndex();
    const mine = entries.filter((e) => e.threadId === threadId);
    for (const e of mine) {
      try {
        const blob = this.blobPath(e.hash);
        if (existsSync(blob) && !entries.some((x) => x.hash === e.hash && x.threadId !== threadId)) rmSync(blob);
      } catch { /* 跳过 */ }
    }
    const rest = entries.filter((e) => e.threadId !== threadId);
    if (rest.length !== entries.length) await this.saveIndex(rest);
  }

  async list(threadId: string): Promise<ArtifactRef[]> {
    return (await this.loadIndex())
      .filter((e) => e.threadId === threadId)
      .map(({ hash, kind, summary, size }) => ({ hash, kind, summary, size }));
  }
}

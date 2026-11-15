// ADR-0021：任务简报存储——文件为主（memory/tasks/<threadId>.md，人类可手编）
// rev/audit 元数据存同名 .meta.json；write 返回的 Brief 供工具层合成 briefUpdate 事件（仅审计）
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Brief } from '@loomery/domain';
import type { BriefStore } from '@loomery/ports';

interface BriefMeta {
  rev: number;
  hash: string;
}

export class FileBriefStore implements BriefStore {
  constructor(private readonly tasksDir: string) {}

  private mdPath(threadId: string): string {
    return join(this.tasksDir, `${threadId}.md`);
  }

  private metaPath(threadId: string): string {
    return join(this.tasksDir, `${threadId}.brief-meta.json`);
  }

  private hashOf(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
  }

  async read(threadId: string): Promise<Brief | null> {
    const p = this.mdPath(threadId);
    if (!existsSync(p)) return null;
    const content = await readFile(p, 'utf8');
    let rev = 0;
    const metaPath = this.metaPath(threadId);
    if (existsSync(metaPath)) {
      try {
        rev = (JSON.parse(await readFile(metaPath, 'utf8')) as BriefMeta).rev ?? 0;
      } catch {
        rev = 0;
      }
    }
    return { threadId, content, rev };
  }

  async write(threadId: string, content: string, actor: 'user' | 'agent'): Promise<Brief> {
    const md = this.mdPath(threadId);
    const metaP = this.metaPath(threadId);
    await mkdir(dirname(md), { recursive: true });
    let prevRev = 0;
    let prevHash = '';
    if (existsSync(metaP)) {
      try {
        const m = JSON.parse(await readFile(metaP, 'utf8')) as BriefMeta;
        prevRev = m.rev ?? 0;
        prevHash = m.hash ?? '';
      } catch {
        prevRev = 0;
      }
    }
    // 人类手编后 rev 未知变化：以内容 hash 判断，未变化则不递增不重复写
    const hash = this.hashOf(content);
    if (hash === prevHash) {
      return { threadId, content, rev: prevRev };
    }
    const rev = prevRev + 1;
    await writeFile(md, content, 'utf8');
    await writeFile(metaP, JSON.stringify({ rev, hash, updatedAt: Date.now(), actor } satisfies BriefMeta & { updatedAt: number; actor: string }), 'utf8');
    return { threadId, content, rev };
  }

  /** 任务删除：清理简报及其元数据（ADR-0021 任务删除 GC） */
  async deleteThread(threadId: string): Promise<void> {
    const md = this.mdPath(threadId);
    const meta = this.metaPath(threadId);
    if (existsSync(md)) rmSync(md);
    if (existsSync(meta)) rmSync(meta);
    const archive = join(this.tasksDir, threadId + '.archive');
    if (existsSync(archive)) rmSync(archive, { recursive: true, force: true });
  }

  /** 归档当前简报到 <id>.archive/rev-<N>.md（历史区，不注入；人类可在面板回看文件） */
  async archive(threadId: string): Promise<string | null> {
    const md = this.mdPath(threadId);
    if (!existsSync(md)) return null;
    const metaP = this.metaPath(threadId);
    let rev = 0;
    if (existsSync(metaP)) {
      try {
        rev = (JSON.parse(await readFile(metaP, 'utf8')) as BriefMeta).rev ?? 0;
      } catch {
        rev = 0;
      }
    }
    const archiveDir = join(this.tasksDir, threadId + '.archive');
    await mkdir(archiveDir, { recursive: true });
    const dest = join(archiveDir, 'rev-' + rev + '.md');
    await copyFile(md, dest);
    return dest;
  }
}

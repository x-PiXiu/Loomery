// 07 §5 Checkpoint：Turn 内某路径首次被写前懒快照；回滚 = 还原本 Turn 全部快照；
// 滚动保留最近 N 个 Turn（CHECKPOINT_KEEP_TURNS）——快照落地后自调 prune（滚动策略是实现细节不进端口契约）
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { CHECKPOINT_KEEP_TURNS } from '@loomery/domain';
import type { CheckpointPort } from '@loomery/ports';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 绝对路径编码为单层文件名（可逆），避免快照目录镜像目录树 */
function encodePath(abs: string): string {
  return abs.replace(/:/g, '@C').replace(/\\/g, '@B').replace(/\//g, '@F');
}

function decodePath(name: string): string {
  return name.replace(/@F/g, '/').replace(/@B/g, '\\').replace(/@C/g, ':');
}

export class CheckpointService implements CheckpointPort {
  constructor(private readonly rootDir: string) {}

  private turnDir(turnId: string): string {
    return join(this.rootDir, turnId);
  }

  snapshotPath(turnId: string, file: string): string {
    return join(this.turnDir(turnId), encodePath(file));
  }

  /** 返回是否实际新建了快照（同一 Turn 内同一路径只快照一次） */
  async snapshot(turnId: string, file: string): Promise<boolean> {
    const dest = this.snapshotPath(turnId, file);
    if (existsSync(dest)) return false;
    await mkdir(dirnameSafe(dest), { recursive: true });
    if (existsSync(file)) {
      await copyFile(file, dest);
    } else {
      // 新建文件：空快照 + .created 标记，回滚时删除目标
      await writeFile(dest, '');
      await writeFile(`${dest}.created`, '');
    }
    // 滚动清理接线（11-17）：新 Turn 快照落地后按目录 mtime 保留最近 CHECKPOINT_KEEP_TURNS 个。
    // 当前 Turn 目录刚写入 mtime 最新必被保留；清理失败不拖垮快照（prune 内部已逐目录容错）
    await this.prune(CHECKPOINT_KEEP_TURNS).catch(() => []);
    return true;
  }

  async listFiles(turnId: string): Promise<string[]> {
    const dir = this.turnDir(turnId);
    if (!existsSync(dir)) return [];
    return (await readdir(dir))
      .filter((n) => !n.endsWith('.created'))
      .map(decodePath);
  }

  async restore(turnId: string): Promise<{ restored: string[]; failed: string[] }> {
    const dir = this.turnDir(turnId);
    if (!existsSync(dir)) return { restored: [], failed: [] };
    const entries = await readdir(dir);
    // 新建文件以 .created 标记为准（跳过其空快照实体，避免重复记录）
    const createdNames = new Set(
      entries.filter((n) => n.endsWith('.created')).map((n) => n.slice(0, -'.created'.length)),
    );
    const restored: string[] = [];
    const failed: string[] = [];
    for (const name of entries) {
      const snapshot = join(dir, name);
      if (name.endsWith('.created')) {
        const original = decodePath(name.slice(0, -'.created'.length));
        try {
          if (existsSync(original)) await rm(original);
          restored.push(original);
        } catch {
          failed.push(original);
        }
        continue;
      }
      if (createdNames.has(name)) continue;
      const original = decodePath(name);
      try {
        await copyFile(snapshot, original);
        restored.push(original);
      } catch {
        failed.push(original);
      }
    }
    return { restored, failed };
  }
  /** 读取某 Turn 某文件的快照原文（DiffPane 原始侧内容；无快照或二进制返回 null） */
  async readSnapshot(turnId: string, file: string): Promise<string | null> {
    const dest = this.snapshotPath(turnId, file);
    if (!existsSync(dest)) return null;
    const buf = await readFile(dest);
    if (buf.subarray(0, 8000).includes(0)) return null;
    return buf.toString('utf8');
  }

  /** 滚动清理：按目录 mtime 删除最旧的 Turn 快照，仅保留最近 keepTurns 个 */
  async prune(keepTurns: number): Promise<string[]> {
    if (!existsSync(this.rootDir)) return [];
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    const withMtime = await Promise.all(
      dirs.map(async (d) => ({
        name: d.name,
        path: join(this.rootDir, d.name),
        mtime: (await stat(join(this.rootDir, d.name))).mtimeMs,
      })),
    );
    withMtime.sort((a, b) => a.mtime - b.mtime);
    const removed: string[] = [];
    while (withMtime.length > keepTurns) {
      const oldest = withMtime.shift();
      if (!oldest) break;
      await rm(oldest.path, { recursive: true, force: true });
      removed.push(oldest.name);
    }
    return removed;
  }
}

function dirnameSafe(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i === -1 ? '.' : p.slice(0, i);
}

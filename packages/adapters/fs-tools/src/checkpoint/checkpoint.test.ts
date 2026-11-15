import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CheckpointService } from './checkpoint';

let workspace = '';
let snapshots = '';
let service: CheckpointService;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'loomery-ws-'));
  snapshots = await mkdtemp(join(tmpdir(), 'loomery-ck-'));
  service = new CheckpointService(snapshots);
  return async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(snapshots, { recursive: true, force: true });
  };
});

describe('CheckpointService（07 §5 懒快照）', () => {
  it('已有文件：首次快照复制原内容，二次快照不覆盖', async () => {
    const file = join(workspace, 'a.txt');
    await writeFile(file, 'v1', 'utf8');
    expect(await service.snapshot('turn1', file)).toBe(true);
    // 模拟第一轮修改后再快照：不应覆盖 v1
    await writeFile(file, 'v2', 'utf8');
    expect(await service.snapshot('turn1', file)).toBe(false);
    expect(await readFile(service.snapshotPath('turn1', file), 'utf8')).toBe('v1');
  });

  it('新建文件：写 .created 标记', async () => {
    const file = join(workspace, 'new.txt');
    await service.snapshot('turn1', file);
    expect(existsSync(`${service.snapshotPath('turn1', file)}.created`)).toBe(true);
  });

  it('restore 还原已修改文件并删除新建文件', async () => {
    const existing = join(workspace, 'a.txt');
    const created = join(workspace, 'b.txt');
    await writeFile(existing, 'v1', 'utf8');

    await service.snapshot('turn1', existing);
    await writeFile(existing, 'v2', 'utf8');
    await service.snapshot('turn1', created); // created 标记
    await writeFile(created, 'new content', 'utf8');

    const { restored, failed } = await service.restore('turn1');
    expect(failed).toEqual([]);
    expect(restored.sort()).toEqual([created, existing].sort());
    expect(await readFile(existing, 'utf8')).toBe('v1');
    expect(existsSync(created)).toBe(false);
  });

  it('listFiles 返回本 Turn 触碰过的绝对路径', async () => {
    const file = join(workspace, 'a.txt');
    await writeFile(file, 'v1', 'utf8');
    await service.snapshot('turn1', file);
    expect(await service.listFiles('turn1')).toEqual([file]);
  });

  it('未快照的 Turn restore 返回空', async () => {
    expect(await service.restore('ghost')).toEqual({ restored: [], failed: [] });
  });

  it('prune 滚动清理：仅保留最近 N 个 Turn（07 §5）', async () => {
    for (const turn of ['t1', 't2', 't3']) {
      const file = join(workspace, `${turn}.txt`);
      await writeFile(file, 'x', 'utf8');
      await service.snapshot(turn, file);
      // 确保目录 mtime 可区分
      await new Promise((r) => setTimeout(r, 20));
    }
    const removed = await service.prune(2);
    expect(removed).toEqual(['t1']);
    expect(existsSync(service.snapshotPath('t1', join(workspace, 't1.txt')))).toBe(false);
    expect(existsSync(service.snapshotPath('t2', join(workspace, 't2.txt')))).toBe(true);
  });
});

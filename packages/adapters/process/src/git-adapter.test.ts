// F1.3：GitAdapter 真机测试（临时 git 仓库，绝不触碰真实仓库）
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GitAdapter } from './git-adapter';

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'loomery-git-'));
  roots.push(root);
  // init + 身份（临时仓库内）
  await exec(root, ['init']);
  await exec(root, ['config', 'user.email', 'test@loomery.local']);
  await exec(root, ['config', 'user.name', 'loomery-test']);
  await writeFile(join(root, 'a.txt'), 'v1\n', 'utf8');
  await exec(root, ['add', '.']);
  await exec(root, ['commit', '-m', 'init']);
  return root;
}

async function exec(root: string, args: string[]): Promise<void> {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
}

describe('GitAdapter（真机临时仓库）', () => {
  it('available 探测', async () => {
    expect(await new GitAdapter().available()).toBe(true);
  });

  it('status/diff/log 全链', async () => {
    const root = await makeRepo();
    const git = new GitAdapter();
    const st = await git.status(root);
    expect(st).toContain('branch.head');
    const diff = await git.diff(root);
    expect(diff).toContain('（无差异）');
    const log = await git.log(root, 5);
    expect(log).toContain('init');
  });

  it('commit（指定 files）→ status 干净 → log 可见', async () => {
    const root = await makeRepo();
    const git = new GitAdapter();
    await writeFile(join(root, 'b.txt'), 'new\n', 'utf8');
    const summary = await git.commit(root, 'feat: add b', ['b.txt']);
    expect(summary).toContain('feat: add b');
    const st = await git.status(root);
    expect(st).not.toContain('b.txt');
    const log = await git.log(root, 2);
    expect(log).toContain('feat: add b');
  });

  it('overview：分支+变更+numstat ±行数聚合（胶囊读模型）', async () => {
    const root = await makeRepo();
    const git = new GitAdapter();
    // 已跟踪文件修改 → numstat 出真实 ±（原 init 提交的 a.txt 内容 'v1\n'，改为 3 行）
    await writeFile(join(root, 'a.txt'), 'v1\nv2\nv3\n', 'utf8');
    // untracked 新文件 → numstat 不含 untracked——读文件数行（回归：胶囊 +0 -0）
    await writeFile(join(root, 'b.txt'), 'line1\nline2\n', 'utf8');
    // untracked 目录 → 折叠显示，行数 0
    await (await import('node:fs/promises')).mkdir(join(root, 'sub'));
    await writeFile(join(root, 'sub', 'c.txt'), 'x\n', 'utf8');
    const ov = await git.overview(root);
    expect(ov.repo).toBe(true);
    expect(ov.branch.length).toBeGreaterThan(0);
    const a = ov.changed.find((c) => c.path.endsWith('a.txt'));
    expect(a).toBeDefined();
    expect(a!.added).toBe(2);
    expect(a!.removed).toBe(0);
    const b = ov.changed.find((c) => c.path.endsWith('b.txt'));
    expect(b).toBeDefined();
    expect(b!.status).toBe('?');
    expect(b!.added).toBe(2); // 新文件真实行数（不再 +0）
    // -uall 后未跟踪目录展开为逐文件（2026-11-13 修复：折叠目录内的文件此前不可见）
    const subFile = ov.changed.find((c) => c.path === 'sub/c.txt');
    expect(subFile).toBeDefined();
    expect(subFile!.added).toBe(1); // 子目录内文件的行数可见
    expect(ov.totalAdded).toBe(5); // 2(numstat) + 2(新文件) + 1(sub/c.txt)
    expect(ov.totalRemoved).toBe(0);
  });

  it('overview：非 git 仓库返回 repo:false（胶囊隐藏）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loomery-nogit-'));
    roots.push(root);
    const ov = await new GitAdapter().overview(root);
    expect(ov.repo).toBe(false);
    expect(ov.changed).toHaveLength(0);
  });

  it('commit 失败（无变更）抛错带 stderr', async () => {
    const root = await makeRepo();
    const git = new GitAdapter();
    await expect(git.commit(root, 'nothing')).rejects.toThrow('git commit 失败');
  });
});

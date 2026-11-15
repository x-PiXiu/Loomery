// 领土实勘回归锁（ADR-0013 补全）：symlink/junction 逃逸实证——字符串护栏看不见链接目标，
// 本测试在真实文件系统上证明 makeTerritoryVerifier 拦住"域内链接→域外落盘"。
// Windows 用 junction（mklink /J 等价，无需管理员特权）；fs.realpath 会解析 junction。
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTerritoryVerifier, resolveRealPath } from './territory';

async function makeWs(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'loomery-territory-'));
}

describe('resolveRealPath（最近存在祖先解析）', () => {
  it('存在文件：直接解析到真实路径', async () => {
    const { realpath } = await import('node:fs/promises');
    const ws = await makeWs();
    const f = join(ws, 'a.txt');
    await writeFile(f, 'x', 'utf8');
    expect(await resolveRealPath(f)).toBe(await realpath(f));
    await rm(ws, { recursive: true, force: true });
  });

  it('不存在文件：上溯存在祖先拼回剩余段', async () => {
    const ws = await makeWs();
    const real = await (await import('node:fs/promises')).realpath(ws);
    const ghost = join(real, 'newdir', 'f.txt');
    expect(await resolveRealPath(ghost)).toBe(ghost);
    await rm(ws, { recursive: true, force: true });
  });
});

describe('makeTerritoryVerifier（junction 逃逸防线）', () => {
  it('域内 junction → 域外已有文件：拒绝', async () => {
    const ws = await makeWs();
    const outside = await makeWs();
    await writeFile(join(outside, 'secret.txt'), 's', 'utf8');
    await mkdir(join(ws, 'link'));
    await rm(join(ws, 'link'), { recursive: true, force: true });
    await symlink(outside, join(ws, 'link'), 'junction');
    const v = makeTerritoryVerifier([ws]);
    await expect(v(join(ws, 'link', 'secret.txt'))).rejects.toThrow(/越出工作区/);
    await rm(ws, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('域内 junction → 域外新建文件（祖先上溯路径）：拒绝', async () => {
    const ws = await makeWs();
    const outside = await makeWs();
    await mkdir(join(ws, 'link'));
    await rm(join(ws, 'link'), { recursive: true, force: true });
    await symlink(outside, join(ws, 'link'), 'junction');
    const v = makeTerritoryVerifier([ws]);
    await expect(v(join(ws, 'link', 'brand-new.txt'))).rejects.toThrow(/越出工作区/);
    await rm(ws, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('域内 junction → 域内目标：放行', async () => {
    const ws = await makeWs();
    await mkdir(join(ws, 'docs'), { recursive: true });
    await mkdir(join(ws, 'alias'));
    await rm(join(ws, 'alias'), { recursive: true, force: true });
    await symlink(join(ws, 'docs'), join(ws, 'alias'), 'junction');
    const v = makeTerritoryVerifier([ws]);
    await expect(v(join(ws, 'alias', 'a.md'))).resolves.toBeUndefined();
    await rm(ws, { recursive: true, force: true });
  });

  it('域内真实新建文件：放行', async () => {
    const ws = await makeWs();
    const v = makeTerritoryVerifier([ws]);
    await expect(v(join(ws, 'src', 'new.ts'))).resolves.toBeUndefined();
    await rm(ws, { recursive: true, force: true });
  });

  it('工作区根本身是 junction：按真实位置放行域内路径', async () => {
    const outside = await makeWs();
    const alias = await makeWs();
    await rm(alias, { recursive: true, force: true });
    await symlink(outside, alias, 'junction');
    const v = makeTerritoryVerifier([alias]); // 用户配置的根就是链接
    await expect(v(join(alias, 'ok.txt'))).resolves.toBeUndefined();
    await expect(v(join(outside, '..', 'elsewhere.txt'))).rejects.toThrow(/越出工作区/);
    await rm(alias, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('scratch 目录合法域：放行', async () => {
    const ws = await makeWs();
    const scratch = await makeWs();
    const v = makeTerritoryVerifier([ws], scratch);
    await expect(v(join(scratch, 'note.md'))).resolves.toBeUndefined();
    await rm(ws, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });
});

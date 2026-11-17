// JsonConfigStore 损坏容错测试（实证：并发写导致「新文档+旧尾」截断失败 → 启动直接死）
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonConfigStore, salvageConfig } from './json/config-file';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const mk = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'loomery-config-'));
  dirs.push(d);
  return d;
};

const VALID = JSON.stringify({ workspaceRoots: ['E:/a', 'E:/b'], models: { main: { provider: 'openai-compatible', modelId: 'm1' } } }, null, 2);

describe('JsonConfigStore 损坏容错', () => {
  it('salvageConfig：从「新文档+旧尾」形态抢救最长可解析前缀', () => {
    const corrupted = VALID + 'emo"\n  ]\n}'; // 实证形态：合法文档 + 旧版残尾
    const salvaged = salvageConfig(corrupted);
    expect(salvaged).not.toBeNull();
    expect(salvaged?.workspaceRoots).toEqual(['E:/a', 'E:/b']);
  });

  it('salvageConfig：完全不可解析返回 null', () => {
    expect(salvageConfig('not-json-at-all???')).toBeNull();
  });

  it('load：损坏配置自动备份 + 抢救前段 + 不抛错', async () => {
    const dir = await mk();
    const p = join(dir, 'config.json');
    await writeFile(p, VALID + 'emo"\n  ]\n}', 'utf8');
    const store = new JsonConfigStore(p);
    const cfg = await store.load();
    expect(cfg.workspaceRoots).toEqual(['E:/a', 'E:/b']);
    // 坏档已备份
    expect(await readFile(p + '.corrupt-' + String()).catch(() => null)).toBeNull(); // 时间戳后缀不定，只验证备份存在
    const files = (await import('node:fs/promises')).readdir(dir);
    expect((await files).some((f) => f.startsWith('config.json.corrupt-'))).toBe(true);
  });

  it('load：合法配置直通', async () => {
    const dir = await mk();
    const p = join(dir, 'config.json');
    await writeFile(p, VALID, 'utf8');
    const cfg = await new JsonConfigStore(p).load();
    expect(cfg.models.main.modelId).toBe('m1');
  });

  it('save→load 往返', async () => {
    const dir = await mk();
    const p = join(dir, 'config.json');
    const store = new JsonConfigStore(p);
    await store.save({ workspaceRoots: ['E:/x'] });
    expect((await store.load()).workspaceRoots).toEqual(['E:/x']);
  });

  it('load 保留 AppConfig 可选顶层字段与未知键（11-17 欢迎浮层重启必现的根因：白名单重建丢字段）', async () => {
    const dir = await mk();
    const p = join(dir, 'config.json');
    await writeFile(
      p,
      JSON.stringify({
        ...JSON.parse(VALID),
        onboardingDone: true,
        agentPersona: '说话简短',
        skills: { disabled: ['skill-creator'] },
        projectNames: { 'E:/a': '我的项目' },
        futureField: { kept: true }, // 前向兼容：未知顶层键也必须活过 load
      }),
      'utf8',
    );
    const cfg = await new JsonConfigStore(p).load();
    expect(cfg.onboardingDone).toBe(true);
    expect(cfg.agentPersona).toBe('说话简短');
    expect(cfg.skills?.disabled).toEqual(['skill-creator']);
    expect(cfg.projectNames).toEqual({ 'E:/a': '我的项目' });
    expect((cfg as unknown as Record<string, unknown>).futureField).toEqual({ kept: true });
    // 既有段合并语义不回归
    expect(cfg.workspaceRoots).toEqual(['E:/a', 'E:/b']);
    expect(cfg.models.main.modelId).toBe('m1');
  });

  it('损坏文件上保存自愈：按抢救前段合并，新增模型不丢（实证回归）', async () => {
    const dir = await mk();
    const p = join(dir, 'config.json');
    // 实证损坏形态：合法文档 + 旧尾
    await writeFile(p, VALID + 'emo"\n  ]\n}', 'utf8');
    const store = new JsonConfigStore(p);
    // 用户在损坏状态下新增模型（此前 save 读旧档解析即抛 → 静默丢失）
    await store.save({ models: { entries: [{ id: 'e_new', provider: 'openai-compatible', modelId: 'new-model', enabled: true }] } as never });
    const cfg = await store.load();
    expect(cfg.workspaceRoots).toEqual(['E:/a', 'E:/b']); // 抢救的旧数据保留
    expect(cfg.models.entries?.some((m) => m.modelId === 'new-model')).toBe(true); // 新增落盘
    // 文件本体已修复（可解析）
    JSON.parse(await readFile(p, 'utf8'));
  });

  it('并发保存串行化：合并语义无丢失', async () => {
    const dir = await mk();
    const p = join(dir, 'config.json');
    const store = new JsonConfigStore(p);
    await Promise.all([
      store.save({ workspaceRoots: ['E:/r1'] }),
      store.save({ models: { entries: [{ id: 'e1', provider: 'openai-compatible', modelId: 'm', enabled: true }] } as never }),
      store.save({ restorePolicy: 're-ask' }),
    ]);
    const cfg = await store.load();
    expect(cfg.workspaceRoots).toEqual(['E:/r1']);
    expect(cfg.models.entries?.[0]?.modelId).toBe('m');
    expect(cfg.restorePolicy).toBe('re-ask');
  });

  it('双窗口并发写实证：交错保存流下文件永不撕裂、双方末次写均落盘（11-17）', async () => {
    const dir = await mk();
    const p = join(dir, 'config.json');
    // 双窗口 IPC 经单实例锁汇入主进程同一 ConfigStore 实例——写队列即竞态防线；
    // 本测试模拟两股交错保存流（窗口 A 改 roots / 窗口 B 改 approval）+ 写进行中并发读
    const store = new JsonConfigStore(p);
    const winA = Array.from({ length: 10 }, (_, i) => store.save({ workspaceRoots: [`E:/ws/a${i}`] }));
    const winB = Array.from({ length: 10 }, (_, i) => store.save({ approval: { read: 'auto', write: i % 2 ? 'ask' : 'auto', execute: 'deny' } }));
    // 撕裂读探针：写进行中读文件，任何一次读到「新文档+旧尾」残缺态（JSON.parse 抛错）即失败。
    // 疏读（6 次×5ms 间隔≈120ms）：Windows 单次读句柄占 ~14ms，重试窗口（10 次≈345ms）必须覆盖读存活期；
    // 生产场景 load() 是偶发 RPC，同理单次占用远小于重试窗口
    let reads = 0;
    const reader = (async () => {
      for (let i = 0; i < 6; i++) {
        if (existsSync(p)) JSON.parse(await readFile(p, 'utf8'));
        reads += 1;
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    await Promise.all([...winA, ...winB, reader]);
    const cfg = await store.load();
    // save() 同步入队 FIFO：A 末次(a9)/B 末次(b9, i=9→ask) 均落盘，中途补丁按序合并无丢失
    expect(cfg.workspaceRoots).toEqual(['E:/ws/a9']);
    expect(cfg.approval).toEqual({ read: 'auto', write: 'ask', execute: 'deny' });
    expect(reads).toBe(6);
    expect(existsSync(p + '.tmp')).toBe(false); // 原子 rename 后无残留临时文件
  });
});

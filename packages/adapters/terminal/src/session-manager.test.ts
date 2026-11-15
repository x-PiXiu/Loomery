// F2.2：SessionManager 多 tab 编排（FakeProvider 纯逻辑；真机 pty 由 Electron 冒烟脚本验证 ABI）
import { describe, expect, it } from 'vitest';
import type { TerminalProvider, TerminalSession } from '@loomery/ports';
import { TerminalSessionManager } from './session-manager';
import { ProcessRegistry } from '@loomery/adapter-process';

class FakeProvider implements TerminalProvider {
  created = 0;
  readonly sessions: { session: TerminalSession; cwd: string; dataCb?: (d: string) => void; exitCb?: (c: number) => void }[] = [];
  shellName = 'PowerShell';
  async create(opts: { cwd: string }): Promise<TerminalSession> {
    this.created++;
    const s: { session: TerminalSession; cwd: string; dataCb?: (d: string) => void; exitCb?: (c: number) => void } = {
      session: null as unknown as TerminalSession,
      cwd: opts.cwd,
    };
    const session: TerminalSession = {
      write: (d: string) => s.dataCb?.(d),
      resize: () => undefined,
      onData: (cb) => {
        s.dataCb = cb;
      },
      onExit: (cb) => {
        s.exitCb = cb;
      },
      kill: () => {
        s.exitCb?.(0);
      },
    };
    s.session = session;
    this.sessions.push(s);
    return session;
  }
}

describe('TerminalSessionManager（12 §F2.2）', () => {
  it('多 tab：create 多会话、write/resize 按 id 路由', async () => {
    const provider = new FakeProvider();
    const mgr = new TerminalSessionManager(provider);
    const a = await mgr.create({ cwd: 'C:/ws' });
    const b = await mgr.create({ cwd: 'C:/ws2' });
    expect(mgr.count).toBe(2);
    expect(a.shellName).toBe('PowerShell');
    // write/resize 路由到对应 session：不抛错即通过（真机 pty 行为由 Electron 冒烟覆盖）
    expect(() => mgr.write(a.id, 'dir\r')).not.toThrow();
    expect(() => mgr.resize(b.id, 120, 40)).not.toThrow();
    expect(provider.created).toBe(2);
  });

  it('数据分发与 exit 清理（terminalExit 语义）', async () => {
    const provider = new FakeProvider();
    const mgr = new TerminalSessionManager(provider);
    const data: string[] = [];
    const exits: string[] = [];
    mgr.onDataCb = (id, chunk) => data.push(`${id}:${chunk}`);
    mgr.onExitCb = (id) => exits.push(id);
    const t = await mgr.create({ cwd: 'C:/ws' });
    provider.sessions[0]!.dataCb?.('hello');
    expect(data).toEqual([`${t.id}:hello`]);
    mgr.kill(t.id); // FakeProvider kill → exitCb(0)
    expect(mgr.count).toBe(0);
    expect(exits).toEqual([t.id]);
  });

  it('ProcessRegistry 登记：exit 标记 killed，killAll 清场', async () => {
    const provider = new FakeProvider();
    const registry = new ProcessRegistry();
    const mgr = new TerminalSessionManager(provider, registry);
    const t = await mgr.create({ cwd: 'C:/ws' });
    expect(registry.list().length).toBe(1);
    expect(registry.list()[0]?.kind).toBe('terminal');
    provider.sessions[0]!.exitCb?.(1); // 用户退出 shell
    expect(registry.list()[0]?.state).toBe('killed');
    mgr.killAll();
    expect(mgr.count).toBe(0);
    expect(t.id).toContain('term_');
  });

  it('kill 不存在的 id 返回 false', async () => {
    const provider = new FakeProvider();
    const mgr = new TerminalSessionManager(provider);
    expect(mgr.kill('term_999')).toBe(false);
  });
});

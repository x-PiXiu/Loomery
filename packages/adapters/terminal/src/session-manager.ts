// 12 §F2.2 TerminalSessionManager：多 tab 会话编排（IPC 面直接消费，内核无感）
// 生命周期：create 登记 ProcessRegistry → exit/kill 标记并移除活跃 session（UI 收 terminalExit 移 tab）
import type { TerminalProvider, TerminalSession } from '@loomery/ports';
import type { ProcessRegistry } from '@loomery/adapter-process';

export interface TerminalMeta {
  id: string;
  shellName: string;
  cwd: string;
  pid: number | null;
  startedAt: number;
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, { session: TerminalSession; meta: TerminalMeta }>();
  private seq = 0;

  constructor(
    private readonly provider: TerminalProvider,
    /** 缺省不登记（单测轻用）；生产传入 main 单例（before-quit killAll 清场） */
    private readonly registry?: ProcessRegistry,
  ) {}

  get count(): number {
    return this.sessions.size;
  }

  async create(opts: { cwd?: string; env?: Record<string, string> }): Promise<TerminalMeta> {
    const id = `term_${++this.seq}`;
    const cwd = opts.cwd ?? process.cwd();
    const shellName = (this.provider as { shellName?: string }).shellName ?? 'shell';
    const session = await this.provider.create({ cwd, ...(opts.env ? { env: opts.env } : {}) });
    const meta: TerminalMeta = {
      id,
      shellName,
      cwd,
      pid: (session as unknown as { pid?: number }).pid ?? null,
      startedAt: Date.now(),
    };
    this.sessions.set(id, { session, meta });
    const registryId = this.registry?.register({
      kind: 'terminal',
      pid: meta.pid,
      cwd,
      command: `terminal:${shellName}`,
      startedAt: meta.startedAt,
      kill: async () => session.kill(),
    });
    session.onData((chunk) => this.onDataCb?.(id, chunk));
    session.onExit((code) => {
      this.sessions.delete(id);
      if (registryId) this.registry?.markExit(registryId, true);
      this.onExitCb?.(id, code);
    });
    return meta;
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.session.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.session.resize(cols, rows);
  }

  kill(id: string): boolean {
    const entry = this.sessions.get(id);
    if (!entry) return false;
    entry.session.kill();
    return true;
  }

  list(): TerminalMeta[] {
    return [...this.sessions.values()].map((e) => e.meta);
  }

  get(id: string): TerminalMeta | undefined {
    return this.sessions.get(id)?.meta;
  }

  /** 事件分发（bootstrap 注入推送；exit 后 session 已移除） */
  onDataCb?: (id: string, chunk: string) => void;
  onExitCb?: (id: string, code: number) => void;

  /** before-quit 清场（ProcessRegistry.killAll 会走登记的 kill 闭包，此方法为兜底） */
  killAll(): void {
    for (const { session } of this.sessions.values()) session.kill();
    this.sessions.clear();
  }
}

// 12 §F1.1 ProcessRegistry：main 进程唯一子进程登记处（agent + 终端两类）
// 生命周期铁律：abort 联动（adapter 内）、before-quit killAll、并发闸（adapter 内）、输出封顶（adapter 内）
export interface ProcessEntry {
  id: string;
  kind: 'agent' | 'terminal';
  pid: number | null;
  cwd: string;
  command: string;
  startedAt: number;
  state: 'running' | 'exited' | 'killed';
}

export class ProcessRegistry {
  private readonly entries = new Map<string, ProcessEntry & { kill: () => Promise<void> }>();
  private seq = 0;

  /** 登记；kill 为树杀闭包（entry 退出后调用无害） */
  register(entry: {
    kind: ProcessEntry['kind'];
    pid: number | null;
    cwd: string;
    command: string;
    startedAt: number;
    kill: () => Promise<void>;
  }): string {
    const id = `proc_${++this.seq}`;
    this.entries.set(id, { ...entry, id, state: 'running' });
    return id;
  }

  markExit(id: string, killed = false): void {
    const e = this.entries.get(id);
    if (!e || e.state !== 'running') return; // 单调转移：killAll 已标 killed 的不被 close 回调改回
    e.state = killed ? 'killed' : 'exited';
  }

  get(id: string): (ProcessEntry & { kill: () => Promise<void> }) | undefined {
    return this.entries.get(id);
  }

  list(): ProcessEntry[] {
    return [...this.entries.values()];
  }

  /** before-quit 清场：杀全部仍运行的进程树，返回数量 */
  async killAll(): Promise<number> {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.state !== 'running') continue;
      try {
        await e.kill();
        e.state = 'killed';
        n++;
      } catch {
        // 进程可能已自行退出：忽略，清场不中断
      }
    }
    return n;
  }
}

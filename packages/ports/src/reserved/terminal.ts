// 03 §9 预留接口 → 12 §F2.1 实现（阶段 2 内嵌终端面板）
// create 为 async：node-pty 是 native 模块（Node/Electron ABI 双栈），实现内部懒加载
export interface TerminalSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
  kill(): void;
}

export interface TerminalProvider {
  create(opts: { cwd: string; env?: Record<string, string> }): Promise<TerminalSession>;
}

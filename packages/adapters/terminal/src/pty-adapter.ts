// 12 §F2.1/F2.4 NodePtyAdapter：node-pty（ConPTY）实现 TerminalProvider
// 关键点：
// - node-pty 为 native 模块，懒加载（首次 create 才 import）——Node ABI / Electron ABI 双栈共存，
//   vitest（Node ABI 环境）不触发真 spawn 就不会加载错 ABI 的二进制（electron-rebuild 后为 Electron ABI）
// - 编码处理（F2.4）：PowerShell 5.1 启动预设 OutputEncoding=UTF8；cmd chcp 65001；pwsh 7 原生 UTF-8
// - 树杀：Windows 上 ConPTY close 会连带终止子进程树（node-pty kill() 语义）
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TerminalProvider, TerminalSession } from '@loomery/ports';

export type ShellKind = 'pwsh' | 'powershell' | 'cmd';

export interface DetectedShell {
  file: string;
  args: string[];
  kind: ShellKind;
  name: string;
}

/** 编码预设：中文 Windows 的 GBK 乱码根治（截图实证过的坑） */
function shellArgs(kind: ShellKind): string[] {
  if (kind === 'pwsh') return ['-NoLogo'];
  if (kind === 'powershell') {
    return [
      '-NoLogo', '-NoProfile', '-NoExit', '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8',
    ];
  }
  return ['/k', 'chcp 65001 >nul'];
}

function shellLabel(kind: ShellKind): string {
  return kind === 'pwsh' ? 'PowerShell 7' : kind === 'powershell' ? 'PowerShell' : 'cmd';
}

/** 默认 shell 探测：pwsh > powershell > cmd（一定有兜底） */
export function detectShell(): DetectedShell {
  if (process.platform !== 'win32') {
    const file = process.env.SHELL ?? '/bin/bash';
    return { file, args: [], kind: 'cmd', name: file };
  }
  try {
    const r = spawnSync('where.exe', ['pwsh'], { windowsHide: true, encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim().length > 0) {
      const kind: ShellKind = 'pwsh';
      const file = r.stdout.trim().split(/\r?\n/)[0] ?? 'pwsh.exe';
      return { file, args: shellArgs(kind), kind, name: shellLabel(kind) };
    }
  } catch { /* where 不可用：继续探测 */ }
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (existsSync(powershell)) {
    const kind: ShellKind = 'powershell';
    return { file: powershell, args: shellArgs(kind), kind, name: shellLabel(kind) };
  }
  const kind: ShellKind = 'cmd';
  return { file: join(root, 'System32', 'cmd.exe'), args: shellArgs(kind), kind, name: shellLabel(kind) };
}

import type { IPty, IPtyForkOptions } from 'node-pty';

type PtySpawn = (file: string, args: string[], opts: IPtyForkOptions) => IPty;

async function loadPty(): Promise<{ spawn: PtySpawn }> {
  const mod = (await import('node-pty')) as { spawn: PtySpawn; default?: { spawn: PtySpawn } };
  return mod.default ?? mod;
}

export class NodePtyAdapter implements TerminalProvider {
  constructor(
    /** 缺省自动探测；显式传入便于测试 */
    private readonly shell: DetectedShell = detectShell(),
  ) {}

  get shellName(): string {
    return this.shell.name;
  }

  get shellKind(): ShellKind {
    return this.shell.kind;
  }

  async create(opts: { cwd: string; env?: Record<string, string> }): Promise<TerminalSession> {
    const pty = await loadPty();
    const session = pty.spawn(this.shell.file, this.shell.args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
    });
    const listeners: ((chunk: string) => void)[] = [];
    const exitListeners: ((code: number) => void)[] = [];
    session.onData((d: string) => {
      for (const cb of listeners) cb(d);
    });
    session.onExit(({ exitCode }: { exitCode: number }) => {
      for (const cb of exitListeners) cb(exitCode);
    });
    return {
      write: (data: string) => session.write(data),
      resize: (cols: number, rows: number) => {
        try {
          session.resize(Math.max(cols, 4), Math.max(rows, 2));
        } catch { /* 进程已退出：忽略 */ }
      },
      onData: (cb) => listeners.push(cb),
      onExit: (cb) => exitListeners.push(cb),
      kill: () => {
        try {
          session.kill();
        } catch { /* 已退出 */ }
      },
    };
  }
}

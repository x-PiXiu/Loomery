// 分级日志（shell 主进程）：按日滚动文件 + 启动清理过期日志
// 设计约束：日志失败绝不影响主流程（所有方法吞错）
import { appendFileSync, existsSync, readdirSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;
const RETENTION_DAYS = 14;

export class FileLogger {
  constructor(
    private readonly dir: string,
    private readonly minLevel: Level = 'info',
  ) {}

  private file(): string {
    const d = new Date();
    return join(this.dir, 'app-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '.log');
  }

  log(level: Level, message: string): void {
    if (LEVELS[level] < LEVELS[this.minLevel]) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.file(), new Date().toISOString() + ' [' + level + '] ' + message + '\n', 'utf8');
    } catch { /* 日志失败不影响主流程 */ }
  }

  debug(message: string): void { this.log('debug', message); }
  info(message: string): void { this.log('info', message); }
  warn(message: string): void { this.log('warn', message); }
  error(message: string): void { this.log('error', message); }

  /** 启动清理：删除超过保留期的滚动日志（仅限本目录的 app-*.log） */
  cleanup(keepDays = RETENTION_DAYS): void {
    try {
      if (!existsSync(this.dir)) return;
      const cutoff = Date.now() - keepDays * 86_400_000;
      for (const name of readdirSync(this.dir)) {
        if (!/^app-\d{8}\.log$/.test(name)) continue;
        const p = join(this.dir, name);
        if (statSync(p).mtimeMs < cutoff) rmSync(p);
      }
    } catch { /* 清理失败不影响主流程 */ }
  }
}

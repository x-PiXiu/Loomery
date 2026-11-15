// 工作区外部变更 watcher（#7）：agent 编辑期间用户在外部改同一文件时的可见性基础设施。
// fs.watch 递归（Windows/macOS 支持）→ 300ms 去抖合批 → 上层决定通知/记录。
// 注意：agent 自己的写盘也会触发 watcher——上层用"最近 agent 写过/回滚过的路径"抑制表过滤（false positive 防线）。
import { watch, type FSWatcher } from 'node:fs';
import { join, normalize } from 'node:path';

/** 缺省忽略：构建产物/依赖/版本库/应用自身数据域 */
export function defaultIgnore(p: string): boolean {
  const n = normalize(p).toLowerCase();
  if (/\.(tmp|log|lock)$/.test(n)) return true;
  return /(^|[\\/])(node_modules|\.git|dist|out|coverage|\.loomery|\.next|target)([\\/]|$)/.test(n);
}

export class WorkspaceWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  /** 路径 → 最近一次原始触发时刻（去抖窗口判定用） */
  private readonly pending = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    /** 去抖后的合批回调（只含未被抑制的外部变更，绝对路径） */
    private readonly onChanges: (paths: string[]) => void,
    /** 抑制表查询：返回 true 表示该路径的此次变更不视为外部修改（agent 刚写过） */
    private readonly suppressed: (path: string) => boolean = () => false,
    private readonly ignore: (p: string) => boolean = defaultIgnore,
    /** 去抖窗口（ms）：写盘事件风暴合批；也留给 agent 写入的 toolExecuted 事件到达时间 */
    private readonly debounceMs = 350,
  ) {}

  /** 监听一组工作区根（重复调用 = 重挂，幂等） */
  start(roots: string[]): void {
    this.stop();
    this.closed = false;
    for (const root of roots) {
      try {
        const w = watch(root, { recursive: true }, (_event, fileName) => {
          if (!fileName || this.closed) return;
          const p = normalize(join(root, fileName));
          if (this.ignore(p)) return;
          this.pending.set(p, Date.now());
          clearTimeout(this.timer);
          this.timer = setTimeout(() => void this.flush(), this.debounceMs);
        });
        w.on('error', () => { /* root 被删/权限：静默，下次 start 重挂 */ });
        this.watchers.set(root, w);
      } catch { /* root 不存在：跳过 */ }
    }
  }

  stop(): void {
    this.closed = true;
    clearTimeout(this.timer);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    this.pending.clear();
  }

  private flush(): void {
    if (this.pending.size === 0) return;
    // 抑制判定完全交给查询函数（agent 写入抑制表自带新鲜度窗口），watcher 不持语义
    const external: string[] = [];
    for (const [p] of this.pending) {
      if (!this.suppressed(p)) external.push(p);
    }
    this.pending.clear();
    if (external.length > 0) this.onChanges(external);
  }
}

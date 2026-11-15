// 全局并发闸（#8）：N 个任务并发 busy 时限制同时打模型 API 的流数——429 靠全局上限而不只单请求 backoff。
// FIFO 公平排队；abort 感知（排队中被取消 → 立即以 AbortError 出队，不占名额不唤醒后手忙脚乱）。
export class Semaphore {
  private inFlight = 0;
  private readonly waiters: Array<{
    ok: (release: () => void) => void;
    fail: (err: Error) => void;
  }> = [];

  constructor(private readonly limit: number) {}

  /** 当前压力（在流 + 排队），观测用 */
  get load(): number {
    return this.inFlight + this.waiters.length;
  }

  /** 取一个名额；返回释放函数。signal 已中止或排队期间被中止 → 抛 AbortError */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError();
    if (this.inFlight < this.limit) {
      this.inFlight += 1;
      return () => this.release();
    }
    return new Promise<() => void>((ok, fail) => {
      const onAbort = (): void => waiter.fail(abortError());
      const waiter = {
        ok: (release: () => void): void => {
          detach();
          ok(release);
        },
        fail: (err: Error): void => {
          detach();
          fail(err);
        },
      };
      const detach = (): void => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        signal?.removeEventListener('abort', onAbort);
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private release(): void {
    this.inFlight -= 1;
    const next = this.waiters.shift();
    if (next) {
      this.inFlight += 1;
      next.ok(() => this.release());
    }
  }
}

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

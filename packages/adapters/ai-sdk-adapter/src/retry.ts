// 05 §8 重试策略：网络类/429/5xx 指数退避重试，每次发 retrying 事件
export function isRetryable(err: unknown): boolean {
  const msg = errorMessage(err);
  return /\b(429|500|502|503|504)\b|timeout|timed?\s?out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EACCES|rate.?limit|overloaded|cannot connect|fetch failed|network|internal_error|internal server error|please retry/i.test(msg);
}

/** 取错误消息（含 cause 链——AI SDK 连接失败的细节在 cause 里） */
export function errorMessage(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 4; depth++) {
    parts.push(cur instanceof Error ? cur.message : String(cur));
    cur = (cur as { cause?: unknown }).cause;
  }
  const msg = parts.join(' ← ').trim();
  return msg.length > 0 ? msg : String(err);
}

export function backoffMs(attempt: number): number {
  return 500 * 2 ** attempt + Math.floor(Math.random() * 250);
}

export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      },
      { once: true },
    );
  });
}

// ADR-0008：事件溯源——所有 LoopEvent 追加写入 MemoryStore；落盘失败不拖垮主流程
import type { EventSink } from '@loomery/ports';
import type { LoopEvent } from '@loomery/domain';

export class JournalSink implements EventSink {
  constructor(private readonly store: {
    appendEvent(threadId: string, event: LoopEvent): Promise<void>;
  }) {}

  publish(event: LoopEvent): void {
    void this.store.appendEvent(event.threadId, event).catch((err: unknown) => {
      console.error('[journal] 事件落盘失败:', err);
    });
  }
}

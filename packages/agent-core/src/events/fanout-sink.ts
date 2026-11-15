// ADR-0014：EventSink 扇出点统一分配 seq/id/ts，再转发给全部下游（渲染转发、日志落盘）
import { randomUUID } from 'node:crypto';
import { EVENT_SCHEMA_VERSION, type EventType, type LoopEvent, type LoopEventPayloads } from '@loomery/domain';
import type { Clock, EventSink } from '@loomery/ports';

/** 生产者提交的"事件草稿"：不带 seq/id/ts（扇出点补齐） */
export interface EventDraft<T extends EventType = EventType> {
  threadId: string;
  turnId?: string;
  step?: number;
  type: T;
  payload: LoopEventPayloads[T];
}

export type EmitFn = <T extends EventType>(type: T, payload: LoopEventPayloads[T]) => void;

export interface ScopedEmit extends EmitFn {
  withStep(step: number): EmitFn;
}

export class FanoutSink implements EventSink {
  private readonly seqByThread = new Map<string, number>();

  constructor(
    private readonly downstream: EventSink[],
    private readonly clock: Clock,
  ) {}

  publish(event: LoopEvent): void {
    for (const sink of this.downstream) sink.publish(event);
  }

  /** 生产者入口：补齐信封后扇出 */
  emit<T extends EventType>(draft: EventDraft<T>): LoopEvent {
    const seq = (this.seqByThread.get(draft.threadId) ?? 0) + 1;
    this.seqByThread.set(draft.threadId, seq);
    const event = {
      seq,
      id: randomUUID(),
      schemaVersion: EVENT_SCHEMA_VERSION,
      ts: this.clock.now(),
      threadId: draft.threadId,
      ...(draft.turnId !== undefined && { turnId: draft.turnId }),
      ...(draft.step !== undefined && { step: draft.step }),
      type: draft.type,
      payload: draft.payload,
    } as LoopEvent;
    this.publish(event);
    return event;
  }

  /** 绑定 thread/turn/step 上下文的便捷发射器 */
  scoped(base: { threadId: string; turnId?: string }): ScopedEmit {
    const scopedEmit = <T extends EventType>(type: T, payload: LoopEventPayloads[T]): void => {
      this.emit({ ...base, type, payload });
    };
    const withStep = (step: number): EmitFn => {
      return <T extends EventType>(type: T, payload: LoopEventPayloads[T]): void => {
        this.emit({ ...base, step, type, payload });
      };
    };
    return Object.assign(scopedEmit, { withStep }) as ScopedEmit;
  }

  /** 重置某线程的 seq（重放恢复后由 session 调用） */
  resetSeq(threadId: string, next = 0): void {
    this.seqByThread.set(threadId, next);
  }
}

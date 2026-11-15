import { describe, expect, it, vi } from 'vitest';
import { JournalSink } from './journal';
import { InMemoryStore } from '../testing/fakes';
import type { LoopEvent } from '@loomery/domain';

const base = { threadId: 't1', seq: 1, id: 'e1', schemaVersion: 1 as const, ts: 0 };

const ev = {
  ...base,
  type: 'threadCreated',
  payload: { threadId: 't1', title: 'x' },
} as LoopEvent;

describe('JournalSink（ADR-0008 事件溯源）', () => {
  it('所有事件转发 appendEvent', async () => {
    const store = new InMemoryStore();
    const sink = new JournalSink(store);
    sink.publish(ev);
    await Promise.resolve();
    expect(store.events).toHaveLength(1);
  });

  it('appendEvent 失败不抛出、不拖垮主流程', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new InMemoryStore();
    store.failAppend = true;
    const sink = new JournalSink(store);
    expect(() => sink.publish(ev)).not.toThrow();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(errSpy).toHaveBeenCalled();
        errSpy.mockRestore();
        resolve();
      }, 10);
    });
  });
});

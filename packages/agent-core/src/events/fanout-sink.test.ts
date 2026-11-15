import { describe, expect, it } from 'vitest';
import { FanoutSink } from './fanout-sink';
import { FakeClock, RecordingSink } from '../testing/fakes';

describe('FanoutSink（ADR-0014 seq 单点分配）', () => {
  it('按线程独立递增 seq，并补齐 id/ts/schemaVersion', () => {
    const a = new RecordingSink();
    const sink = new FanoutSink([a], new FakeClock());
    sink.emit({ threadId: 't1', type: 'stepStarted', payload: { step: 1 } });
    sink.emit({ threadId: 't1', type: 'stepStarted', payload: { step: 2 } });
    sink.emit({ threadId: 't2', type: 'threadCreated', payload: { threadId: 't2', title: 'x' } });
    const [e1, e2, e3] = a.events;
    expect(e1?.seq).toBe(1);
    expect(e2?.seq).toBe(2);
    expect(e3?.seq).toBe(1); // t2 独立计数
    expect(e1?.schemaVersion).toBe(1);
    expect(e1?.ts).toBe(1_000_000);
    expect(e1?.id).toBeTruthy();
  });

  it('扇出到全部下游且为同一事件对象', () => {
    const a = new RecordingSink();
    const b = new RecordingSink();
    const sink = new FanoutSink([a, b], new FakeClock());
    const ev = sink.emit({ threadId: 't1', type: 'stepStarted', payload: { step: 1 } });
    expect(a.events[0]).toBe(ev);
    expect(b.events[0]).toBe(ev);
  });

  it('turnId/step 可选注入；scoped 发射器绑定上下文', () => {
    const a = new RecordingSink();
    const sink = new FanoutSink([a], new FakeClock());
    const emit = sink.scoped({ threadId: 't1', turnId: 'u1' });
    emit('turnStarted', { turnId: 'u1', mode: 'edit', model: 'm', userMessageId: 'x' });
    emit.withStep(3)('stepStarted', { step: 3 });
    expect(a.events[0]?.turnId).toBe('u1');
    expect(a.events[1]?.step).toBe(3);
    expect(a.events[1]?.turnId).toBe('u1');
  });

  it('resetSeq 支持重放恢复后续接计数', () => {
    const a = new RecordingSink();
    const sink = new FanoutSink([a], new FakeClock());
    sink.resetSeq('t1', 100);
    sink.emit({ threadId: 't1', type: 'stepStarted', payload: { step: 1 } });
    expect(a.events[0]?.seq).toBe(101);
  });
});

// 测试基建（08 §4 测试策略：端口替换单测的公共假件）
import type {
  ApprovalDecision, ApprovalRequester, ApprovalSpec, Clock, EventSink,
  MemoryStore, ModelClient, ModelRequest, ModelStreamEvent,
} from '@loomery/ports';
import type { LoopEvent, LoopEventPayloads, MemoryFact, Thread } from '@loomery/domain';

export class FakeClock implements Clock {
  private current = 1_000_000;

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/** 脚本化假模型：每次 stream 消费一段脚本 */
export class FakeModel implements ModelClient {
  private scripts: ModelStreamEvent[][];

  onStream?: (req: ModelRequest) => void;

  constructor(...scripts: ModelStreamEvent[][]) {
    this.scripts = [...scripts];
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.onStream?.(req);
    const script = this.scripts.shift();
    if (!script) throw new Error('FakeModel: 测试脚本耗尽');
    for (const ev of script) {
      if (req.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      await Promise.resolve();
      yield ev;
    }
  }

  get remaining(): number {
    return this.scripts.length;
  }
}

export class FakeApprovals implements ApprovalRequester {
  calls: ApprovalSpec[] = [];

  constructor(
    public decide: (spec: ApprovalSpec, index: number) => ApprovalDecision = () => ({ kind: 'approved' }),
  ) {}

  async request(spec: ApprovalSpec, _signal: AbortSignal): Promise<ApprovalDecision> {
    this.calls.push(spec);
    return this.decide(spec, this.calls.length - 1);
  }
}

export class RecordingSink implements EventSink {
  events: LoopEvent[] = [];

  publish(event: LoopEvent): void {
    this.events.push(event);
  }

  types(): string[] {
    return this.events.map((e) => e.type);
  }

  of<T extends LoopEvent['type']>(type: T): LoopEventPayloads[T][] {
    const found = this.events.filter((e) => e.type === type);
    return found.map((e) => e.payload) as LoopEventPayloads[T][];
  }
}

export class InMemoryStore implements MemoryStore {
  events: LoopEvent[] = [];
  facts: MemoryFact[] = [];
  failAppend = false;

  async appendEvent(_threadId: string, event: LoopEvent): Promise<void> {
    if (this.failAppend) throw new Error('disk full');
    this.events.push(event);
  }

  async loadEvents(threadId: string): Promise<LoopEvent[]> {
    return this.events.filter((e) => e.threadId === threadId);
  }

  async deleteThread(threadId: string): Promise<void> {
    this.events = this.events.filter((e) => e.threadId !== threadId);
  }

  async rewriteEvents(threadId: string, events: LoopEvent[]): Promise<void> {
    this.events = [...this.events.filter((e) => e.threadId !== threadId), ...events];
  }

  async saveFact(fact: MemoryFact): Promise<void> {
    this.facts.push(fact);
  }

  async queryFacts(_query: string, limit: number): Promise<MemoryFact[]> {
    return this.facts.slice(0, limit);
  }

  async listThreads(): Promise<Thread[]> {
    return [];
  }
}

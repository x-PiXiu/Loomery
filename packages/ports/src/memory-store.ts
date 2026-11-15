// ADR-0003/0008：状态只持久化在 session（事件溯源），存储介质可替换
import type { LoopEvent, MemoryFact, Thread } from '@loomery/domain';

export interface MemoryStore {
  /** 事件溯源日志（JSONL/SQLite 均为实现细节） */
  appendEvent(threadId: string, event: LoopEvent): Promise<void>;
  loadEvents(threadId: string): Promise<LoopEvent[]>;
  /** 删除会话日志（用户删除任务；checkpoint 不随之删除） */
  deleteThread(threadId: string): Promise<void>;
  saveFact(fact: MemoryFact): Promise<void>;
  queryFacts(query: string, limit: number): Promise<MemoryFact[]>;
  /** ADR-0021：任务级条目记忆（事件溯源读模型）；可选——实现未迁移完时召回侧自行降级 */
  queryTaskFacts?(threadId: string, query: string, limit: number): Promise<MemoryFact[]>;
  /** 存储 GC：整文件原子替换为重放等价的事件流（内核算好等价流，实现只管落盘）；可选——缺省不 GC */
  rewriteEvents?(threadId: string, events: LoopEvent[]): Promise<void>;
  listThreads(): Promise<Thread[]>;
}

// ADR-0012：长期记忆召回以 ContextProvider 身份注册进装配管道（context 与 memory 零耦合）
import { estimateTokens } from '@loomery/domain';
import type { ContextChunk, ContextProvider, ContextProviderCtx, MemoryStore } from '@loomery/ports';

export class MemoryRecallProvider implements ContextProvider {
  readonly id = 'memory-recall';

  /** 记忆属于高价值小上下文：priority 仅次于安全类声明 */
  readonly priority = 2;

  private lastReported: string[] = [];

  constructor(
    private readonly store: MemoryStore,
    private readonly topK = 5,
  ) {}

  async provide(ctx: ContextProviderCtx): Promise<ContextChunk | null> {
    if (!ctx.latestUserMessage) return null;
    // ADR-0021：任务级事实优先（pinned 恒前），全局事实补足去重
    const taskFacts = this.store.queryTaskFacts
      ? await this.store.queryTaskFacts(ctx.threadId, ctx.latestUserMessage, this.topK)
      : [];
    const globalFacts = await this.store.queryFacts(ctx.latestUserMessage, this.topK);
    const seen = new Set(taskFacts.map((f) => f.content));
    const facts = [...taskFacts, ...globalFacts.filter((f) => !seen.has(f.content))].slice(0, this.topK);
    if (facts.length === 0) return null;
    // ADR-0021 召回可解释性：上报本轮引用的记忆（内容变化才上报，避免每步刷屏）
    const factIds = facts.map((f) => f.id);
    if (this.lastReported.join('|') !== factIds.join('|')) {
      this.lastReported = factIds;
      ctx.report?.({ type: 'memoryRecalled', payload: { factIds, previews: facts.map((f) => f.content) } });
    }
    const text = '## 长期记忆（📌=本任务钉住；其余为提炼/跨会话）\n' + facts.map((f) => '- ' + (f.source === 'user-pinned' ? '📌 ' : '') + f.content).join('\n');
    return {
      providerId: this.id,
      priority: this.priority,
      tokens: estimateTokens(text),
      text,
    };
  }
}

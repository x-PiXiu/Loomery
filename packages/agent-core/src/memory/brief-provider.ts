// ADR-0021：任务简报以 ContextProvider 身份每轮注入（≤3k tokens 超限截断）；pinned 语义=仲裁永不裁
import { estimateTokens } from '@loomery/domain';
import type { BriefStore, ContextChunk, ContextProvider, ContextProviderCtx } from '@loomery/ports';

const BRIEF_TOKEN_CAP = 3000;

export class BriefProvider implements ContextProvider {
  readonly id = 'task-brief';
  /** 简报是任务常驻记忆：priority 最高档，且 pinned（仲裁永不裁） */
  readonly priority = 1;

  constructor(private readonly briefs: BriefStore) {}

  async provide(ctx: ContextProviderCtx): Promise<ContextChunk | null> {
    const brief = await this.briefs.read(ctx.threadId);
    if (!brief || brief.content.trim().length === 0) return null;
    let text = '## 任务简报（每轮自动注入的常驻记忆，维护它=维护任务状态）\n' + brief.content;
    if (estimateTokens(text) > BRIEF_TOKEN_CAP) {
      text = text.slice(0, BRIEF_TOKEN_CAP * 4) + '\n…[简报过长已截断，请用 brief_write 精简]';
    }
    return {
      providerId: this.id,
      priority: this.priority,
      tokens: estimateTokens(text),
      text,
      pinned: true,
    };
  }
}

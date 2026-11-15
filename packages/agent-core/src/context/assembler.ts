// 05 §5 ContextAssembler：system 组装 + Provider 扇入 + token 预算分配
// 注意：长期记忆以 provider 身份注册（ADR-0012），本模块不直接依赖 memory
import { IMAGE_TOKEN_ESTIMATE, type AgentMode, arbitrateContributions, estimateTokens } from '@loomery/domain';
import type { ContextChunk, ContextProvider, ContextProviderCtx } from '@loomery/ports';

export interface AssembleInput {
  threadId: string;
  mode: AgentMode;
  systemBase: string;
  latestUserMessage?: string;
  /** 历史消息（容量分类统计用，不进入 system） */
  messages?: { parts: { kind: string }[] }[];
  /** 已注册工具规格（容量分类统计用） */
  tools?: { name: string }[];
  /** 本任务的路径域（多项目）：注入 system 权威压制记忆里的过时工作区路径 */
  workspaceRoots?: string[];
  /** 预算余量提示（12 Fix D：模型每步知道还剩几步，接近上限时优先收尾而非被熔断） */
  budgetHint?: string;
  /** docs/15：完成审计/证据门的 nudge（不进对话转录，随 system 注入——与 budgetHint 同通道惯例） */
  completionNudge?: string;
  /** ADR-0021：贡献者 side-channel 上报（如 memoryRecalled）→ 事件总线（弱类型桥接） */
  emit?: (type: string, payload: unknown) => void;
}

export interface AssembleResult {
  system: string;
  providers: { id: string; tokens: number }[];
  totalTokens: number;
  dropped: string[];
  /** 容量分类：消息/系统提示词/工具/其他（事件 payload 用） */
  breakdown: { messages: number; system: number; tools: number; other: number };
}

export class ContextAssembler {
  constructor(
    private readonly providers: ContextProvider[],
    /** 上下文贡献者的 token 总预算（窗口 − 输出预留 − 历史消息占用） */
    private readonly budgetTokens: number,
  ) {}

  async assemble(input: AssembleInput): Promise<AssembleResult> {
    const ctx: ContextProviderCtx = {
      threadId: input.threadId,
      mode: input.mode,
      ...(input.latestUserMessage !== undefined && { latestUserMessage: input.latestUserMessage }),
      ...(input.workspaceRoots && input.workspaceRoots.length > 0 ? { workspaceRoots: input.workspaceRoots } : {}),
      ...(input.emit ? { report: (draft: { type: string; payload: unknown }) => input.emit!(draft.type, draft.payload) } : {}),
    };
    const settled = await Promise.all(
      this.providers.map(async (p) => ({ id: p.id, chunk: await safeProvide(p, ctx) })),
    );
    const chunks = settled
      .filter((r): r is { id: string; chunk: ContextChunk } => r.chunk !== null)
      .map((r) => r.chunk)
      .sort((a, b) => a.priority - b.priority);

    // ADR-0021：仲裁下沉 domain 纯函数——pinned 贡献者永不裁，超预算按 priority 大者先裁
    const verdict = arbitrateContributions(
      chunks.map((c) => ({ id: c.providerId, tokens: c.tokens, priority: c.priority, pinned: c.pinned === true })),
      this.budgetTokens,
    );
    const keptSet = new Set(verdict.kept);
    const kept = chunks.filter((c) => keptSet.has(c.providerId));
    const dropped = verdict.dropped;
    const total = verdict.keptTokens;
    // 工作区权威段放在 system 末尾（对记忆注入形成「最后发言权」）：
    // agent 引用过时路径被护栏拦截的根因 = 记忆先于环境（用户切项目后全局记忆仍指向旧根）
    const wsSection = (input.workspaceRoots ?? []).length > 0
      ? '\n\n[当前任务工作区] 根目录：' + input.workspaceRoots!.join(' ; ') + '\n所有文件路径必须位于上述目录内；相对路径以第一个根为基准解析。记忆或历史中出现的其他路径可能属于别的项目或已过时，一律以本节为准。'
      : '';
    // 预算余量段（实证：模型不知道余量 → 25 步全烧在读文档上 → maxSteps 熔断，一步未写）
    const budgetSection = input.budgetHint ? '\n\n' + input.budgetHint : '';
    // docs/15：完成审计/证据门的 nudge 段（与 budgetHint 同通道——system 注入，不进对话转录）
    const nudgeSection = input.completionNudge ? '\n\n' + input.completionNudge : '';
    const system = [input.systemBase, ...kept.map((c) => c.text)].join('\n\n') + wsSection + budgetSection + nudgeSection;
    const messagesTokens = (input.messages ?? []).reduce(
      (sum, m) =>
        sum +
        m.parts.reduce((acc: number, part) => {
          // docs/16：图像部件固定视觉估值（base64 按字符估会虚增 50 倍 → 错误驱逐历史）
          if ((part as { kind?: string }).kind === 'image') return acc + IMAGE_TOKEN_ESTIMATE;
          return acc + estimateTokens(JSON.stringify(part));
        }, 0),
      0,
    );
    const systemTokens = estimateTokens(system);
    const toolsTokens = estimateTokens(JSON.stringify(input.tools ?? []));
    return {
      system,
      providers: kept.map((c) => ({ id: c.providerId, tokens: c.tokens })),
      totalTokens: total,
      dropped,
      breakdown: {
        messages: messagesTokens,
        system: systemTokens,
        tools: toolsTokens,
        other: Math.max(0, total - messagesTokens - systemTokens - toolsTokens),
      },
    };
  }
}

async function safeProvide(p: ContextProvider, ctx: ContextProviderCtx): Promise<ContextChunk | null> {
  try {
    return await p.provide(ctx);
  } catch (err) {
    // 单个 provider 失败不拖垮装配（可在事件时间线中观察）
    console.error(`[context] provider ${p.id} 失败:`, err);
    return null;
  }
}

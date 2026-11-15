// 05 §5 / ADR-0021：上下文贡献者仲裁——超预算时的裁剪优先级（domain 纯函数，可测可审计）
// 裁剪序：非 pinned 中 priority 最大者先裁；pinned（含系统基础段）永不裁。

export interface Contribution {
  id: string;
  tokens: number;
  /** 越小越优先保留（与 ContextChunk.priority 同语义） */
  priority: number;
  /** pinned 贡献者（用户钉住的事实/系统基础段）永不裁 */
  pinned?: boolean;
}

export interface ArbitrationResult {
  kept: string[];
  dropped: string[];
  keptTokens: number;
}

export function arbitrateContributions(contributions: Contribution[], budgetTokens: number): ArbitrationResult {
  const sorted = [...contributions].sort((a, b) => a.priority - b.priority);
  const kept: string[] = [];
  const dropped: string[] = [];
  let total = 0;
  for (const c of sorted) {
    if (c.pinned) {
      kept.push(c.id);
      total += c.tokens;
      continue;
    }
    if (total + c.tokens <= budgetTokens) {
      kept.push(c.id);
      total += c.tokens;
    } else {
      dropped.push(c.id);
    }
  }
  return { kept, dropped, keptTokens: total };
}

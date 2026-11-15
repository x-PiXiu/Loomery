// docs/15 升级 B 机器证据门：证据是内核记录的"事实"（run_command 退出码 / preview console 错误数），
// 与模型的"声明"（task_complete.verification）严格分离——终止裁决输入必须有机器可验证的事实背书。
// 实体层纯类型+纯函数，零 I/O（整洁架构：事实与声明的核对规则属业务规则）。

/** 证据种类：command=shell 命令（退出码判定）；preview=HTML 预览 console；test=测试类命令（预留） */
export type EvidenceKind = 'command' | 'preview' | 'test';

/** 单条机器证据（handler 自带，经 ToolResult.evidence 侧通道回传循环记账） */
export interface ToolEvidence {
  kind: EvidenceKind;
  /** 机器判定：退出码===0 / console 零错误 */
  ok: boolean;
  /** 一行摘要（进审计提示词） */
  detail: string;
}

/** 循环内证据账本条目（ToolEvidence + 步号） */
export interface EvidenceEntry extends ToolEvidence {
  atStep: number;
}

export const MAX_EVIDENCE_ENTRIES = 50;

/** 证据账本 → 审计提示词段落（cap 40 条，失败优先展示——审计最需要看的就是失败） */
export function evidenceLedgerDigest(entries: EvidenceEntry[]): string {
  if (entries.length === 0) return '（本轮无命令/预览执行记录）';
  const sorted = [...entries].sort((a, b) => Number(a.ok) - Number(b.ok)); // 失败在前
  const lines = sorted.slice(0, 40).map((e) => `- [${e.ok ? '成功' : '失败'}] step${e.atStep} ${e.kind}: ${e.detail}`);
  if (sorted.length > 40) lines.push(`- …（其余 ${sorted.length - 40} 条略）`);
  const okCount = entries.filter((e) => e.ok).length;
  return `机器证据（内核记录，非模型自述）：命令/预览共 ${entries.length} 次，成功 ${okCount} 次、失败 ${entries.length - okCount} 次：\n${lines.join('\n')}`;
}

/** 声明中的"验证性词汇"——出现即认为模型做出了验证声明（需证据背书） */
const VERIFICATION_WORDS = ['测试', '编译', '构建', '验证', '运行通过', 'check', 'test', 'build', 'compile', 'lint', 'verify'] as const;

/** 否定短语：诚实留白（"无需验证"）不构成声明——否则纯讨论/文案类任务会被证据门误拦 */
const NEGATION_PHRASES = ['无需验证', '不需要验证', '无需测试', '无需编译', '无需构建', '无需运行', '未要求验证', 'no verification', 'not verified'] as const;

function claimsVerification(verification: string): boolean {
  const lower = verification.toLowerCase();
  if (NEGATION_PHRASES.some((n) => lower.includes(n))) return false;
  return VERIFICATION_WORDS.some((w) => lower.includes(w));
}

export interface VerificationBackedCheck {
  /** true=声明有机器证据背书（或未做验证声明） */
  backed: boolean;
  reason?: string;
}

/**
 * 交叉核对（内核机械判定，语义匹配交给审计模型）：
 * 声明了验证（verification 含验证性词汇）但本轮证据账本里没有任何成功记录 → 未背书。
 * 注意"零工具轮"（纯问答）不进此判定——调用方在 loop 里已按步数/工具数跳过。
 */
export function checkVerificationBacked(verification: string, ledger: EvidenceEntry[]): VerificationBackedCheck {
  if (!claimsVerification(verification)) return { backed: true };
  const okCount = ledger.filter((e) => e.ok).length;
  if (okCount === 0) {
    return { backed: false, reason: '声明了验证（如"测试通过/编译成功"），但本轮没有任何成功的命令或预览执行记录' };
  }
  return { backed: true };
}

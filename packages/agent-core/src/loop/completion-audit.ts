// docs/15 机制二：完成审计（批判者）——模型自然终止时，cheap 档对照"用户请求 vs 机器证据"裁决是否真完成。
// 用例层：digest 组装用纯函数（可测），模型调用走 ModelPort cheap 档（与 degrade 同构，无新端口）。
// fail-open：审计自身出错=放行（收尾失败比误放行代价对称性更差——被冤枉的任务会烧满预算）。
import type { AuditVerdict, EvidenceEntry, PlanStep } from '@loomery/domain';
import { evidenceLedgerDigest, parseAuditVerdict } from '@loomery/domain';
import { COMPLETION_AUDIT_SYSTEM } from '../prompts';
import type { ChatMessage } from '@loomery/domain';
import type { ModelClient } from '@loomery/ports';

export interface CompletionAuditInput {
  /** 用户原始请求（本轮 latestUserText） */
  userRequest: string;
  /** 计划快照（本轮 planUpdate 侧通道缓存；无计划=undefined） */
  plan?: PlanStep[];
  /** 机器证据账本（docs/15 升级 B：内核记录的命令/预览事实） */
  evidence: EvidenceEntry[];
  /** 已写文件清单（diffProposal 路径去重） */
  filesTouched: string[];
  /** 已消耗步数（审计员知道工作量规模） */
  stepsUsed: number;
}

const MAX_AUDIT_TOKENS = 600;
void MAX_AUDIT_TOKENS; // 审计输出长度由模型层自辖；保留常量供后续 cap 引用

export function buildAuditPrompt(input: CompletionAuditInput): string {
  const planSection = input.plan && input.plan.length > 0
    ? `\n[任务计划]\n${input.plan.map((s) => `- ${s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '▶' : s.status === 'failed' ? '✗' : '○'} ${s.title}`).join('\n')}`
    : '';
  const filesSection = input.filesTouched.length > 0 ? `\n[写过的文件]\n${input.filesTouched.slice(0, 30).join('\n')}` : '';
  return [
    `你是完成审计员。Agent 声称任务可以结束，请对照以下材料裁决它是否真的完成了用户请求。`,
    ``,
    `[用户请求]\n${input.userRequest.slice(0, 2000)}`,
    planSection,
    filesSection,
    ``,
    evidenceLedgerDigest(input.evidence),
    ``,
    `[工作量] ${input.stepsUsed} 步`,
    ``,
    `裁决标准：用户请求的核心目标是否已达成（遗留项是否影响核心目标、验证是否有机器证据支撑）。`,
    `只输出 JSON（不要多余文字）：{"complete": true|false, "missing": ["未完成事项", ...]}`,
    `complete=false 时 missing 必须具体（引用计划步骤/用户请求原文），complete=true 时 missing 为空数组。`,
  ].filter(Boolean).join('\n');
}

/**
 * 执行完成审计。返回 undefined = 审计不可用/失败（fail-open，调用方直接放行收尾）。
 * cheap 档零工具流式调用（与 degrade 同构）；abort 信号透传，用户取消时立即失败放行。
 */
export async function runCompletionAudit(model: ModelClient, input: CompletionAuditInput, signal: AbortSignal): Promise<AuditVerdict | undefined> {
  try {
    const chunks: string[] = [];
    const message: ChatMessage = {
      id: 'audit-' + input.stepsUsed,
      role: 'user',
      parts: [{ kind: 'text', text: buildAuditPrompt(input) }],
      createdAt: Date.now(),
    };
    for await (const ev of model.stream({
      modelTier: 'cheap',
      system: COMPLETION_AUDIT_SYSTEM,
      messages: [message],
      tools: [],
      signal,
    })) {
      if (ev.type === 'text-delta') chunks.push(ev.text);
      if (ev.type === 'finish' && ev.finishReason === 'error') return undefined;
    }
    return parseAuditVerdict(chunks.join(''));
  } catch {
    return undefined;
  }
}

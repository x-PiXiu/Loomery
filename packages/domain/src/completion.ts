// docs/15 agent 自主完成协议：完成声明（task_complete 自评）+ 完成审计裁决——实体层纯类型+校验。
// "要不要停"是模型的智能判断；本模块只给判断一个结构化通道，机械三闸（steps/tokens/wall）仍是保底。

import { checkVerificationBacked, type EvidenceEntry } from './evidence';

/** task_complete 载荷：模型的结构化完成自评（SWE-agent submit / OpenHands finish 同构） */
export interface CompletionSelfReport {
  /** 完成了什么（1-3 句，成为本轮最终答复的基调） */
  summary: string;
  /** 遗留项/未完成项/已知限制（空=无遗留） */
  outstanding: string[];
  /** 采取过的验证（编译/测试/preview console 检查……；无则说明为何无需）——内核与证据账本交叉核对 */
  verification: string;
  confidence: 'high' | 'medium' | 'low';
  /** docs/15 升级 A（SWE-agent/OpenHands 双语义）：complete=任务完成（走证据门）；blocked=无法继续（缺权限/需求矛盾/反复失败，跳过证据门直接收尾，outstanding 必填阻塞原因） */
  outcome: 'complete' | 'blocked';
}

/** 完成审计裁决（cheap 档批判者；docs/15 机制二） */
export interface AuditVerdict {
  complete: boolean;
  /** 未完成事项清单（complete=false 时供 nudge 引用） */
  missing: string[];
}

/** 每轮完成审计上限（Reflexion 教训：反思循环必须有界，否则无限反刍） */
export const MAX_COMPLETION_AUDITS = 2;

/** task_complete 证据门放行上限：未背书声明只阻拦一次，二次声明一律放行（Stop-hook exit-2 语义：阻断+反馈，不无限续命） */
export const MAX_EVIDENCE_GATES = 1;

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()).slice(0, 20) : [];
}

/** 宽松校验：模型输出的 JSON 字段缺省/类型漂移时降级取值，绝不因格式抛错（声明失败=收尾失败，代价不对称） */
export function parseCompletionSelfReport(raw: unknown): CompletionSelfReport | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  if (summary.length === 0) return undefined;
  const confidence = o.confidence === 'low' || o.confidence === 'medium' ? o.confidence : 'high';
  return {
    summary: summary.slice(0, 2000),
    outstanding: asStringArray(o.outstanding),
    verification: typeof o.verification === 'string' ? o.verification.trim().slice(0, 500) : '',
    confidence,
    outcome: o.outcome === 'blocked' ? 'blocked' : 'complete',
  };
}

/** 证据门判定：验证声明 vs 机器账本（机械部分内核判，语义部分交审计模型） */
export function checkReportEvidence(report: CompletionSelfReport, ledger: EvidenceEntry[]): { backed: boolean; reason?: string } {
  if (report.verification.length === 0) return { backed: true }; // 未声明验证=诚实留白，不拦
  return checkVerificationBacked(report.verification, ledger);
}

/** 审计裁决宽松解析（模型可能带 ```json 围栏或前后缀）——解析失败=undefined（调用方 fail-open） */
export function parseAuditVerdict(text: string): AuditVerdict | undefined {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    const o = JSON.parse(m[0]) as { complete?: unknown; missing?: unknown };
    if (typeof o.complete !== 'boolean') return undefined;
    const missing = Array.isArray(o.missing) ? o.missing.filter((x): x is string => typeof x === 'string').slice(0, 10) : [];
    return { complete: o.complete, missing };
  } catch {
    return undefined;
  }
}

/** 自报 → 观察文本（回灌历史的 tool-result 内容；outstanding 让最终消息自带遗留清单） */
export function selfReportObservation(report: CompletionSelfReport, gateNote?: string): string {
  const lines = [`完成声明已记录（置信度 ${report.confidence}）。`];
  if (report.outstanding.length > 0) lines.push(`遗留：${report.outstanding.join('；')}`);
  if (gateNote) lines.push(gateNote);
  return lines.join('\n');
}

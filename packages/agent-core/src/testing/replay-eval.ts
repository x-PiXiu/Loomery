// 回放评估（eval golden）：事件溯源红利的兑现——真实会话事件流重放 → 状态指纹 → 与 golden 对比。
// 指纹全部哈希化（不存对话原文，真实数据可安全留盘）；时间戳/seq 不进指纹（非语义字段）。
// 用法：scripts/replay-eval.mjs --save 生成 golden；--check 重放对比（内核升级后跑，指纹漂移=行为变化）。
import { createHash } from 'node:crypto';
import type { ChatMessage, LoopEvent } from '@loomery/domain';
import { rebuildThread } from '../session/restore';

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/** 消息指纹：角色 + parts 类别计数 + 文本哈希（截 8 位）——内容敏感、原文不落盘 */
function messageFingerprint(m: ChatMessage): Record<string, unknown> {
  const parts = m.parts.map((p) => {
    if (p.kind === 'text') return { kind: 'text', h: hashText(p.text) };
    if (p.kind === 'summary') return { kind: 'summary', h: hashText(p.text) };
    if (p.kind === 'tool-call') return { kind: 'tool-call', name: p.name };
    if (p.kind === 'tool-result') return { kind: 'tool-result', h: hashText(p.content) };
    if (p.kind === 'image') return { kind: 'image' };
    return { kind: (p as { kind: string }).kind };
  });
  return { role: m.role, parts };
}

/** 线程状态指纹：标题哈希 + 消息/轮次/审批/checkpoint/用量等语义计数 */
export function threadFingerprint(events: LoopEvent[]): Record<string, unknown> {
  const t = rebuildThread(events);
  // 语义态进指纹；turnIds/seq 是传输态——存储 GC（compactForStorage）按设计丢弃被压缩轮的
  // 传输事件，折叠语义等价但轮计数变化，故不入指纹（等价契约见 compact-log.test）
  return {
    title: hashText(t.title),
    workspaceRoot: t.workspaceRoot ?? null,
    messages: t.messages.map(messageFingerprint),
    pendingApprovals: t.pendingApprovalIds.length,
    checkpoints: t.checkpointTurnIds.length,
    usageTokens: t.usageTokens,
  };
}

/** 多线程指纹包（eval golden 文件结构） */
export function corpusFingerprint(threads: Array<{ threadId: string; events: LoopEvent[] }>): string {
  const obj = threads
    .map((t) => ({ threadId: hashText(t.threadId), fp: threadFingerprint(t.events) }))
    .sort((a, b) => (a.threadId < b.threadId ? -1 : 1));
  return JSON.stringify(obj, null, 2);
}

/** golden 对比：返回首个差异的路径（一致返回 null）——逐字段比对，报错可定位 */
export function compareGolden(actual: string, golden: string): string | null {
  if (actual === golden) return null;
  const a = JSON.parse(actual) as unknown[];
  const g = JSON.parse(golden) as unknown[];
  for (let i = 0; i < Math.max(a.length, g.length); i++) {
    const ai = JSON.stringify(a[i]);
    const gi = JSON.stringify(g[i]);
    if (ai !== gi) return `线程 #${i} 指纹漂移\n  golden: ${gi?.slice(0, 200)}\n  actual: ${ai?.slice(0, 200)}`;
  }
  return '线程数不同';
}

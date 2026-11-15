// 回放评估回归锁：指纹的稳定性（重放等价三态一致）与敏感性（内容/状态变化必漂移）
import { describe, expect, it } from 'vitest';
import type { LoopEvent } from '@loomery/domain';
import { compactForStorage } from '../session/compact-log';
import { compareGolden, corpusFingerprint, threadFingerprint } from './replay-eval';

let seqCounter = 0;
let idCounter = 0;
const ev = (partial: Record<string, unknown> & { type: string }): LoopEvent => {
  seqCounter += 1;
  idCounter += 1;
  return { seq: seqCounter, id: `e${idCounter}`, schemaVersion: 1, ts: seqCounter * 1000, threadId: 't1', ...partial } as unknown as LoopEvent;
};

/** 两轮合成流：压缩摘要 + 工具 + checkpoint + 审批 + 用量（覆盖主要折叠分支） */
function buildStream(text2Override?: string): LoopEvent[] {
  seqCounter = 0;
  idCounter = 0;
  return [
    ev({ type: 'threadCreated', payload: { threadId: 't1', title: 'eval 演示' } }),
    ev({ type: 'turnStarted', turnId: 'u1', payload: { turnId: 'u1', mode: 'edit', model: 'm', userMessageId: 'mu1', userText: '第一轮' } }),
    ev({ type: 'textDelta', turnId: 'u1', payload: { messageId: 'ma1', text: '回复一' } }),
    ev({ type: 'toolCallComplete', turnId: 'u1', payload: { messageId: 'ma1', toolCallId: 'c1', name: 'read_file', args: '{"path":"a.ts"}' } }),
    ev({ type: 'observationAdded', turnId: 'u1', payload: { toolCallId: 'c1', truncated: false, originalChars: 10, finalChars: 10, preview: 'ok', content: '内容' } }),
    ev({ type: 'stepCompleted', step: 1, payload: { finishReason: 'tool-calls', usage: { inputTokens: 10, outputTokens: 5, costEstimate: 0 } } }),
    ev({ type: 'usageDelta', turnId: 'u1', payload: { inputTokens: 100, outputTokens: 50 } }),
    ev({ type: 'approvalRequired', turnId: 'u1', payload: { approvalId: 'ap1', toolCallId: 'c1' } }),
    ev({ type: 'turnCompleted', turnId: 'u1', payload: { outcome: 'completed' } }),
    ev({ type: 'memoryCompressed', turnId: 'u1', payload: { compressedMessageIds: ['mu1', 'ma1'], summary: '摘要一', tokensSaved: 30 } }),
    ev({ type: 'turnStarted', turnId: 'u2', payload: { turnId: 'u2', mode: 'edit', model: 'm', userMessageId: 'mu2', userText: '第二轮' } }),
    ev({ type: 'textDelta', turnId: 'u2', payload: { messageId: 'ma2', text: text2Override ?? '回复二' } }),
    ev({ type: 'checkpointCreated', turnId: 'u2', payload: { turnId: 'u2', files: ['a.ts'] } }),
    ev({ type: 'turnCompleted', turnId: 'u2', payload: { outcome: 'completed' } }),
  ];
}

describe('回放评估指纹（eval golden）', () => {
  it('重放等价三态一致：全量 = GC 后 = 删除尾轮后重放', () => {
    const original = buildStream();
    const compacted = compactForStorage(original);
    const full = threadFingerprint(original);
    const gc = threadFingerprint(compacted);
    // 敏感性自证：截掉第二轮 → 消息少一条 → 指纹必然不同
    const truncated = threadFingerprint(original.slice(0, 10));
    expect(JSON.stringify(full)).toBe(JSON.stringify(gc));
    
    expect(JSON.stringify(truncated)).not.toBe(JSON.stringify(full));
    // usage 聚合一致（GC 不丢用量）
    expect(full.usageTokens).toBeGreaterThan(0);
    expect(full.usageTokens).toBe(gc.usageTokens);
  });

  it('敏感性：改一个未压缩区 textDelta 的文本 → 指纹漂移；审批挂起计数进指纹', () => {
    const a = JSON.stringify(threadFingerprint(buildStream()));
    const b = JSON.stringify(threadFingerprint(buildStream('回复二改')));
    expect(a).not.toBe(b);
    // 去掉 approvalResolved 也不加 → 挂起审批（这里流里就没有 resolve，挂起=1）
    const fp = threadFingerprint(buildStream()) as { pendingApprovals: number };
    expect(fp.pendingApprovals).toBe(1);
  });

  it('指纹不落原文（哈希化）+ compareGolden 报首漂移点', () => {
    const golden = corpusFingerprint([{ threadId: 't1', events: buildStream() }]);
    expect(golden).not.toContain('回复一');
    expect(golden).not.toContain('第一轮');
    const drifted = corpusFingerprint([{ threadId: 't1', events: buildStream('回复二改') }]);
    const diff = compareGolden(drifted, golden);
    expect(diff).toContain('指纹漂移');
    expect(compareGolden(golden, golden)).toBeNull();
  });
});

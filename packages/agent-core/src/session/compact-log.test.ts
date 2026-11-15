// 存储 GC（compactForStorage）测试：核心不变量 = 重放等价（rebuild 前后状态全等）+ 体积单调缩减
import { describe, expect, it } from 'vitest';
import { compactForStorage } from './compact-log';
import { rebuildThread } from './restore';
import type { LoopEvent, MemoryFact } from '@loomery/domain';

let seqCounter = 0;
let idCounter = 0;
const ev = (partial: Record<string, unknown> & { type: string }): LoopEvent => {
  seqCounter += 1;
  idCounter += 1;
  return { seq: seqCounter, id: `e${idCounter}`, schemaVersion: 1, ts: seqCounter * 1000, threadId: 't1', ...partial } as unknown as LoopEvent;
};

const fact = (id: string): MemoryFact => ({ id, kind: 'fact', content: `事实${id}`, source: 'user-pinned', scope: 'task', threadId: 't1', status: 'active', createdAt: 1 });

/** 轮1 被压缩（体积大头）→ 摘要一；轮2 保留（重命名/检查点/记忆/护栏/用量）；返回 { events, summaryId } */
function buildStream(): { events: LoopEvent[]; c1Seq: number } {
  seqCounter = 0;
  idCounter = 0;
  const events: LoopEvent[] = [
    ev({ type: 'threadCreated', payload: { threadId: 't1', title: 'GC 演示' } }),
    ev({ type: 'turnStarted', turnId: 'u1', payload: { turnId: 'u1', mode: 'edit', model: 'm', userMessageId: 'mu1', userText: '第一轮' } }),
    ev({ type: 'textDelta', turnId: 'u1', payload: { messageId: 'ma1', text: '回复一'.repeat(200) } }),
    ev({ type: 'toolCallComplete', turnId: 'u1', payload: { messageId: 'ma1', toolCallId: 'c1', name: 'read_file', args: '{"path":"a.ts"}' } }),
    ev({ type: 'observationAdded', turnId: 'u1', payload: { toolCallId: 'c1', truncated: false, originalChars: 10, finalChars: 10, preview: 'ok', content: 'x'.repeat(2000) } }),
    ev({ type: 'stepStarted', step: 1, payload: { step: 1 } }),
    ev({ type: 'stepCompleted', step: 1, payload: { finishReason: 'tool-calls', usage: { inputTokens: 10, outputTokens: 5, costEstimate: 0 } } }),
    ev({ type: 'usageDelta', turnId: 'u1', payload: { inputTokens: 100, outputTokens: 50 } }),
    ev({ type: 'turnCompleted', turnId: 'u1', payload: { outcome: 'completed' } }),
    ev({ type: 'memoryCompressed', turnId: 'u1', payload: { compressedMessageIds: ['mu1', 'ma1'], summary: '摘要一', tokensSaved: 30 } }),
    ev({ type: 'threadTitleChanged', payload: { threadId: 't1', title: '改名后' } }),
    ev({ type: 'turnStarted', turnId: 'u2', payload: { turnId: 'u2', mode: 'edit', model: 'm', userMessageId: 'mu2', userText: '第二轮' } }),
    ev({ type: 'textDelta', turnId: 'u2', payload: { messageId: 'ma2', text: '回复二' } }),
    ev({ type: 'usageDelta', turnId: 'u2', payload: { inputTokens: 200, outputTokens: 25 } }),
    ev({ type: 'checkpointCreated', turnId: 'u2', payload: { turnId: 'u2', files: ['a.ts'] } }),
    ev({ type: 'memoryPinned', payload: { fact: fact('f1') } }),
    ev({ type: 'guardrailTriggered', turnId: 'u2', payload: { rule: 'pathOutside', detail: '越界路径' } }),
    ev({ type: 'threadResumed', payload: { threadId: 't1', restoredTurnCount: 2, interruptedTurnIds: [] } }),
    ev({ type: 'turnCompleted', turnId: 'u2', payload: { outcome: 'completed' } }),
  ];
  const c1Seq = events.find((e) => e.type === 'memoryCompressed')!.seq;
  return { events, c1Seq };
}

describe('compactForStorage（存储 GC，重放等价）', () => {
  it('单次压缩：rebuild 前后状态全等（消息/标题/用量/检查点），体积缩减，seq 上界保留', () => {
    const original = buildStream().events;
    const compacted = compactForStorage(original);

    const before = rebuildThread(original);
    const after = rebuildThread(compacted);
    expect(after.title).toBe(before.title);
    expect(after.messages).toEqual(before.messages); // 深等：含 restored_summary_<seq> 的 id 稳定
    expect(after.usageTokens).toBe(before.usageTokens);
    expect(after.checkpointTurnIds).toEqual(before.checkpointTurnIds);
    expect(after.workspaceRoot).toBe(before.workspaceRoot);

    expect(compacted.length).toBeLessThan(original.length);
    expect(JSON.stringify(compacted).length).toBeLessThan(JSON.stringify(original).length);
    expect(Math.max(...compacted.map((e) => e.seq))).toBe(Math.max(...original.map((e) => e.seq)));
    // 体积大头确被移除：轮1 的生成事件与过程事件不在保留集
    const types = compacted.map((e) => e.type);
    expect(types).not.toContain('threadResumed');
    expect(compacted.filter((e) => e.type === 'textDelta').map((e) => (e.payload as { messageId: string }).messageId)).toEqual(['ma2']);
    // 审计/统计基础全保留
    expect(types).toContain('usageDelta');
    expect(types).toContain('memoryPinned');
    expect(types).toContain('guardrailTriggered');
    expect(types).toContain('checkpointCreated');
  });

  it('两次压缩只保留最后一条：重放仍等价（单摘要不变量）', () => {
    const { events: base, c1Seq } = buildStream();
    const original = [
      ...base,
      // 轮3 + 第二次压缩（压缩掉 摘要一 与 轮2——真实语义：压缩最老组；摘要 id 引用 c1 的重放口径）
      ev({ type: 'turnStarted', turnId: 'u3', payload: { turnId: 'u3', mode: 'edit', model: 'm', userMessageId: 'mu3', userText: '第三轮' } }),
      ev({ type: 'textDelta', turnId: 'u3', payload: { messageId: 'ma3', text: '回复三' } }),
      ev({ type: 'usageDelta', turnId: 'u3', payload: { inputTokens: 10, outputTokens: 5 } }),
      ev({ type: 'turnCompleted', turnId: 'u3', payload: { outcome: 'completed' } }),
      ev({ type: 'memoryCompressed', turnId: 'u3', payload: { compressedMessageIds: [`restored_summary_${c1Seq}`, 'mu2', 'ma2'], summary: '摘要二', tokensSaved: 20 } }),
    ];
    const compacted = compactForStorage(original);
    expect(compacted.filter((e) => e.type === 'memoryCompressed')).toHaveLength(1);

    const before = rebuildThread(original);
    const after = rebuildThread(compacted);
    expect(after.messages).toEqual(before.messages);
    expect(after.messages[0]?.parts[0]).toMatchObject({ kind: 'summary', text: '摘要二' });
    expect(after.usageTokens).toBe(before.usageTokens);
  });

  it('未知事件类型保守保留（前向兼容）', () => {
    const future = ev({ type: 'futureEvent', payload: { x: 1 } } as unknown as Record<string, unknown> & { type: string });
    const compacted = compactForStorage([...buildStream().events, future]);
    expect(compacted.some((e) => String((e as { type: string }).type) === 'futureEvent')).toBe(true);
  });

  it('空流直通', () => {
    expect(compactForStorage([])).toEqual([]);
  });
});

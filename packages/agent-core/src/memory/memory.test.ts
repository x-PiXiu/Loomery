import { describe, expect, it } from 'vitest';
import { groupMessages } from './groups';
import { compressIfNeeded } from './short-term';
import { extractFacts, parseFacts } from './long-term';
import { MemoryRecallProvider } from './memory-provider';
import { FakeModel, InMemoryStore } from '../testing/fakes';
import type { ChatMessage } from '@loomery/domain';

function user(text: string, id = `u_${text}`): ChatMessage {
  return { id, role: 'user', parts: [{ kind: 'text', text }], createdAt: 1 };
}

function assistantWithTool(id: string, toolCallId: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    createdAt: 2,
    parts: [
      { kind: 'tool-call', toolCallId, name: 'write_file', args: '{}' },
      { kind: 'tool-result', toolCallId, content: 'ok', truncated: false, originalChars: 2 },
    ],
  };
}

describe('groupMessages（配对组切分）', () => {
  it('用户消息开新组；tool-call 与 tool-result 永远同组', () => {
    const messages = [
      user('第一轮'),
      assistantWithTool('a1', 'c1'),
      user('第二轮'),
      assistantWithTool('a2', 'c2'),
    ];
    const groups = groupMessages(messages);
    expect(groups.map((g) => g.map((m) => m.id))).toEqual([
      ['u_第一轮', 'a1'],
      ['u_第二轮', 'a2'],
    ]);
  });
});

describe('compressIfNeeded（短期压缩）', () => {
  it('低于阈值不压缩', async () => {
    const out = await compressIfNeeded([user('hi')], { thresholdTokens: 1000 }, async () => '');
    expect(out).toBeNull();
  });

  it('超阈值压缩最老组：保留组完整、配对不拆散', async () => {
    const messages = [
      user('g1'), assistantWithTool('a1', 'c1'),
      user('g2'), assistantWithTool('a2', 'c2'),
      user('g3'), assistantWithTool('a3', 'c3'),
    ];
    const out = await compressIfNeeded(messages, { thresholdTokens: 1, keepRecentGroups: 1 }, async (text) => `摘要:${text.length}`);
    expect(out).not.toBeNull();
    expect(out?.compressedIds).toEqual(['u_g1', 'a1', 'u_g2', 'a2']);
    const kept = out?.messages ?? [];
    // 首条为 summary；保留组内 tool-call/tool-result 仍成对
    expect(kept[0]?.parts[0]?.kind).toBe('summary');
    const callIds = kept.flatMap((m) => m.parts.filter((p) => p.kind === 'tool-call').map((p) => (p as { toolCallId: string }).toolCallId));
    const resultIds = kept.flatMap((m) => m.parts.filter((p) => p.kind === 'tool-result').map((p) => (p as { toolCallId: string }).toolCallId));
    expect(callIds.sort()).toEqual(resultIds.sort());
    expect(callIds).toEqual(['c3']);
  });

  it('组数不足时不压缩', async () => {
    const out = await compressIfNeeded(
      [user('g1'), assistantWithTool('a1', 'c1')],
      { thresholdTokens: 1, keepRecentGroups: 2 },
      async () => 's',
    );
    expect(out).toBeNull();
  });

  it('摘要为空（模型调用失败）按失败处理：抛错且不替换历史', async () => {
    const messages = [
      user('g1'), assistantWithTool('a1', 'c1'),
      user('g2'), assistantWithTool('a2', 'c2'),
      user('g3'), assistantWithTool('a3', 'c3'),
    ];
    await expect(
      compressIfNeeded(messages, { thresholdTokens: 1, keepRecentGroups: 1 }, async () => ''),
    ).rejects.toThrow(/摘要模型返回为空/);
    // 原消息数组未被改动（纯函数语义：调用方消息保持完整）
    expect(messages).toHaveLength(6);
  });
});

describe('extractFacts（长期提炼）', () => {
  it('解析模型 JSON 输出为 MemoryFact', async () => {
    const model = new FakeModel([
      { type: 'text-delta', text: '[{"kind":"preference","content":"偏好深色主题"}]' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const facts = await extractFacts(model, [user('我喜欢深色主题')], 123);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ kind: 'preference', content: '偏好深色主题', source: 'extracted' });
  });

  it('噪声输出/空内容容错', () => {
    expect(parseFacts('好的，这是结果：[] 以上。', 1)).toEqual([]);
    expect(parseFacts('[{"kind":"weird","content":"x"}]', 1)).toEqual([]);
    expect(parseFacts('完全不是 JSON', 1)).toEqual([]);
  });
});

describe('MemoryRecallProvider（ADR-0012）', () => {
  it('召回命中 → 生成 chunk；未命中 → null', async () => {
    const store = new InMemoryStore();
    await store.saveFact({ id: 'f1', kind: 'convention', content: '本项目使用 pnpm', createdAt: 1, source: 'extracted' });
    const provider = new MemoryRecallProvider(store);
    const hit = await provider.provide({ threadId: 't1', mode: 'edit', latestUserMessage: 'pnpm 怎么装依赖' });
    expect(hit?.text).toContain('本项目使用 pnpm');
    expect(hit?.providerId).toBe('memory-recall');

    const miss = await provider.provide({ threadId: 't1', mode: 'edit' });
    expect(miss).toBeNull();
  });
});

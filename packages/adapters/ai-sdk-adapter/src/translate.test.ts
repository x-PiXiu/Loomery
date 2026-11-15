// MiniMax 2013 回归锁：tool-result 携带图像时，消息序列必须保持 assistant → tool → user(image) 合法顺序
import { describe, expect, it } from 'vitest';
import { toModelMessages } from './translate';
import type { ChatMessage, ImageRef } from '@loomery/domain';

const IMG: ImageRef = { mime: 'image/jpeg', base64: 'aGVsbG8=' };

function buildTurn(): ChatMessage[] {
  return [
    { id: 'u', role: 'user', parts: [{ kind: 'text', text: '截图看看' }], createdAt: 1 },
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        { kind: 'text', text: '我来截图。' },
        { kind: 'tool-call', toolCallId: 'call_0968', name: 'browser_control', args: '{"action":"screenshot"}' },
        { kind: 'tool-result', toolCallId: 'call_0968', content: '已截图（全视口 714×1203）', truncated: false, originalChars: 30, images: [IMG] },
      ],
      createdAt: 2,
    },
    { id: 'a2', role: 'assistant', parts: [{ kind: 'text', text: '截图完成。' }], createdAt: 3 },
  ];
}

describe('toModelMessages 图像注入（MiniMax 2013 回归）', () => {
  it('vision=true：assistant → tool → user(image) → assistant 顺序合法', () => {
    const out = toModelMessages(buildTurn(), { vision: true });
    const roles = out.map((m) => m.role);
    // user(原始) assistant(a1) tool(user图像段) assistant(a2)
    expect(roles.filter((r) => r === 'tool')).toHaveLength(1);
    const toolMsg = out.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    // tool 消息必须紧跟其 assistant(tool-call) —— 之前 tool 消息跑到 assistant 之前（2013 根因）
    const a1Idx = out.findIndex((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('call_0968'));
    const toolIdx = out.findIndex((m) => m.role === 'tool');
    expect(toolIdx).toBe(a1Idx + 1);
    // 图像段在 tool 之后
    const imgIdx = out.findIndex((m) => m.role === 'user' && JSON.stringify(m.content).includes('image'));
    expect(imgIdx).toBe(toolIdx + 1);
  });

  it('vision=false：无 user 图像段插入（序列与历史完全一致）+ 注记拼进 tool 文本', () => {
    const out = toModelMessages(buildTurn(), { vision: false });
    const roles = out.map((m) => m.role);
    // 不应有除原始 user 外的额外 user 消息（2026-11-13 实证：MiniMax 对 tool 后接 user 报 2013）
    const userCount = roles.filter((r) => r === 'user').length;
    expect(userCount).toBe(1);
    const toolMsg = out.find((m) => m.role === 'tool');
    expect(JSON.stringify(toolMsg?.content)).toContain('不支持视觉');
  });
});

import { describe, expect, it } from 'vitest';
import { estimateTokens } from './token-estimate';

describe('estimateTokens（上下文预算启发式）', () => {
  it('英文按 4 字符/token 估算', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('CJK 字符按 1 字/token', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });

  it('混合文本', () => {
    // 2 个中文 + 8 个英文字符 = 2 + 2 = 4
    expect(estimateTokens('你好abcdefgh')).toBe(4);
  });

  it('空字符串为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

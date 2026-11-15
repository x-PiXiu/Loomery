import { describe, expect, it } from 'vitest';
import { truncateText } from './truncate';

describe('truncateText（07 §9 工具结果硬截断）', () => {
  it('未超上限原样返回', () => {
    const r = truncateText('abc', 10);
    expect(r).toEqual({ content: 'abc', truncated: false, originalChars: 3, finalChars: 3 });
  });

  it('恰好等于上限不截断', () => {
    const r = truncateText('a'.repeat(10), 10);
    expect(r.truncated).toBe(false);
  });

  it('超上限截断并记录原始/最终字符数', () => {
    const r = truncateText('x'.repeat(25), 20);
    expect(r.truncated).toBe(true);
    expect(r.originalChars).toBe(25);
    expect(r.finalChars).toBeGreaterThan(20); // 含截断提示后缀
    expect(r.content.startsWith('x'.repeat(20))).toBe(true);
    expect(r.content).toContain('truncated 5 chars');
  });

  it('空字符串', () => {
    expect(truncateText('', 10)).toEqual({
      content: '',
      truncated: false,
      originalChars: 0,
      finalChars: 0,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { modeAllows } from './mode-filter';

describe('modeAllows（03 §5 模式过滤规范）', () => {
  it('plan/explain 仅放行 read 工具', () => {
    expect(modeAllows('plan', { sideEffect: 'read' })).toBe(true);
    expect(modeAllows('plan', { sideEffect: 'write' })).toBe(false);
    expect(modeAllows('plan', { sideEffect: 'execute' })).toBe(false);
    expect(modeAllows('explain', { sideEffect: 'read' })).toBe(true);
    expect(modeAllows('explain', { sideEffect: 'write' })).toBe(false);
    expect(modeAllows('explain', { sideEffect: 'execute' })).toBe(false);
  });

  it('edit 全放行', () => {
    for (const sideEffect of ['read', 'write', 'execute'] as const) {
      expect(modeAllows('edit', { sideEffect })).toBe(true);
    }
  });
});

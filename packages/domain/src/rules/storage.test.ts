import { describe, expect, it } from 'vitest';
import { arbitrateContributions } from './budget';
import { artifactSummary, decideArtifactCapture, isWritablePath } from './storage';

describe('decideArtifactCapture（ADR-0021 产物拦截）', () => {
  it('短内容不拦截', () => {
    expect(decideArtifactCapture('hello world', 100)).toEqual({ capture: false, tokens: expect.any(Number) });
  });
  it('超阈值内容拦截', () => {
    const big = 'x'.repeat(800);
    const r = decideArtifactCapture(big, 10);
    expect(r.capture).toBe(true);
    expect(r.tokens).toBeGreaterThan(10);
  });
});

describe('artifactSummary（一行摘要）', () => {
  it('取首个非空行', () => {
    expect(artifactSummary('\n\n  error at line 3  \nstack…')).toBe('error at line 3');
  });
  it('超长截断到 80 含省略号', () => {
    const s = artifactSummary('a'.repeat(200));
    expect(s.length).toBe(80);
    expect(s.endsWith('…')).toBe(true);
  });
  it('空内容给空摘要', () => {
    expect(artifactSummary('')).toBe('');
  });
});

describe('isWritablePath（workspace ∪ scratch，ADR-0021）', () => {
  const win = process.platform === 'win32';
  const ws = win ? 'E:\\ws' : '/ws';
  const scratch = win ? 'C:\\ud\\scratch\\t1' : '/ud/scratch/t1';
  it('工作区内放行', () => {
    expect(isWritablePath(win ? 'E:\\ws\\a.txt' : '/ws/a.txt', [ws], scratch)).toBe(true);
  });
  it('scratch 内放行', () => {
    expect(isWritablePath(win ? 'C:\\ud\\scratch\\t1\\b.txt' : '/ud/scratch/t1/b.txt', [ws], scratch)).toBe(true);
  });
  it('两者之外拒绝', () => {
    expect(isWritablePath(win ? 'D:\\other\\c.txt' : '/other/c.txt', [ws], scratch)).toBe(false);
  });
  it('scratchRoot 缺省时退化为纯工作区判定（兼容）', () => {
    expect(isWritablePath(win ? 'C:\\ud\\scratch\\t1\\b.txt' : '/ud/scratch/t1/b.txt', [ws])).toBe(false);
  });
});

describe('arbitrateContributions（ADR-0021 裁剪优先级）', () => {
  it('预算内全保留', () => {
    const r = arbitrateContributions(
      [{ id: 'a', tokens: 10, priority: 1 }, { id: 'b', tokens: 10, priority: 2 }],
      100,
    );
    expect(r.kept).toEqual(['a', 'b']);
    expect(r.dropped).toEqual([]);
  });
  it('超预算按 priority 大者先裁', () => {
    const r = arbitrateContributions(
      [
        { id: 'mem', tokens: 40, priority: 5 },
        { id: 'brief', tokens: 40, priority: 3 },
        { id: 'skill', tokens: 40, priority: 2 },
      ],
      80,
    );
    expect(r.kept).toEqual(['skill', 'brief']);
    expect(r.dropped).toEqual(['mem']);
  });
  it('pinned 永不裁（哪怕独自超预算）', () => {
    const r = arbitrateContributions(
      [
        { id: 'pinned', tokens: 500, priority: 1, pinned: true },
        { id: 'mem', tokens: 40, priority: 5 },
      ],
      100,
    );
    expect(r.kept).toContain('pinned');
    expect(r.dropped).toEqual(['mem']);
  });
});

// 唯一匹配语义（P0①）：oldLines 内容锚点定位/重锚/歧义拒绝/重叠拒绝——2026-11-13 逐字节匹配退役的回归锁
import { describe, expect, it } from 'vitest';
import { applyHunks, resolveHunks, validateHunks } from './diff';
import type { DiffHunk } from '../diff';

const FILE = ['const a = 1;', 'const b = 2;', 'function f() {', '  return a + b;', '}', ''].join('\n');

function hunk(oldStart: number, oldLines: string[], newLines: string[]): DiffHunk {
  return { oldStart, oldLines, newStart: oldStart, newLines };
}

describe('resolveHunks（唯一匹配语义）', () => {
  it('行号精确匹配：行为不变', () => {
    const r = resolveHunks(FILE, [hunk(2, ['const b = 2;'], ['const b = 22;'])]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved[0]?.oldStart).toBe(2);
  });

  it('行号漂移（oldStart 差 2 行）但内容唯一 → 自动重锚', () => {
    // 模型以为 b 在第 4 行（实际第 2 行）——旧行号错、内容对
    const r = resolveHunks(FILE, [hunk(4, ['const b = 2;'], ['const b = 22;'])]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved[0]?.oldStart).toBe(2);
      expect(applyHunks(FILE, r.resolved)).toContain('const b = 22;');
    }
  });

  it('行尾空白差异容忍（LLM 尾随空格习惯）', () => {
    const r = resolveHunks(FILE, [hunk(2, ['const b = 2;   '], ['const b = 22;'])]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved[0]?.oldStart).toBe(2);
  });

  it('内容不存在 → 可行动错误（先 read_file 刷新）', () => {
    const r = resolveHunks(FILE, [hunk(1, ['const x = 999;'], ['const x = 1;'])]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('未找到');
  });

  it('多处匹配 → 拒绝并要求更多上下文（歧义保护）', () => {
    const dup = ['let x;', 'let x;', 'let y;'].join('\n');
    const r = resolveHunks(dup, [hunk(1, ['let x;'], ['let x = 1;'])]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('2 处');
  });

  it('多 hunk 各自重锚（互相独立定位）', () => {
    const r = resolveHunks(FILE, [hunk(5, ['function f() {'], ['function g() {']), hunk(9, ['  return a + b;'], ['  return a * b;'])]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved[0]?.oldStart).toBe(3);
      expect(r.resolved[1]?.oldStart).toBe(4);
      const next = applyHunks(FILE, r.resolved);
      expect(next).toContain('function g() {');
      expect(next).toContain('return a * b;');
    }
  });

  it('重锚后范围重叠 → 拒绝（替换互踩保护）', () => {
    const r = resolveHunks(FILE, [hunk(1, ['const a = 1;', 'const b = 2;'], ['X']), hunk(3, ['const b = 2;'], ['Y'])]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('重叠');
  });

  it('oldLines 为空 = 纯插入按 oldStart（不参与锚点）', () => {
    const r = resolveHunks(FILE, [hunk(1, [], ['// header'])]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(applyHunks(FILE, r.resolved).startsWith('// header')).toBe(true);
  });

  it('新文件（content null）：oldLines 必须为空', () => {
    expect(validateHunks(null, [hunk(1, ['x'], ['y'])]).ok).toBe(false);
    expect(validateHunks(null, [hunk(1, [], ['y'])]).ok).toBe(true);
  });
});

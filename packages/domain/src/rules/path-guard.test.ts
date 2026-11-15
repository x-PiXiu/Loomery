import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPathInsideWorkspace } from './path-guard';

const WIN = process.platform === 'win32';
const root = WIN ? 'C:\\ws' : '/ws';
const inside = WIN ? 'C:\\ws\\src\\a.txt' : '/ws/src/a.txt';
const sibling = WIN ? 'C:\\ws2\\a.txt' : '/ws2/a.txt';
const escape = WIN ? 'C:\\ws\\..\\evil.txt' : '/ws/../evil.txt';
const caseAlt = WIN ? 'c:\\WS\\SRC\\A.TXT' : '/WS/SRC/A.TXT';

describe('isPathInsideWorkspace（07 §4 pathOutside 规则）', () => {
  it('工作区内的绝对路径放行', () => {
    expect(isPathInsideWorkspace(inside, [root])).toBe(true);
  });

  it('根本身放行', () => {
    expect(isPathInsideWorkspace(root, [root])).toBe(true);
  });

  it('同前缀的兄弟目录不放行（边界咬合）', () => {
    expect(isPathInsideWorkspace(sibling, [root])).toBe(false);
  });

  it('经 .. 逃逸的路径不放行', () => {
    expect(isPathInsideWorkspace(escape, [root])).toBe(false);
  });

  it('多根逐一检查', () => {
    const roots = [WIN ? 'C:\\other' : '/other', root];
    expect(isPathInsideWorkspace(inside, roots)).toBe(true);
    expect(isPathInsideWorkspace(sibling, [WIN ? 'C:\\other' : '/other'])).toBe(false);
  });

  it('分隔符直接拼接不构成误判', () => {
    // root + "x" 这类直接拼接不应通过（必须是 path.sep 边界）
    expect(isPathInsideWorkspace(root + 'x', [root])).toBe(false);
  });

  it('路径分隔符统一处理', () => {
    const mixed = WIN ? 'C:/ws/src/a.txt' : '/ws/src/a.txt';
    expect(isPathInsideWorkspace(mixed, [root])).toBe(true);
    expect(sep.length).toBe(1);
  });

  it.skipIf(!WIN)('Windows 上比较不区分大小写（ADR-0013）', () => {
    expect(isPathInsideWorkspace(caseAlt, [root])).toBe(true);
  });
});

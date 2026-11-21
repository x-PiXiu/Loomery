// 11-21 打包版首启 bug 回归：安装器/开始菜单启动 cwd=C:\Windows\System32——
// 系统目录绝不能成为默认工作区（领土护栏圈进系统目录 + 侧栏出现"system32"项目）
import { describe, expect, it } from 'vitest';
import { isSystemDir, sanitizeSystemRoots } from './workspace';

describe('isSystemDir / sanitizeSystemRoots（workspace 规则）', () => {
  it('System32 与 C:\\Windows 子目录均为系统目录', () => {
    expect(isSystemDir('C:\\Windows\\System32')).toBe(true);
    expect(isSystemDir('C:\\Windows\\System32\\inetsrv')).toBe(true);
    expect(isSystemDir('C:\\Windows')).toBe(true);
    expect(isSystemDir('C:/Windows/System32')).toBe(true); // 正斜杠归一
  });

  it('用户目录与项目目录不是系统目录', () => {
    expect(isSystemDir('C:\\Users\\dev')).toBe(false);
    expect(isSystemDir('C:\\Users\\dev\\project')).toBe(false);
    expect(isSystemDir('E:\\workspace\\demo')).toBe(false);
  });

  it('resolveDefaultWorkspace 的兜底语义：找不到项目根时回退 homedir 而非系统目录（模拟组合根调用）', () => {
    const homedir = 'C:\\Users\\dev';
    const startDir = 'C:\\Windows\\System32';
    const result = 'C:\\Windows\\System32'; // bootstrap：10 级向上无项目根 → 原样返回 startDir
    const safe = isSystemDir(result) ? homedir : result;
    expect(safe).toBe(homedir);
    void startDir;
  });

  it('sanitizeSystemRoots：剔除系统目录根，保留合法根', () => {
    const roots = ['C:\\Windows\\System32', 'E:\\workspace\\demo', 'C:\\Windows\\explorer'];
    expect(sanitizeSystemRoots(roots)).toEqual(['E:\\workspace\\demo']);
    expect(sanitizeSystemRoots([])).toEqual([]);
  });
});

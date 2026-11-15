import { describe, expect, it } from 'vitest';
import { canonicalJson, hashToolCall } from './hash';

describe('canonicalJson（03 §4 确定性序列化）', () => {
  it('键顺序无关', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('递归键排序', () => {
    expect(canonicalJson({ x: { d: 4, c: 3 }, a: [{ z: 1, y: 2 }] })).toBe(
      '{"a":[{"y":2,"z":1}],"x":{"c":3,"d":4}}',
    );
  });

  it('基础类型', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson('hi"')).toBe('"hi\\""');
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson([1, 'a'])).toBe('[1,"a"]');
  });

  it('函数等不可序列化值视为 null（不会进入哈希，防御性）', () => {
    expect(canonicalJson(() => 1)).toBe('null');
  });
});

describe('hashToolCall（死循环检测依据）', () => {
  it('同工具同输入（键序不同）哈希一致', () => {
    expect(hashToolCall('write_file', { path: 'a', content: 'b' })).toBe(
      hashToolCall('write_file', { content: 'b', path: 'a' }),
    );
  });

  it('工具名或输入不同则哈希不同', () => {
    expect(hashToolCall('write_file', { a: 1 })).not.toBe(hashToolCall('read_file', { a: 1 }));
    expect(hashToolCall('write_file', { a: 1 })).not.toBe(hashToolCall('write_file', { a: 2 }));
  });

  it('sha256 十六进制 64 位', () => {
    expect(hashToolCall('t', {})).toMatch(/^[0-9a-f]{64}$/);
  });
});

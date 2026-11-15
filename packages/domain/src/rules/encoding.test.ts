// 编码探测单测：BOM 三态 / UTF-8 严格 / GBK 中文 / latin1 兜底
import { describe, expect, it } from 'vitest';
import { decodeText } from './encoding';

describe('decodeText（编码探测）', () => {
  it('UTF-8 直通', () => {
    const buf = new TextEncoder().encode('hello 世界');
    expect(decodeText(buf)).toEqual({ text: 'hello 世界', encoding: 'utf-8' });
  });

  it('UTF-8 BOM 剥离', () => {
    const buf = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('内容')]);
    const r = decodeText(buf);
    expect(r.encoding).toBe('utf-8');
    expect(r.text).toBe('内容'); // BOM 不残留
  });

  it('UTF-16LE BOM', () => {
    const text = '宽字符';
    const bytes: number[] = [0xff, 0xfe];
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      bytes.push(code & 0xff, code >> 8);
    }
    const r = decodeText(new Uint8Array(bytes));
    expect(r.encoding).toBe('utf-16le');
    expect(r.text).toBe(text);
  });

  it('GBK 中文（UTF-8 严格解码失败→GBK）', () => {
    // 「中文」的 GBK 编码字节：D6 D0 CE C4
    const r = decodeText(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]));
    expect(r.encoding).toBe('gbk');
    expect(r.text).toBe('中文');
  });

  it('无效序列落 latin1 兜底不抛错', () => {
    // 0x80 单独出现：非合法 UTF-8；若平台无 gbk/big5 也永不抛错
    const r = decodeText(new Uint8Array([0x41, 0x80, 0x42]));
    expect(r.encoding === 'gbk' || r.encoding === 'latin1').toBe(true);
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('空缓冲直通', () => {
    expect(decodeText(new Uint8Array([]))).toEqual({ text: '', encoding: 'utf-8' });
  });
});

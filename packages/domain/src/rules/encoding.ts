// 编码探测与解码（03 §? 纯函数规则；TextDecoder 为平台全局——Node 24 / Electron 全 ICU 均内置 gbk/big5）：
// BOM 优先 → UTF-8 严格解码（失败即非 UTF-8）→ GBK → Big5 → latin1 兜底。
// 中文用户高频痛点：GBK 文件此前按 UTF-8 读出乱码（编辑器与 read_file 工具双双受害）。
export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gbk' | 'big5' | 'latin1';

export interface DecodedText {
  text: string;
  encoding: TextEncoding;
}

type Decoder = InstanceType<typeof TextDecoder>;
const decoders = new Map<string, Decoder>();
function decoderFor(enc: string, fatal = false): Decoder {
  const key = enc + (fatal ? ':fatal' : '');
  let d = decoders.get(key);
  if (!d) {
    d = new TextDecoder(enc, { fatal });
    decoders.set(key, d);
  }
  return d;
}

/** 平台是否支持某编码（TextDecoder 构造器对未支持标签直接抛错） */
function supports(enc: string): boolean {
  try {
    decoderFor(enc);
    return true;
  } catch {
    return false;
  }
}

const GBK_OK = supports('gbk');
const BIG5_OK = supports('big5');

export function decodeText(buf: Uint8Array): DecodedText {
  // BOM 优先（剥离后按对应编码解码）
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: decoderFor('utf-8').decode(buf.subarray(3)), encoding: 'utf-8' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: decoderFor('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: decoderFor('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  }
  // UTF-8 严格模式：任何非法序列都抛错 → 判非 UTF-8，走中文环境最常见的 GBK，再 Big5，latin1 永不失败兜底
  try {
    return { text: decoderFor('utf-8', true).decode(buf), encoding: 'utf-8' };
  } catch {
    if (GBK_OK) {
      try {
        return { text: decoderFor('gbk').decode(buf), encoding: 'gbk' };
      } catch { /* 落 Big5 */ }
    }
    if (BIG5_OK) {
      try {
        return { text: decoderFor('big5').decode(buf), encoding: 'big5' };
      } catch { /* 落 latin1 */ }
    }
    return { text: decoderFor('latin1').decode(buf), encoding: 'latin1' };
  }
}

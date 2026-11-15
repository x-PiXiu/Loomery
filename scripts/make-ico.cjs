// 生成 Windows 安装器/任务栏图标 .ico（多尺寸，PNG 嵌入式条目——Vista+ 标准做法）。
// 源：resources/icon-source.png（透明底）→ 盒式缩放到 16/32/48/64/128/256 → ICO 装配。
// 零依赖：PNG 解码/编码/缩放与 make-icon.cjs 同源实现（脚本层复制，避免改已验证脚本）。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC = path.join(__dirname, '..', 'packages', 'shell', 'resources', 'icon-source.png');
const OUT = path.join(__dirname, '..', 'packages', 'shell', 'resources', 'icon.ico');
const SIZES = [256, 128, 64, 48, 32, 16];

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8;
  let w = 0;
  let h = 0;
  let colorType = 6;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      out[o] = cur[x * bpp];
      out[o + 1] = cur[x * bpp + 1];
      out[o + 2] = cur[x * bpp + 2];
      out[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev = cur;
  }
  return { w, h, rgba: out };
}
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function boxScale(img, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 4);
  for (let dy = 0; dy < dh; dy++) {
    const y0 = Math.floor((dy * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((dy + 1) * sh) / dh));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = Math.floor((dx * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((dx + 1) * sw) / dw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < sh; y++) {
        for (let x = x0; x < x1 && x < sw; x++) {
          const o = (y * sw + x) * 4;
          r += img[o];
          g += img[o + 1];
          b += img[o + 2];
          a += img[o + 3];
          n++;
        }
      }
      const o = (dy * dw + dx) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ---- ICO 装配：ICONDIR(6B) + 每尺寸 ICONDIRENTRY(16B) + PNG 数据（256 用 0 表示 256）----
const src = decodePng(fs.readFileSync(SRC));
const pngs = SIZES.map((s) => {
  const rgba = s === src.w ? src.rgba : boxScale(src.rgba, src.w, src.h, s, s);
  return { size: s, png: encodePng(s, s, rgba) };
});
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // type icon
header.writeUInt16LE(pngs.length, 4);
const dirSize = 16 * pngs.length;
const entries = [];
let offset = 6 + dirSize;
for (const { size, png } of pngs) {
  const e = Buffer.alloc(16);
  e[0] = size >= 256 ? 0 : size;
  e[1] = size >= 256 ? 0 : size;
  e.writeUInt16LE(1, 4); // 色板数（现代条目 0/1 均可，1 保守）
  e.writeUInt16LE(32, 6); // 位深
  e.writeUInt32LE(png.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += png.length;
  entries.push(e);
}
fs.writeFileSync(OUT, Buffer.concat([header, ...entries, ...pngs.map((p) => p.png)]));
console.log(`icon.ico 已生成：${OUT}（${pngs.length} 尺寸：${SIZES.join('/')}）`);

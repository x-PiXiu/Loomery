// 图标加工（零依赖）：PNG 解码 → 圆角 alpha 掩模（半径 22%，抗锯齿）→ 盒式缩放 → PNG 编码
// 输出 packages/shell/resources/app-icon.png（512px，BrowserWindow 图标用）
// 用法：node scripts/make-icon.cjs [inspect]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC = path.join(__dirname, '..', 'packages', 'shell', 'resources', 'icon-source.png');
const OUT = path.join(__dirname, '..', 'packages', 'shell', 'resources', 'app-icon.png');

// ---- CRC32 ----
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

// ---- PNG 解码（支持 8bit RGBA/RGB，全部 5 种行滤波）----
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('非 PNG');
  let pos = 8;
  let w = 0;
  let h = 0;
  let colorType = 0;
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
  if (colorType !== 6 && colorType !== 2) throw new Error('仅支持 8bit RGB/RGBA，colorType=' + colorType);
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

// ---- PNG 编码（RGBA，filter 0）----
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

// ---- 盒式缩放（区域平均）----
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
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return out;
}

// ---- 主流程 ----
const img = decodePng(fs.readFileSync(SRC));
const { w, h, rgba } = img;
// 角像素诊断：背景是透明还是实心黑
const corner = (x, y) => {
  const o = (y * w + x) * 4;
  return [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]];
};
console.log('[icon] 源:', w + 'x' + h, '| 四角 RGBA:', JSON.stringify([corner(0, 0), corner(w - 1, 0), corner(0, h - 1), corner(w - 1, h - 1)]));

// 透明裁边：glyph 包围盒（alpha>10）+ 3% 边距——透明边距会让任务栏图标视觉偏小
const bbox = (() => {
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rgba[(y * w + x) * 4 + 3] > 10) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.03);
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  return { minX, minY, maxX, maxY };
})();
console.log('[icon] 裁边:', JSON.stringify(bbox));
const tw = bbox.maxX - bbox.minX + 1;
const th = bbox.maxY - bbox.minY + 1;
const trimmed = new Uint8Array(tw * th * 4);
for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
  const s = ((y + bbox.minY) * w + (x + bbox.minX)) * 4;
  const d = (y * tw + x) * 4;
  trimmed[d] = rgba[s]; trimmed[d + 1] = rgba[s + 1]; trimmed[d + 2] = rgba[s + 2]; trimmed[d + 3] = rgba[s + 3];
}

// 圆角掩模：半径 22%，边缘 2px 抗锯齿过渡（透明底已裁边，掩模只影响 glyph 越界角部）
const R = Math.round(Math.min(w, h) * 0.22);
const out = new Uint8Array(trimmed);
for (let y = 0; y < th; y++) {
  for (let x = 0; x < tw; x++) {
    // 到圆角矩形的内缩距离（负值=外部）
    const rx = x < R ? R - x : x >= tw - R ? x - (tw - R - 1) : 0;
    const ry = y < R ? R - y : y >= th - R ? y - (th - R - 1) : 0;
    const d = Math.sqrt(rx * rx + ry * ry); // >0 仅在角区
    const edge = d - R; // 角区：>0 在圆外
    if (edge > -2) {
      const alpha = Math.max(0, Math.min(1, (2 - edge) / 4)); // 2px 内渐变
      const o = (y * tw + x) * 4;
      out[o + 3] = Math.round(trimmed[o + 3] * alpha);
    }
  }
}

// 512 输出（glyph 撑满画布）
const D = 512;
const scaled = boxScale(out, tw, th, D, D);
fs.writeFileSync(OUT, encodePng(D, D, scaled));
console.log('[icon] 输出:', OUT, '(' + (fs.statSync(OUT).size / 1024).toFixed(0) + 'KB, ' + D + 'px 圆角)');

// 额外：32px（托盘/小图标备用）
fs.writeFileSync(OUT.replace('.png', '-32.png'), encodePng(32, 32, boxScale(out, tw, th, 32, 32)));
fs.writeFileSync(OUT.replace('.png', '-64.png'), encodePng(64, 64, boxScale(out, tw, th, 64, 64)));
console.log('[icon] 输出: app-icon-32.png');

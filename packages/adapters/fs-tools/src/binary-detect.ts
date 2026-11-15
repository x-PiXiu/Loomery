/** 简单二进制探测：前 8KB 出现 NUL 字节即视为二进制 */
export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

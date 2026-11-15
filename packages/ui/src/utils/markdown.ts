// 渲染前 markdown 修复（对齐 ZCode 的宽容解析）：模型输出常见"围栏未闭合"缺陷，
// 后续全部内容会被吞进一个代码块。修复规则：
// ① 全文围栏奇偶配平——奇数时在末尾补闭合围栏；
// ② 围栏内遇到零缩进 markdown 标题 → 推定漏了闭合围栏——**必须前视确认**：
//    若该行后方仍存在围栏行（说明本围栏随后正常闭合，当前标题只是代码内容，如 bash 的 `# 服务端` 注释），绝不插闭合
//    （2026-11-13 实证误伤：合法 bash 注释被强拆 → 空代码块 + 巨字标题 + 内容碎片化）；
//    仅"fence 开启后到文档末尾再无围栏"（真漏闭合）才触发。
// ③ 非围栏区 "##标题"（ATX 后无空格，CommonMark 不识别为标题）→ 补空格成合法标题（模型意图明确）。
export function balanceFences(md: string): string {
  const lines = md.split(/\r?\n/);
  // 前视表：fenceAhead[i] = 第 i 行之后（不含 i）是否还存在围栏行
  const fenceAhead = new Array<boolean>(lines.length).fill(false);
  let ahead = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    fenceAhead[i] = ahead;
    if (/^ {0,3}(```|~~~)/.test(lines[i] ?? '')) ahead = true;
  }
  const out: string[] = [];
  let open = false;
  let openMarker = '```';
  for (const [i, line] of lines.entries()) {
    const fence = /^ {0,3}(```|~~~)/.exec(line);
    if (fence) {
      // 与开启围栏同标记的行才算闭合（``` 不闭合 ~~~ 开的块）
      if (!open || fence[1] === openMarker) {
        open = !open;
        openMarker = fence[1] ?? '```';
      }
      out.push(line);
      continue;
    }
    if (open && !fenceAhead[i] && /^ {0,3}#{1,6} \S/.test(line)) {
      out.push(openMarker);
      open = false;
    }
    // ③ 容缺空格："##关闭结果" → "## 关闭结果"（仅非围栏区）
    if (!open && /^ {0,3}(#{1,6})(?=[^\s#])/.test(line)) {
      out.push(line.replace(/^ {0,3}(#{1,6})(?=[^\s#])/, '$1 '));
      continue;
    }
    out.push(line);
  }
  if (open) out.push(openMarker);
  return out.join('\n');
}

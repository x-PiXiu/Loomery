// Diff 规则（ADR-0020）：纯数据变换，下沉 domain —— 渲染层（DiffPane）与适配器共用
// 2026-11-13 唯一匹配语义（P0①）：oldLines 是"上下文锚点"而非行号坐标——LLM 的行号常因前序编辑漂移/尾随空白习惯
// 而逐行精确匹配失败 → 重试烧步数。改为内容定位：oldLines 在文件中唯一出现即可自动重锚；0 处=内容已变，>1 处=歧义。
import type { DiffHunk, DiffProposal } from '../diff';

/** 行归一化：忽略行尾空白（LLM 尾随空格/制表习惯），保留行首缩进（结构性信息） */
function normLine(l: string | undefined): string {
  return (l ?? '').replace(/\s+$/, '');
}

/** 内容定位 oldLines 在文件中的唯一锚点；oldLines 为空=纯插入（按 oldStart 定位返回 -1） */
function findUniqueAnchor(
  lines: string[],
  oldLines: string[],
): { ok: true; anchor: number } | { ok: false; error: string } {
  if (oldLines.length === 0) return { ok: true, anchor: -1 };
  const matches: number[] = [];
  for (let p = 0; p + oldLines.length <= lines.length; p++) {
    let hit = true;
    for (let i = 0; i < oldLines.length; i++) {
      if (normLine(lines[p + i]) !== normLine(oldLines[i])) {
        hit = false;
        break;
      }
    }
    if (hit) {
      matches.push(p);
      if (matches.length > 1) break;
    }
  }
  if (matches.length === 0) {
    return { ok: false, error: 'oldLines 内容在文件中未找到——文件可能已变化，请先 read_file 刷新后重试' };
  }
  if (matches.length > 1) {
    return { ok: false, error: `oldLines 内容匹配到 ${matches.length} 处——请在 oldLines 上下文中多带几行使其唯一，或改用 write_file 整体覆盖` };
  }
  return { ok: true, anchor: matches[0] ?? 0 };
}

/**
 * 解析 hunks：校验 + 内容重锚（返回锚定到真实位置的 hunks，供 diff 预览与应用共用）。
 * 整洁架构：定位规则是业务规则 → domain 纯函数；适配器只负责 IO。
 */
export function resolveHunks(
  fileContent: string | null,
  hunks: DiffHunk[],
): { ok: true; resolved: DiffHunk[] } | { ok: false; error: string } {
  for (const [i, h] of hunks.entries()) {
    if (!Number.isInteger(h.oldStart) || h.oldStart < 1) {
      return { ok: false, error: `hunk[${i}].oldStart 必须为 ≥1 的整数` };
    }
  }
  if (fileContent === null) {
    for (const h of hunks) {
      if (h.oldLines.length > 0) return { ok: false, error: '新文件的 hunk 不应包含 oldLines' };
    }
    return { ok: true, resolved: hunks };
  }
  const lines = fileContent.split('\n');
  const resolved = hunks.map((h) => ({ ...h }));
  for (const [i, h] of resolved.entries()) {
    if (h.oldLines.length === 0) continue; // 纯插入：信任 oldStart
    const a = findUniqueAnchor(lines, h.oldLines);
    if (!a.ok) return { ok: false, error: `hunk@${h.oldStart}：${a.error}` };
    if (a.anchor >= 0 && a.anchor !== h.oldStart - 1) {
      resolved[i] = { ...h, oldStart: a.anchor + 1 };
    }
  }
  // 多 hunk 相互重叠校验（重锚后可能出现重叠——替换会互相踩踏）
  const spans = resolved
    .filter((h) => h.oldLines.length > 0)
    .map((h) => [h.oldStart - 1, h.oldStart - 1 + h.oldLines.length] as const)
    .sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1];
    const cur = spans[i];
    if (prev && cur && cur[0] < prev[1]) {
      return { ok: false, error: `hunk@${cur[0] + 1} 与前一个 hunk 的范围重叠——请合并为一个 hunk 或分开提交` };
    }
  }
  return { ok: true, resolved };
}

/** 兼容包装：仅校验（内部走 resolveHunks 的定位与重叠检查） */
export function validateHunks(
  fileContent: string | null,
  hunks: DiffHunk[],
): { ok: true } | { ok: false; error: string } {
  const r = resolveHunks(fileContent, hunks);
  return r.ok ? { ok: true } : r;
}

/** 从后往前应用，避免前面的修改使后面 hunk 的行号位移；空内容（新建文件）视为零行 */
export function applyHunks(content: string, hunks: DiffHunk[]): string {
  const lines = content.length === 0 ? [] : content.split('\n');
  const sorted = [...hunks].sort((a, b) => b.oldStart - a.oldStart);
  for (const h of sorted) {
    lines.splice(h.oldStart - 1, h.oldLines.length, ...h.newLines);
  }
  return lines.join('\n');
}

export function makeHunkProposal(
  path: string,
  hunks: DiffHunk[],
  toolCallId: string,
): DiffProposal {
  return {
    id: crypto.randomUUID(),
    path,
    hunks,
    status: 'pending',
    toolCallId,
    createdAt: Date.now(),
  };
}

/** write_file 的审批预览：旧内容 vs 新内容整体对比 */
export function makeFullFileProposal(
  path: string,
  oldContent: string | null,
  newContent: string,
  toolCallId: string,
): DiffProposal {
  return makeHunkProposal(
    path,
    [
      {
        oldStart: 1,
        oldLines: oldContent === null ? [] : oldContent.split('\n'),
        newStart: 1,
        newLines: newContent.split('\n'),
      },
    ],
    toolCallId,
  );
}

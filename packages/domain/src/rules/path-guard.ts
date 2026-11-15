// 07 §4 路径护栏：绝对路径是否位于任一工作区根内（ADR-0013 路径规范）
import { resolve, sep } from 'node:path';

const CASE_INSENSITIVE = process.platform === 'win32';

function normalize(p: string): string {
  const r = resolve(p);
  return CASE_INSENSITIVE ? r.toLowerCase() : r;
}

/**
 * 判定绝对路径是否位于任一工作区根内（含根本身）。
 * 调用方必须传绝对路径；symlink 的 realpath 校验由适配器层在调用前完成。
 */
export function isPathInsideWorkspace(absolutePath: string, roots: string[]): boolean {
  const target = normalize(absolutePath);
  return roots.some((root) => {
    const base = normalize(root);
    if (target === base) return true;
    const prefix = base.endsWith(sep) ? base : base + sep;
    return target.startsWith(prefix);
  });
}

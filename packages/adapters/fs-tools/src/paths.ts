import { isAbsolute, resolve } from 'node:path';

/** 相对路径以第一个工作区根为基准解析（ADR-0013：领域内一律绝对路径） */
export function toAbsolute(p: string, roots: string[]): string {
  if (isAbsolute(p)) return p;
  return resolve(roots[0] ?? process.cwd(), p);
}

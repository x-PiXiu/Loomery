// ADR-0013 补全：领土实勘——字符串层护栏（domain/path-guard）只看见路径文本，
// workspace 内一个指向域外的 symlink/junction 就能让 write_file 穿透审批门。
// 本模块是 ports.ToolContext.verifyTerritory 的适配器实现：realpath 解析后重判领土。
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { isPathInsideWorkspace } from '@loomery/domain';

/**
 * 最近存在祖先的 realpath 解析：目标路径可能尚不存在（新建文件），逐级上溯到
 * 存在的祖先做 realpath，再把剩余段拼回。上限 32 层；盘根仍失败时放弃解析
 * 返回原样（调用方的字符串层护栏兜底）。resolve 先行归一化，尾段不含 `..`。
 */
export async function resolveRealPath(p: string): Promise<string> {
  let cur = resolve(p);
  const tail: string[] = [];
  for (let i = 0; i < 32; i++) {
    try {
      const real = await realpath(cur);
      if (tail.length === 0) return real;
      return resolve(real, ...tail.reverse().filter((s) => s.length > 0));
    } catch {
      const parent = resolve(cur, '..');
      if (parent === cur) return p;
      tail.push(cur.slice(parent.length).replace(/^[\\/]+/, ''));
      cur = parent;
    }
  }
  return p;
}

/**
 * 领土实勘器（symlink/junction 防线）：对绝对路径做 realpath 解析（Windows junction
 * 一并解析），解析结果不在 workspace ∪ scratch 内即抛错。工作区根本身是链接时同样
 * 先解析（合法：用户配置的根按真实位置放行）。
 * TOCTOU 窗口（校验后、写入前链接被调换）在单写者模型（单 Turn 串行、唯一写者是
 * agent 本身）下不构成实际攻击面；多进程并发写是已知差距（双窗口项）。
 */
export function makeTerritoryVerifier(
  roots: string[] | (() => string[]),
  scratchRoot?: string | null,
): (absPath: string) => Promise<void> {
  let realRoots: string[] | null = null;
  let realRootsSrc: string[] | null = null; // roots 引用身份缓存：项目增删（configSave 换数组）时重解析
  const ensureRoots = async (): Promise<string[]> => {
    const src = typeof roots === 'function' ? roots() : roots;
    if (realRoots === null || realRootsSrc !== src) {
      realRoots = [];
      for (const r of src) realRoots.push(await resolveRealPath(r));
      realRootsSrc = src;
    }
    return realRoots;
  };
  return async (absPath: string): Promise<void> => {
    if (!isAbsolute(absPath)) return; // 相对路径归字符串层护栏管（本契约只收绝对路径）
    const real = await resolveRealPath(absPath);
    const rs = await ensureRoots();
    if (isPathInsideWorkspace(real, rs)) return;
    if (scratchRoot && isPathInsideWorkspace(real, [scratchRoot])) return;
    throw new Error(`${absPath} 实际指向 ${real}，越出工作区`);
  };
}

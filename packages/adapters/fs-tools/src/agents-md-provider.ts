// AGENTS.md 项目级团队约定贡献者（2026-11-14 通电，B 类缺口"边界在位未接线"收口）
// 行业惯例文件名（AGENTS.md 同时是 Claude Code / Codex 的项目指令文件）；
// fs 读取归适配器层（内核不碰文件系统），provider 契约归 ports。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { estimateTokens } from '@loomery/domain';
import type { ContextChunk, ContextProvider, ContextProviderCtx } from '@loomery/ports';

const CAP_CHARS = 8000;

/**
 * 读线程工作区根的 AGENTS.md（存在且非空才注入）。线程根优先（多项目：
 * ctx.workspaceRoots 来自 loop 的线程路径域），缺省回退全局根。
 * 每 provide 读一次（每轮一次小文件读，可忽略）；超 8KB 截断（预算保护）。
 */
export function createProjectInstructionsProvider(getRoots: (ctx: ContextProviderCtx) => string[]): ContextProvider {
  return {
    id: 'project-instructions',
    priority: 2,
    async provide(ctx: ContextProviderCtx): Promise<ContextChunk | null> {
      const root = getRoots(ctx)[0];
      if (!root) return null;
      let text: string;
      try {
        text = await readFile(join(root, 'AGENTS.md'), 'utf8');
      } catch {
        return null; // 无项目指令文件=正常空态
      }
      const trimmed = text.trim();
      if (trimmed.length === 0) return null;
      const capped = trimmed.length > CAP_CHARS ? trimmed.slice(0, CAP_CHARS) + '\n…（超过 8KB 已截断）' : trimmed;
      return {
        providerId: 'project-instructions',
        text: `[项目级团队约定（工作区根目录 AGENTS.md）]\n${capped}`,
        priority: 2,
        tokens: estimateTokens(capped),
      };
    },
  };
}

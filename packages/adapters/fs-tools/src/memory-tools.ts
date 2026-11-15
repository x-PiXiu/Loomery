// ADR-0021/0022：任务记忆/简报/产物/技能四工具
// handler 只产 ToolResult；memoryPinned/briefUpdated/skillUsed 事件由管道统一发射（与 checkpointCreated 同模式）
import { createHash, randomUUID } from 'node:crypto';
import type { ArtifactStore, BriefStore, RegisteredTool, SkillRegistry } from '@loomery/ports';

export interface MemoryToolsDeps {
  briefs: BriefStore;
  artifacts: ArtifactStore;
  skills: SkillRegistry;
  /** ADR-0022：项目级技能首用确认记录；缺省视为全部已确认（不启用确认） */
  confirmed?: { isConfirmed(name: string): Promise<boolean>; confirm(name: string): Promise<void> };
}

export function createMemoryPin(): RegisteredTool {
  return {
    name: 'memory_pin',
    description:
      '把一条重要事实钉住为任务常驻记忆（用户说"记住…"时使用）。钉住的内容每轮注入上下文、预算裁剪永不碰。' +
      '适合记录：用户目标、关键约束、已定决策。不要钉存过程性/易变内容。',
    inputSchema: {
      type: 'object',
      required: ['content'],
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: '要记住的一句话（具体、可执行）' },
      },
    },
    sideEffect: 'write',
    source: 'builtin',
    handler: async (input, ctx) => {
      const { content } = input as { content: string };
      if (!ctx.threadId) return { ok: false, content: '缺少线程上下文，无法钉住。', affectedPaths: [] };
      const text = content.trim();
      if (text.length === 0) return { ok: false, content: '钉住内容为空。', affectedPaths: [] };
      return {
        ok: true,
        content: `已钉住：${text}`,
        affectedPaths: [],
        pinnedFact: {
          id: randomUUID(),
          kind: 'fact',
          content: text,
          createdAt: Date.now(),
          source: 'user-pinned',
          scope: 'task',
          threadId: ctx.threadId,
          status: 'active',
        },
      };
    },
  };
}

export function createBriefWrite(deps: MemoryToolsDeps): RegisteredTool {
  return {
    name: 'brief_write',
    description:
      '维护任务简报（每轮自动注入的常驻文档）。mode=replace 整体替换（缺省）；mode=append 在末尾追加一段。' +
      '简报应包含：目标、关键约束、已定决策、当前进度。保持精炼。',
    inputSchema: {
      type: 'object',
      required: ['content'],
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: '简报内容（整段或追加段）' },
        mode: { type: 'string', enum: ['replace', 'append'], description: '缺省 replace' },
      },
    },
    sideEffect: 'write',
    source: 'builtin',
    handler: async (input, ctx) => {
      const { content, mode } = input as { content: string; mode?: 'replace' | 'append' };
      if (!ctx.threadId) return { ok: false, content: '缺少线程上下文。', affectedPaths: [] };
      const prev = await deps.briefs.read(ctx.threadId);
      const next = mode === 'append' && prev ? prev.content + '\n' + content : content;
      const brief = await deps.briefs.write(ctx.threadId, next, 'agent');
      const hash = createHash('sha256').update(brief.content, 'utf8').digest('hex').slice(0, 16);
      return {
        ok: true,
        content: `简报已更新（rev ${brief.rev}，共 ${brief.content.length} 字符）。`,
        affectedPaths: [],
        briefUpdate: { threadId: ctx.threadId, rev: brief.rev, hash },
      };
    },
  };
}

export function createReadArtifact(deps: MemoryToolsDeps): RegisteredTool {
  return {
    name: 'read_artifact',
    description: '分页读取已存产物（超长工具输出/生成文档）的原文。观察结果里出现"已存为产物 <hash>"时用它取回细节。',
    inputSchema: {
      type: 'object',
      required: ['hash'],
      additionalProperties: false,
      properties: {
        hash: { type: 'string', description: '产物 hash（观察结果中给出）' },
        offset: { type: 'number', description: '字符偏移，缺省 0' },
      },
    },
    sideEffect: 'read',
    source: 'builtin',
    handler: async (input) => {
      const { hash, offset } = input as { hash: string; offset?: number };
      const content = await deps.artifacts.get(hash, offset ?? 0);
      if (content.length === 0) return { ok: false, content: `产物 ${hash} 不存在或偏移越界。`, affectedPaths: [] };
      return { ok: true, content, affectedPaths: [] };
    },
  };
}

export function createReadSkill(deps: MemoryToolsDeps): RegisteredTool {
  return {
    name: 'read_skill',
    description:
      '读取技能内容。缺省读 SKILL.md 主文档（附带该技能的附件清单）；传 path 可读技能内附件（如 references/ 下的章节）——' +
      '技能手册指向的附件务必用 path 读取原文，不要凭记忆转述。执行其中的脚本仍需走审批。',
    inputSchema: {
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '技能名（技能索引中给出）' },
        path: { type: 'string', description: '可选：技能内附件相对路径（如 references/00-xxx.md，来自附件清单）' },
      },
    },
    sideEffect: 'read',
    source: 'builtin',
    handler: async (input) => {
      const { name, path } = input as { name: string; path?: string };
      try {
        const manifest = (await deps.skills.scan()).find((m) => m.name === name);
        if (path) {
          // 附件模式：读技能内文件（域校验在 registry，防逃逸）
          const body = await deps.skills.readAttachment?.(name, path);
          if (body === undefined) return { ok: false, content: '该技能实现不支持附件读取', affectedPaths: [] };
          return {
            ok: true,
            content: body,
            inline: true,
            affectedPaths: [],
            ...(manifest ? { skillUsed: { name: manifest.name, scope: manifest.scope } } : {}),
          };
        }
        const body = await deps.skills.readBody(name);
        // 主文档附带附件清单：agent 由此知道手册引用的 references/ 等文件可被读取
        let attachments = '';
        try {
          const files = await deps.skills.listFiles?.(name);
          if (files && files.length > 0) attachments = '\n\n[技能附件] 以下文件可经 read_skill(name, path) 读取原文：\n' + files.map((f) => '- ' + f).join('\n');
        } catch { /* 单文件形态无附件 */ }
        return {
          ok: true,
          content: body + attachments,
          inline: true,
          affectedPaths: [],
          ...(manifest ? { skillUsed: { name: manifest.name, scope: manifest.scope } } : {}),
        };
      } catch (err) {
        return { ok: false, content: String(err instanceof Error ? err.message : err), affectedPaths: [] };
      }
    },
  };
}

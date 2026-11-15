// P2.0 batch1：MemoryRecallProvider 合并任务级事实（任务在前、pinned 恒前）+ 追加 BriefProvider/SkillIndexProvider 新文件
const fs = require('node:fs');

// 1) memory-provider.ts
{
  const p = 'agent-core/src/memory/memory-provider.ts';
  let s = fs.readFileSync(p, 'utf8');
  const oldProvide = `  async provide(ctx: ContextProviderCtx): Promise<ContextChunk | null> {
    if (!ctx.latestUserMessage) return null;
    const facts = await this.store.queryFacts(ctx.latestUserMessage, this.topK);
    if (facts.length === 0) return null;
    const text = \`## 长期记忆（跨会话召回）\n\${facts.map((f) => \`- \${f.content}\`).join('\n')}\`;
    return {
      providerId: this.id,
      priority: this.priority,
      tokens: estimateTokens(text),
      text,
    };
  }`;
  const newProvide = `  async provide(ctx: ContextProviderCtx): Promise<ContextChunk | null> {
    if (!ctx.latestUserMessage) return null;
    // ADR-0021：任务级事实优先（pinned 恒前），全局事实补足去重
    const taskFacts = this.store.queryTaskFacts
      ? await this.store.queryTaskFacts(ctx.threadId, ctx.latestUserMessage, this.topK)
      : [];
    const globalFacts = await this.store.queryFacts(ctx.latestUserMessage, this.topK);
    const seen = new Set(taskFacts.map((f) => f.content));
    const facts = [...taskFacts, ...globalFacts.filter((f) => !seen.has(f.content))].slice(0, this.topK);
    if (facts.length === 0) return null;
    const text = '## 长期记忆（📌=本任务钉住；其余为提炼/跨会话）\n' + facts.map((f) => '- ' + (f.source === 'user-pinned' ? '📌 ' : '') + f.content).join('\n');
    return {
      providerId: this.id,
      priority: this.priority,
      tokens: estimateTokens(text),
      text,
    };
  }`;
  if (!s.includes(oldProvide)) { console.error('memory-provider OLD NOT FOUND'); process.exit(1); }
  s = s.replace(oldProvide, newProvide);
  fs.writeFileSync(p, s);
  console.log('memory-provider patched');
}

// 2) brief-provider.ts（新文件）
fs.writeFileSync('agent-core/src/memory/brief-provider.ts', `// ADR-0021：任务简报以 ContextProvider 身份每轮注入（≤3k tokens 超限截断）；pinned 语义=永不裁
import { estimateTokens } from '@loomery/domain';
import type { BriefStore, ContextChunk, ContextProvider, ContextProviderCtx } from '@loomery/ports';

const BRIEF_TOKEN_CAP = 3000;

export class BriefProvider implements ContextProvider {
  readonly id = 'task-brief';
  /** 简报是任务常驻记忆：priority 介于系统声明与记忆召回之间，且 pinned（仲裁永不裁） */
  readonly priority = 1;

  constructor(private readonly briefs: BriefStore) {}

  async provide(ctx: ContextProviderCtx): Promise<ContextChunk | null> {
    const brief = await this.briefs.read(ctx.threadId);
    if (!brief || brief.content.trim().length === 0) return null;
    let text = '## 任务简报（每轮自动注入的常驻记忆，维护它=维护任务状态）\n' + brief.content;
    if (estimateTokens(text) > BRIEF_TOKEN_CAP) {
      // 简报超限截断（字符级近似；简报自身重写由压缩沉淀负责）
      text = text.slice(0, BRIEF_TOKEN_CAP * 4) + '\n…[简报过长已截断，请用 brief_write 精简]';
    }
    return {
      providerId: this.id,
      priority: this.priority,
      tokens: estimateTokens(text),
      text,
      pinned: true,
    };
  }
}
`);

// 3) skills 模块（新目录）：SkillIndexProvider（索引注入 + 30s 扫描缓存）
fs.mkdirSync('agent-core/src/skills', { recursive: true });
fs.writeFileSync('agent-core/src/skills/skill-provider.ts', `// ADR-0022：技能索引以 ContextContributor 身份注入——只注"名+触发描述"（~40 tokens/个），body 永不自动进上下文
import { estimateTokens } from '@loomery/domain';
import type { ContextChunk, ContextProvider, ContextProviderCtx, SkillRegistry } from '@loomery/ports';

const SCAN_TTL_MS = 30_000;

export class SkillIndexProvider implements ContextProvider {
  readonly id = 'skill-index';
  /** 技能索引是廉价常驻知识：priority 与记忆召回同级 */
  readonly priority = 2;

  private cache: { at: number; text: string; tokens: number } | null = null;

  constructor(private readonly registry: SkillRegistry) {}

  async provide(_ctx: ContextProviderCtx): Promise<ContextChunk | null> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < SCAN_TTL_MS) {
      return { providerId: this.id, priority: this.priority, tokens: this.cache.tokens, text: this.cache.text };
    }
    const skills = await this.registry.scan().catch(() => []);
    if (skills.length === 0) return null;
    const text = '## 可用技能（判断相关后用 read_skill(name) 读取全文，不要凭记忆执行步骤）\n' +
      skills.map((s) => \`- \${s.name}（\${s.scope === 'project' ? '项目' : '用户'}）：\${s.description}\`).join('\n');
    this.cache = { at: now, text, tokens: estimateTokens(text) };
    return { providerId: this.id, priority: this.priority, tokens: this.cache.tokens, text };
  }
}
`);

fs.writeFileSync('agent-core/src/skills/index.ts', `export { SkillIndexProvider } from './skill-provider';
`);

// 4) agent-core index 导出
{
  const p = 'agent-core/src/index.ts';
  let s = fs.readFileSync(p, 'utf8');
  if (!s.includes('skills')) {
    s = s.trimEnd() + "\nexport { SkillIndexProvider } from './skills/skill-provider';\nexport { BriefProvider } from './memory/brief-provider';\n";
    fs.writeFileSync(p, s);
  }
  console.log('agent-core index exports:', s.includes('SkillIndexProvider'));
}
console.log('done');

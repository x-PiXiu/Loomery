// ADR-0022：技能索引注入——只注名称+触发描述（约 40 tokens/个），body 永不自动进上下文
import { estimateTokens } from '@loomery/domain';
import type { ContextChunk, ContextProvider, ContextProviderCtx, SkillRegistry } from '@loomery/ports';
import type { SkillManifest } from '@loomery/domain';

const SCAN_TTL_MS = 30_000;

export class SkillIndexProvider implements ContextProvider {
  readonly id = 'skill-index';
  /** 技能索引是廉价常驻知识：priority 与记忆召回同级 */
  readonly priority = 2;

  private cache: { at: number; skills: SkillManifest[] } | null = null;

  constructor(
    private readonly registry: SkillRegistry,
    /** 停用谓词（设置页开关；实时过滤，缓存只存扫描结果） */
    private readonly isDisabled?: (name: string) => boolean,
  ) {}

  async provide(_ctx: ContextProviderCtx): Promise<ContextChunk | null> {
    const now = Date.now();
    if (!this.cache || now - this.cache.at >= SCAN_TTL_MS) {
      const skills = await this.registry.scan().catch(() => []);
      this.cache = { at: now, skills };
    }
    // 停用过滤在每次 provide 实时应用（开关切换即时生效，不等扫描缓存过期）
    const skills = this.cache.skills.filter((s) => !this.isDisabled?.(s.name));
    if (skills.length === 0) return null;
    const text =
      '## 可用技能（判断相关后用 read_skill(name) 读取全文，不要凭记忆执行步骤）\n' +
      skills.map((s) => '- ' + s.name + '（' + (s.scope === 'project' ? '项目' : '用户') + '）：' + s.description).join('\n');
    return { providerId: this.id, priority: this.priority, tokens: estimateTokens(text), text };
  }
}

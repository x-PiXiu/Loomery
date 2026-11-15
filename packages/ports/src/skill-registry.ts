// ADR-0022：技能（程序性知识）——双作用域扫描；body 按需加载，永不自动进上下文
import type { SkillManifest } from '@loomery/domain';

export interface SkillRegistry {
  /** 扫描 user（userData/skills）+ project（<ws>/.loomery/skills）两作用域 */
  scan(): Promise<SkillManifest[]>;
  /** 读 SKILL.md 全文（read_skill 工具用；按 name 命中任一作用域） */
  readBody(name: string): Promise<string>;
  /** 技能附件清单（skill 目录内相对路径，SKILL.md 除外）；可选——无附件能力的实现可缺省 */
  listFiles?(name: string): Promise<string[]>;
  /** 读技能内附件（相对路径；实现负责域校验防逃逸）；可选 */
  readAttachment?(name: string, relPath: string): Promise<string>;
}

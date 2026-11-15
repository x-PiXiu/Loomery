// 03 §8 长期记忆条目（ADR-0021 扩展：任务级 scope/溯源/状态，只增不改）
export interface MemoryFact {
  id: string;
  kind: 'preference' | 'convention' | 'fact';
  content: string;
  createdAt: number;
  source: 'extracted' | 'user-pinned';
  /** ADR-0021：缺省 'global'；任务级记忆携带 threadId，压缩/召回按任务优先 */
  scope?: 'task' | 'global';
  threadId?: string;
  /** 溯源：来自哪一轮（提炼/pinned 均记） */
  turnId?: string;
  /** 新事实覆盖旧事实时旧条目置 superseded，不物理删除 */
  status?: 'active' | 'superseded';
}

// ---- 任务简报 / 中间产物 / 技能（ADR-0021/0022）----

/** 任务简报：文件为主的外部文档（userData/memory/tasks/<threadId>.md），每轮装配注入 */
export interface Brief {
  threadId: string;
  content: string;
  /** 每次写递增；briefUpdated 事件审计用 */
  rev: number;
}

/** 中间产物引用：上下文与事件里只有它（hash+摘要），blob 本体在 artifacts/ 内容寻址 */
export interface ArtifactRef {
  /** sha256 前 16 位 */
  hash: string;
  kind: 'tool-output' | 'plan' | 'report';
  /** 一行摘要（进上下文/事件） */
  summary: string;
  size: number;
}

/** 技能清单：只含索引字段（body 永不自动进上下文，ADR-0022） */
export interface SkillManifest {
  name: string;
  /** 触发描述，注入索引用 */
  description: string;
  scope: 'user' | 'project';
  /** SKILL.md 绝对路径 */
  entry: string;
  /** 磁盘目录/文件名（导入复制按它定位；可与 name 不同——name 来自 frontmatter） */
  dirName?: string;
  /** 单文件形态（源是 <dirName>.md 而非目录，导入时规范化为目录） */
  singleFile?: boolean;
}

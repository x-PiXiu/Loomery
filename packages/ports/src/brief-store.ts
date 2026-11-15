// ADR-0021：任务简报——文件为主的外部文档（人类可手编），内核经端口读写现值
// briefUpdated 事件只做审计（actor/rev/hash），重放不据此重建
import type { Brief } from '@loomery/domain';

export interface BriefStore {
  /** 读现值（装配与 UI 均读它）；无简报返回 null */
  read(threadId: string): Promise<Brief | null>;
  /** 写入并递增 rev；actor 记录变更来源供审计 */
  write(threadId: string, content: string, actor: 'user' | 'agent'): Promise<Brief>;
  /** ADR-0021 简报超限自动重写：归档当前版本到 .archive/（保留历史区），返回归档路径；无简报返回 null */
  archive(threadId: string): Promise<string | null>;
}

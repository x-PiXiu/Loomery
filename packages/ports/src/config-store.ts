// 03 §11：配置存储端口（P1 JSON 实现；企业策略层作为叠加配置源合并，只允许改严）
import type { AppConfig } from '@loomery/domain';

export interface ConfigStore {
  load(): Promise<AppConfig>;
  save(patch: Partial<AppConfig>): Promise<void>;
}

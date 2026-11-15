// 07 §5 Checkpoint 端口（2026-11-14 端口化补全）：Turn 级文件快照与回滚契约。
// 消费方=组合根（RPC 回滚/审查页）与 fs 工具（写前懒快照）；fs-tools 提供唯一实现。
// 快照编码（路径→单层文件名）与滚动保留策略是实现细节，不进契约。
export interface CheckpointRestoreResult {
  /** 成功还原（或删除）的文件 */
  restored: string[];
  /** 还原失败的文件（逐条容错，不拖垮整轮回滚） */
  failed: string[];
}

export interface CheckpointPort {
  /** Turn 内某路径首次被写前懒快照；返回是否实际新建（同 Turn 同路径幂等） */
  snapshot(turnId: string, file: string): Promise<boolean>;
  /** 本 Turn 快照的文件清单（审查页"上一轮更改"数据源） */
  listFiles(turnId: string): Promise<string[]>;
  /** 读取某文件的本轮快照内容（diff 对照基线）；无快照返回 null */
  readSnapshot(turnId: string, file: string): Promise<string | null>;
  /** 还原本 Turn 全部快照（新建文件删除、修改文件还原） */
  restore(turnId: string): Promise<CheckpointRestoreResult>;
}

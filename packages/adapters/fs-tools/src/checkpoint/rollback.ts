// 回滚编排：还原 + 事件由调用方（shell/RPC 层）发布 checkpointRestored
import type { CheckpointPort } from '@loomery/ports';

export async function rollbackTurn(
  service: CheckpointPort,
  turnId: string,
): Promise<{ restored: string[]; failed: string[] }> {
  return service.restore(turnId);
}

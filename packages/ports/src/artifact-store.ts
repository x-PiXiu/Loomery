// ADR-0021：中间产物——内容寻址不可变证据；上下文与事件只携带 ref（hash+summary）
import type { ArtifactRef } from '@loomery/domain';

export interface ArtifactStore {
  put(content: string, meta: { threadId: string; turnId?: string; kind: ArtifactRef['kind']; summary: string }): Promise<ArtifactRef>;
  /** 分页取回：offset 为字符偏移；超出范围返回空串 */
  get(hash: string, offset?: number): Promise<string>;
  list(threadId: string): Promise<ArtifactRef[]>;
}

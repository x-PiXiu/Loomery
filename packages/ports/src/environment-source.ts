// 04 §2 流向 B 的接收端端口：编辑器/UI → 内核通知，context 据此失效 provider 缓存
import type { EnvironmentEvent } from '@loomery/domain';

export interface EnvironmentEventSource {
  /** 返回取消订阅函数 */
  subscribe(cb: (event: EnvironmentEvent) => void): () => void;
}

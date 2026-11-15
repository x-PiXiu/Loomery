// 事件是内核对外的唯一广播通道；扇出（渲染转发 + 日志落盘）由组合根装配
import type { LoopEvent } from '@loomery/domain';

export interface EventSink {
  publish(event: LoopEvent): void;
}

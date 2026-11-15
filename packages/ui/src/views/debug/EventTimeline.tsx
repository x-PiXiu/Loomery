// 06 §4.5 调试时间线（开发模式）：全部事件按 seq 排列
import { type ReactElement } from 'react';
import { useRuntime } from '../../stores/runtime';

export function EventTimeline(): ReactElement {
  const events = useRuntime((s) => s.events);
  return (
    <div className="panel">
      <div className="panel-head">事件时间线（最近 {events.length} 条）</div>
      <div className="panel-body">
        {events.map((e, i) => (
          <div key={`${e.id}_${i}`} className="debug-line">
            #{String(e.seq).padStart(4, '0')} [{e.type}] {e.threadId.slice(0, 10)} {e.turnId ? `turn=${e.turnId.slice(0, 8)}` : ''} {e.step !== undefined ? `step=${e.step}` : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

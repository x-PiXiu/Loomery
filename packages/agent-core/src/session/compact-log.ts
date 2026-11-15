// 存储 GC（#3 磁盘无限增长治理）：把 append-only JSONL 重写为"重放等价"的稀疏事件流
// 设计约束（ADR-0008 重放确定性）：
//  ① 消息态完全等价——被压缩掉的消息其生成事件（textDelta/observation 等，体积大头）整体删除，
//     保留最后一条 memoryCompressed（其摘要即折叠结果）；seq 原值保留（摘要 id = restored_summary_<seq>，
//     跨重放/重写稳定，见 restore.ts）
//  ② 审计与读模型基础永删不净——usageDelta（用量统计按日折叠）、memoryPinned/Unpinned/Extracted
//    （任务记忆读模型）、checkpointCreated（回滚清单）、brief/skill/护栏/审批全部保留
//  ③ 纯函数：输入原事件流，输出等价事件流；等价性由 rebuildThread 前后对比测试锁定
import type { LoopEvent } from '@loomery/domain';
import { rebuildThread } from './restore';

/** 事件归属 Turn：envelope.turnId 优先，载荷 turnId 兜底 */
function turnIdOf(e: LoopEvent): string | undefined {
  return e.turnId ?? (e.payload as { turnId?: string }).turnId;
}

/** 全量保审事件：与消息体积无关、删了就丢审计/统计/读模型基础的事件类型 */
const KEEP_ALL = new Set<LoopEvent['type']>([
  'threadCreated', 'threadTitleChanged', 'threadMoved',
  'usageDelta', 'checkpointCreated', 'checkpointRestored',
  'memoryPinned', 'memoryUnpinned', 'memoryExtracted',
  'skillUsed', 'briefUpdated', 'guardrailTriggered', 'error',
  'approvalRequired', 'approvalResolved', 'contextAssembled',
]);

/** 消息生成事件：按 messageId/userMessageId 是否仍在折叠态判定 */
const MESSAGE_EVENTS = new Set<LoopEvent['type']>(['turnStarted', 'textDelta', 'toolCallComplete', 'observationAdded']);

/** 轮过程事件：按归属 Turn 是否保留判定（timers/停止标记等 UI 重放语义） */
const TURN_EVENTS = new Set<LoopEvent['type']>([
  'stepStarted', 'stepCompleted', 'retrying', 'turnCompleted', 'turnCancelled', 'loopTerminated',
]);

export function compactForStorage(events: LoopEvent[]): LoopEvent[] {
  if (events.length === 0) return events;
  const rebuilt = rebuildThread(events);
  const keptIds = new Set(rebuilt.messages.map((m) => m.id));

  // toolCallId → messageId（observationAdded 配对用；从原始事件建立，不依赖保留子集）
  const messageByToolCall = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'toolCallComplete') messageByToolCall.set(e.payload.toolCallId, e.payload.messageId);
  }
  // 保留的 Turn = 其用户消息仍在折叠态
  const keptTurnIds = new Set<string>();
  for (const e of events) {
    if (e.type === 'turnStarted' && keptIds.has(e.payload.userMessageId)) keptTurnIds.add(e.payload.turnId);
  }
  // 只保留最后一条 memoryCompressed：其摘要即当前折叠态的唯一摘要（单摘要不变量）
  let lastCompressedSeq = -1;
  for (const e of events) {
    if (e.type === 'memoryCompressed') lastCompressedSeq = e.seq;
  }

  return events.filter((e) => {
    if (e.type === 'threadResumed') return false; // 瞬时通告（恢复时按需重发），不留档
    if (e.type === 'memoryCompressed') return e.seq === lastCompressedSeq;
    if (KEEP_ALL.has(e.type)) return true;
    if (MESSAGE_EVENTS.has(e.type)) {
      if (e.type === 'turnStarted') return keptIds.has(e.payload.userMessageId);
      if (e.type === 'observationAdded') {
        const mid = messageByToolCall.get(e.payload.toolCallId);
        return mid !== undefined && keptIds.has(mid);
      }
      if (e.type === 'textDelta' || e.type === 'toolCallComplete') return keptIds.has(e.payload.messageId);
      return true; // 防御：未知消息事件保守保留
    }
    if (TURN_EVENTS.has(e.type)) {
      const t = turnIdOf(e);
      return t !== undefined && keptTurnIds.has(t);
    }
    return true; // 未知类型保守保留（前向兼容：新事件不因 GC 丢失）
  });
}

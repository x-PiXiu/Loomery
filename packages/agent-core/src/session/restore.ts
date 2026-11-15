// 05 §7 会话恢复：状态永远由事件重放推导（ADR-0008），不另存状态快照
import type { ChatMessage, LoopEvent } from '@loomery/domain';

export interface RebuiltThread {
  threadId: string;
  title: string;
  /** 所属项目根（threadCreated/threadMoved 折叠，后到为准） */
  workspaceRoot?: string;
  /** 重放重建的消息（含 memoryCompressed 的摘要替换） */
  messages: ChatMessage[];
  turnIds: string[];
  /** 有 turnStarted 但从未收到 turnCompleted/turnCancelled 的 Turn */
  interruptedTurnIds: string[];
  /** approvalRequired 后未见 approvalResolved 的审批（恢复时按策略置 rejected/重问） */
  pendingApprovalIds: string[];
  checkpointTurnIds: string[];
  /** 最大 seq——FanoutSink.resetSeq 续接计数 */
  seq: number;
  usageTokens: number;
}

export function rebuildThread(events: LoopEvent[]): RebuiltThread {
  const byId = new Map<string, ChatMessage>();
  const order: string[] = [];
  const messageIdByToolCall = new Map<string, string>();
  const toolCallBy = new Map<string, { name: string }>();

  let title = '';
  let workspaceRoot: string | undefined = undefined;
  let usageTokens = 0;
  let seq = 0;
  const turnIds: string[] = [];
  const turnUserMessage = new Map<string, string>();
  const closedTurns = new Set<string>();
  const pendingApprovals = new Set<string>();
  const checkpointTurns: string[] = [];

  const ensure = (id: string, role: ChatMessage['role'], createdAt: number): ChatMessage => {
    let m = byId.get(id);
    if (!m) {
      m = { id, role, createdAt, parts: [] };
      byId.set(id, m);
      order.push(id);
    }
    return m;
  };

  for (const e of events) {
    seq = Math.max(seq, e.seq);
    switch (e.type) {
      case 'threadCreated':
        title = e.payload.title;
        break;
      case 'threadTitleChanged':
        // 自动/手动重命名的标题以后到的为准；漏掉这条会导致重启后标题全部回退"新会话"
        title = e.payload.title;
        break;
      case 'threadMoved':
        workspaceRoot = e.payload.workspaceRoot;
        break;
      case 'turnStarted': {
        turnIds.push(e.payload.turnId);
        turnUserMessage.set(e.payload.turnId, e.payload.userMessageId);
        const m = ensure(e.payload.userMessageId, 'user', e.ts);
        const text = e.payload.userText ?? '';
        if (text.length > 0 && !m.parts.some((p) => p.kind === 'text' && p.text === text)) {
          m.parts.push({ kind: 'text', text });
        }
        break;
      }
      case 'textDelta': {
        const m = ensure(e.payload.messageId, 'assistant', e.ts);
        const last = m.parts[m.parts.length - 1];
        if (last && last.kind === 'text') last.text += e.payload.text;
        else m.parts.push({ kind: 'text', text: e.payload.text });
        break;
      }
      case 'toolCallComplete': {
        const m = ensure(e.payload.messageId, 'assistant', e.ts);
        messageIdByToolCall.set(e.payload.toolCallId, e.payload.messageId);
        toolCallBy.set(e.payload.toolCallId, { name: e.payload.name });
        if (!m.parts.some((p) => p.kind === 'tool-call' && p.toolCallId === e.payload.toolCallId)) {
          m.parts.push({
            kind: 'tool-call',
            toolCallId: e.payload.toolCallId,
            name: e.payload.name,
            args: e.payload.args,
          });
        }
        break;
      }
      case 'observationAdded': {
        const messageId = messageIdByToolCall.get(e.payload.toolCallId);
        if (!messageId) break; // 无配对 tool-call 的观察（防御）
        const m = byId.get(messageId);
        if (m && !m.parts.some((p) => p.kind === 'tool-result' && p.toolCallId === e.payload.toolCallId)) {
          const call = toolCallBy.get(e.payload.toolCallId);
          m.parts.push({
            kind: 'tool-result',
            toolCallId: e.payload.toolCallId,
            content: e.payload.content ?? e.payload.preview,
            truncated: e.payload.truncated,
            originalChars: e.payload.originalChars,
          });
          void call;
        }
        break;
      }
      case 'usageDelta':
        usageTokens += e.payload.inputTokens + e.payload.outputTokens;
        break;
      case 'memoryCompressed': {
        // ADR-0012：重放时按 compressedMessageIds 替换为摘要消息，保证确定性
        const removed = new Set(e.payload.compressedMessageIds);
        const summaryMessage: ChatMessage = {
          id: `restored_summary_${e.seq}`,
          role: 'assistant',
          createdAt: e.ts,
          parts: [{ kind: 'summary', text: e.payload.summary, summarizedRange: [1, e.payload.compressedMessageIds.length] }],
        };
        const firstIndex = order.findIndex((id) => removed.has(id));
        for (const id of removed) {
          byId.delete(id);
        }
        if (firstIndex >= 0) {
          order.splice(firstIndex, removed.size, summaryMessage.id);
        } else {
          order.unshift(summaryMessage.id);
        }
        byId.set(summaryMessage.id, summaryMessage);
        break;
      }
      case 'approvalRequired':
        pendingApprovals.add(e.payload.approvalId);
        break;
      case 'approvalResolved':
        pendingApprovals.delete(e.payload.approvalId);
        break;
      case 'checkpointCreated':
        if (e.turnId) checkpointTurns.push(e.turnId);
        break;
      case 'turnCompleted':
      case 'turnCancelled': {
        const turnId = e.type === 'turnCompleted' ? '' : e.payload.turnId;
        if (e.type === 'turnCancelled') closedTurns.add(turnId);
        else {
          // turnCompleted 载荷只有 outcome；用 envelope.turnId 反查
          if (e.turnId) closedTurns.add(e.turnId);
        }
        break;
      }
      default:
        break;
    }
  }

  const interruptedTurnIds = turnIds.filter((t) => !closedTurns.has(t));
  return {
    threadId: events[0]?.threadId ?? '',
    title: title || '未命名会话',
    ...(workspaceRoot ? { workspaceRoot } : {}),
    messages: order.map((id) => byId.get(id)).filter((m): m is ChatMessage => m !== undefined),
    turnIds,
    interruptedTurnIds,
    pendingApprovalIds: [...pendingApprovals],
    checkpointTurnIds: checkpointTurns,
    seq,
    usageTokens,
  };
}

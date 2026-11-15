// 06 §4：事件 reducer → 视图模型（唯一状态来源，谦卑对象）；不做任何业务判断
import { useSyncExternalStore } from 'react';
import type { AgentMode, AppConfig, DiffProposal, LoopEvent, PlanStep, Thread } from '@loomery/domain';

export type ToolStatus = 'requested' | 'awaiting-approval' | 'running' | 'done' | 'failed' | 'rejected';

export interface MessageItem {
  kind: 'message';
  role: 'user' | 'assistant';
  messageId: string;
  text: string;
  streaming?: boolean;
  turnId?: string;
  /** 思考过程（reasoningDelta 聚合）与时长 ms */
  reasoning?: string;
  /** 是否为最后一条带正文的助手消息（操作行显示条件，渲染层计算） */
  showActions?: boolean;
  reasoningMs?: number;
  reasoningStartedAt?: number;
  /** docs/16 多模态：用户消息附带的截图 */
  images?: { mime: string; base64: string }[];
}
export interface ToolItem {
  turnId?: string;
  kind: 'tool';
  toolCallId: string;
  name: string;
  status: ToolStatus;
  durationMs?: number;
  preview?: string;
  /** 原始参数 JSON（摘要展示用） */
  args?: string;
  /** 12 UI：写工具的 diff 统计（工具行右侧 +N -M）与提案（点击打开 diff 视图） */
  added?: number;
  removed?: number;
  proposal?: DiffProposal;
  /** docs/16：工具截图（ToolCard 缩略图渲染） */
  images?: { mime: string; base64: string }[];
}
export interface ApprovalItem {
  turnId?: string;
  proposal?: DiffProposal;
  kind: 'approval';
  approvalId: string;
  toolCallId: string;
  toolName: string;
  diffText: string;
  /** docs/15 前的审批卡美化：原始工具参数（命令类审批显示 command/cwd，不再出现空洞的"无 diff 预览"） */
  input?: Record<string, unknown>;
  resolved: 'approved' | 'rejected' | 'modified' | null;
}
export interface NoticeItem {
  turnId?: string;
  kind: 'notice';
  text: string;
  tone?: 'warn';
}
export type ChatItem = MessageItem | ToolItem | ApprovalItem | NoticeItem;

export interface TurnChanges {
  turnId: string;
  files: string[];
  added: number;
  removed: number;
}

/** 线程视图条目：domain Thread + UI 计算的 busy（选择器/状态点用） */
export type ThreadRow = Thread & { busy: boolean };

export interface RuntimeState {
  threads: ThreadRow[];
  activeThreadId: string | null;
  items: ChatItem[];
  events: LoopEvent[];
  mode: AgentMode;
  tokens: number;
  phase: 'idle' | 'running' | 'awaiting-approval';
  terminated: { reason: string; finalSummary?: string } | null;
  checkpoint: { turnId: string; files: string[] } | null;
  config: AppConfig | null;
  pinned: string[];
  turnChanges: TurnChanges | null;
  turnUsage: { inputTokens: number; outputTokens: number; steps: number; startedAt: number; endedMs?: number } | null;
  /** 最近一轮的 diff 提案（按文件路径；DiffPane 跳转用） */
  proposals: Record<string, DiffProposal>;
  /** 本任务累计工作时长 ms 与当前进行中 Turn 的起点（已工作 X 秒用） */
  workMs: number;
  runningTurnAt: number | null;
  /** 每轮工作时长 ms（turnId → ms，过程折叠条用） */
  turnDurations: Record<string, number>;
  /** 进行中 Turn 的 id */
  runningTurnId: string | null;
  /** 每轮结束原因（turnId → reason），非 natural 的轮在流内标「已停止·回复可能不完整」 */
  turnEnds: Record<string, string>;
  /** 每轮问答独立用量（turnId → ↑输入/↓输出/步数；一轮=一次用户请求到其回复完成） */
  turnUsageByTurn: Record<string, { inputTokens: number; outputTokens: number; steps: number }>;
  /** ADR-0026：计划步骤快照（turnId → 全量清单，last-write-wins；胶囊进程区数据源） */
  planByTurn: Record<string, PlanStep[]>;
  /** 最近一步模型返回的真实 prompt tokens（容量圈用，覆盖式） */
  lastInputTokens: number;
  /** 外部文件变更（#7 watcher 推送，路径 → 时刻；cap 50，横幅/回滚提示数据源） */
  externalChanges: Record<string, number>;
}

const initialState: RuntimeState = {
  threads: [],
  activeThreadId: null,
  items: [],
  events: [],
  mode: 'edit',
  tokens: 0,
  phase: 'idle',
  terminated: null,
  checkpoint: null,
  externalChanges: {},
  config: null,
  pinned: JSON.parse(localStorage.getItem('loomery.pinned') ?? '[]') as string[],
  turnChanges: null,
  turnUsage: null,
  lastInputTokens: 0,
  proposals: {},
  workMs: 0,
  runningTurnAt: null,
  turnDurations: {},
  runningTurnId: null,
  turnEnds: {},
  turnUsageByTurn: {},
  planByTurn: {},
};

type Listener = () => void;

class RuntimeStore {
  private state: RuntimeState = initialState;
  private readonly listeners = new Set<Listener>();

  getState = (): RuntimeState => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  set = (patch: Partial<RuntimeState>): void => {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  };

  resetForThread(threadId: string, items: ChatItem[]): void {
    this.set({ activeThreadId: threadId, items, tokens: 0, phase: 'idle', terminated: null, checkpoint: null, turnChanges: null, turnUsage: null, lastInputTokens: 0, proposals: {}, workMs: 0, runningTurnAt: null, turnDurations: {}, runningTurnId: null, turnEnds: {}, turnUsageByTurn: {} });
  }

  /** 打开任务 = 事件重放（ADR-0008）：与实时流共用同一 reducer，视图状态天然一致 */
  replayEvents(threadId: string, events: LoopEvent[]): void {
    this.set({ activeThreadId: threadId, items: [], tokens: 0, phase: 'idle', terminated: null, checkpoint: null, turnChanges: null, turnUsage: null, lastInputTokens: 0, proposals: {}, events: [], workMs: 0, runningTurnAt: null, turnDurations: {}, runningTurnId: null, turnEnds: {}, turnUsageByTurn: {} });
    this.replaying = true;
    try {
      for (const ev of events) this.applyEvent(ev);
    } finally {
      this.replaying = false;
    }
  }

  togglePin(threadId: string): void {
    const pinned = this.state.pinned.includes(threadId)
      ? this.state.pinned.filter((x) => x !== threadId)
      : [...this.state.pinned, threadId];
    localStorage.setItem('loomery.pinned', JSON.stringify(pinned));
    this.set({ pinned });
  }

  /** #7 外部文件变更：合并进横幅数据源（cap 50，最新覆盖） */
  noteExternalChanges(paths: string[]): void {
    const merged: Record<string, number> = { ...this.state.externalChanges };
    for (const p of paths) {
      delete merged[p];
      merged[p] = Date.now();
    }
    const entries = Object.entries(merged).slice(-50);
    this.set({ externalChanges: Object.fromEntries(entries) });
  }

  /** 用户点横幅 ✕：清空当前横幅 */
  dismissExternalChanges(): void {
    this.set({ externalChanges: {} });
  }

  private replaying = false;

  applyEvent(ev: LoopEvent): void {
    const s = this.state;
    const mine = ev.threadId === s.activeThreadId;
    // 重放期间：跳过会影响全局列表的副作用事件，其余按 mine 处理（activeThreadId 已先行设置）
    // memoryCompressed 的 🗜 通告只在实时压缩时出现一次——重放历史压缩不重复打扰
    if (this.replaying && (ev.type === 'threadCreated' || ev.type === 'threadTitleChanged' || ev.type === 'memoryCompressed')) return;
    let { items, threads, mode, tokens, phase, terminated, checkpoint, turnChanges, turnUsage, lastInputTokens, proposals, workMs, runningTurnAt, turnDurations, runningTurnId, turnEnds, turnUsageByTurn, planByTurn } = s;
    const events = [...s.events, ev].slice(-400);
    const curTurn: string | undefined = ev.turnId;

    const append = (item: ChatItem): void => {
      items = [...items, item];
    };
    const patchTool = (toolCallId: string, patch: Partial<ToolItem>): void => {
      items = items.map((i) => (i.kind === 'tool' && i.toolCallId === toolCallId ? { ...i, ...patch } : i));
    };
    const toolNameOf = (toolCallId: string): string =>
      items.find((i): i is ToolItem => i.kind === 'tool' && i.toolCallId === toolCallId)?.name ?? '';

    switch (ev.type) {
      case 'turnStarted':
        if (mine) {
          append({ kind: 'message', role: 'user', messageId: ev.payload.userMessageId, text: ev.payload.userText ?? '', turnId: ev.payload.turnId, ...(ev.payload.images && ev.payload.images.length > 0 ? { images: ev.payload.images } : {}) });
          phase = 'running';
          terminated = null;
          turnChanges = { turnId: ev.payload.turnId, files: [], added: 0, removed: 0 };
          turnUsage = { inputTokens: 0, outputTokens: 0, steps: 0, startedAt: ev.ts };
          proposals = {};
          runningTurnAt = ev.ts;
          runningTurnId = ev.payload.turnId;
        }
        break;
      case 'textDelta': {
        if (!mine) break;
        let found = false;
        items = items.map((i) => {
          if (i.kind === 'message' && i.role === 'assistant' && i.messageId === ev.payload.messageId) {
            found = true;
            return { ...i, text: i.text + ev.payload.text, streaming: true, reasoningMs: i.reasoning !== undefined && i.reasoningStartedAt !== undefined ? Math.max(ev.ts - i.reasoningStartedAt, i.reasoningMs ?? 0) : i.reasoningMs };
          }
          return i;
        });
        if (!found) append({ kind: 'message', role: 'assistant', messageId: ev.payload.messageId, text: ev.payload.text, streaming: true, turnId: curTurn });
        break;
      }
      case 'reasoningDelta': {
        if (!mine) break;
        let rFound = false;
        items = items.map((i) => {
          if (i.kind === 'message' && i.role === 'assistant' && i.messageId === ev.payload.messageId) {
            rFound = true;
            const startedAt = i.reasoningStartedAt ?? ev.ts;
            return { ...i, reasoning: (i.reasoning ?? '') + ev.payload.text, reasoningStartedAt: startedAt, reasoningMs: Math.max(ev.ts - startedAt, i.reasoningMs ?? 0) };
          }
          return i;
        });
        if (!rFound) append({ kind: 'message', role: 'assistant', messageId: ev.payload.messageId, text: '', reasoning: ev.payload.text, reasoningStartedAt: ev.ts, reasoningMs: 0, turnId: curTurn });
        break;
      }
      case 'toolCallComplete':
        if (mine) append({ kind: 'tool', toolCallId: ev.payload.toolCallId, name: ev.payload.name, status: 'requested', args: ev.payload.args, turnId: curTurn });
        break;
      case 'approvalRequired':
        if (mine) {
          const d = ev.payload.diffProposal;
          const diffText = d
            ? d.hunks
                .map((h) =>
                  [`@@ -${h.oldStart} +${h.newStart} @@`, ...h.oldLines.map((l) => `-${l}`), ...h.newLines.map((l) => `+${l}`)].join('\n'),
                )
                .join('\n')
            : '';
          patchTool(ev.payload.toolCallId, { status: 'awaiting-approval' });
          append({ kind: 'approval', approvalId: ev.payload.approvalId, toolCallId: ev.payload.toolCallId, toolName: toolNameOf(ev.payload.toolCallId), diffText, resolved: null, turnId: curTurn, ...(ev.payload.input !== undefined && ev.payload.input !== null ? { input: ev.payload.input as Record<string, unknown> } : {}), ...(ev.payload.diffProposal ? { proposal: ev.payload.diffProposal } : {}) });
          phase = 'awaiting-approval';
        }
        break;
      case 'approvalResolved':
        if (mine) {
          items = items.map((i) => (i.kind === 'approval' && i.approvalId === ev.payload.approvalId ? { ...i, resolved: ev.payload.decision } : i));
          phase = 'running';
        }
        break;
      case 'diffProposed':
        if (mine) {
          const st = turnChanges?.turnId === (ev.turnId ?? '') ? turnChanges : { turnId: ev.turnId ?? '', files: [] as string[], added: 0, removed: 0 };
          const p = ev.payload.proposal;
          if (!st.files.includes(p.path)) st.files = [...st.files, p.path];
          st.added += p.hunks.reduce((sum, h) => sum + h.newLines.length, 0);
          st.removed += p.hunks.reduce((sum, h) => sum + h.oldLines.length, 0);
          // 提案入册：总结卡"审查"与文件级 ±统计都从这里取（此前从未写入，导致按钮点击无效）
          proposals = { ...proposals, [p.path]: p };
          turnChanges = st;
        }
        break;
      case 'stepCompleted':
        if (mine && turnUsage) turnUsage = { ...turnUsage, steps: turnUsage.steps + 1 };
        if (mine && ev.turnId) {
          const acc = turnUsageByTurn[ev.turnId] ?? { inputTokens: 0, outputTokens: 0, steps: 0 };
          turnUsageByTurn = { ...turnUsageByTurn, [ev.turnId]: { ...acc, steps: acc.steps + 1 } };
        }
        break;
      case 'toolExecuted':
        if (mine) {
          const dp = ev.payload.proposal;
          patchTool(ev.payload.toolCallId, {
            status: 'done',
            durationMs: ev.payload.durationMs,
            ...(dp ? { added: dp.hunks.reduce((s, h) => s + h.newLines.length, 0), removed: dp.hunks.reduce((s, h) => s + h.oldLines.length, 0), proposal: dp } : {}),
            ...(ev.payload.images && ev.payload.images.length > 0 ? { images: ev.payload.images } : {}),
          });
          if (ev.payload.affectedPaths.length > 0 && turnChanges) {
            turnChanges = {
              ...turnChanges,
              files: [...new Set([...turnChanges.files, ...ev.payload.affectedPaths])],
            };
          }
        }
        break;
      case 'toolFailed':
        if (mine) patchTool(ev.payload.toolCallId, { status: 'failed', preview: ev.payload.error });
        break;
      case 'observationAdded':
        if (mine) patchTool(ev.payload.toolCallId, { status: 'done', preview: ev.payload.preview });
        break;
      case 'usageDelta':
        if (mine) {
          tokens += ev.payload.inputTokens + ev.payload.outputTokens;
          lastInputTokens = ev.payload.inputTokens;
          if (ev.turnId) {
            const acc = turnUsageByTurn[ev.turnId] ?? { inputTokens: 0, outputTokens: 0, steps: 0 };
            turnUsageByTurn = { ...turnUsageByTurn, [ev.turnId]: { ...acc, inputTokens: acc.inputTokens + ev.payload.inputTokens, outputTokens: acc.outputTokens + ev.payload.outputTokens } };
          }
          if (turnUsage) {
            turnUsage = {
              ...turnUsage,
              inputTokens: turnUsage.inputTokens + ev.payload.inputTokens,
              outputTokens: turnUsage.outputTokens + ev.payload.outputTokens,
            };
          }
        }
        break;
      case 'guardrailTriggered': {
        if (mine) {
          const ruleLabel: Record<string, string> = {
            pathOutside: '路径越界',
            dangerousCommand: '危险命令',
            readonlyBlocked: '只读限制',
            schemaInvalid: '参数不合法',
            injectionWarning: '疑似提示词注入',
          };
          append({ kind: 'notice', turnId: curTurn, text: `🛡 护栏拦截（${ruleLabel[ev.payload.rule] ?? ev.payload.rule}）：${ev.payload.detail}`, tone: 'warn' });
        }
        break;
      }
      case 'retrying':
        if (mine) append({ kind: 'notice', text: `模型重试中（第 ${ev.payload.attempt} 次）：${ev.payload.reason}`, turnId: curTurn });
        break;
      case 'error':
        if (mine) append({ kind: 'notice', text: `错误：${ev.payload.message}`, tone: 'warn', turnId: curTurn });
        break;
      case 'loopTerminated':
        if (mine) {
          items = items.map((i) => (i.kind === 'tool' && (i.status === 'requested' || i.status === 'running') ? { ...i, status: 'failed' as ToolStatus, preview: i.preview ?? '轮次结束，工具未返回结果' } : i));
          terminated = { reason: ev.payload.reason, finalSummary: ev.payload.finalSummary };
          if (turnUsage && turnUsage.startedAt > 0) {
          turnUsage = { ...turnUsage, endedMs: ev.ts - turnUsage.startedAt };
          workMs = workMs + Math.max(0, ev.ts - (runningTurnAt ?? ev.ts));
          if (ev.turnId) turnDurations = { ...turnDurations, [ev.turnId]: Math.max(0, ev.ts - (runningTurnAt ?? ev.ts)) };
          runningTurnAt = null;
        }
          // 轮结束原因不依赖 turnUsage 门槛：极早停止（尚无用量）也要能标记
          if (ev.turnId) turnEnds = { ...turnEnds, [ev.turnId]: ev.payload.reason };
          phase = 'idle';
        }
        break;
      case 'memoryPinned':
        if (mine) append({ kind: 'notice', text: `📌 已记住：${ev.payload.fact.content}`, turnId: curTurn });
        break;
      case 'memoryUnpinned':
        break; // 面板数据走 RPC 读模型（P2.0 下一批），流内不打扰
      case 'planUpdated':
        // ADR-0026：全量快照覆盖写（last-write-wins；重放恢复免费）
        // key = threadId:turnId（跨线程切换不串数据；resetForThread 不清空本 map）
        if (mine && ev.turnId) planByTurn = { ...planByTurn, [`${ev.threadId}:${ev.turnId}`]: ev.payload.steps };
        break;
      case 'briefUpdated':
        break; // 简报文件为主，事件仅审计；简报面板下一批
      case 'artifactStored':
        break; // 观察结果内已带摘要+hash 行，流内不重复
      case 'skillUsed':
        break; // 记账事件，技能面板下一批
      case 'memoryExtracted':
        break; // 弱提示由后续批次决定；事件已入册
      case 'memoryCompressed':
        // 手动压缩（无 turnId）与自动压缩（轮末触发）共用同一条链，均给出可见反馈
        if (mine) append({ kind: 'notice', text: `🗜 已压缩历史${ev.payload.tokensSaved ? `，节省约 ${ev.payload.tokensSaved} tokens` : ''}：最早的消息已折叠为摘要`, turnId: curTurn });
        break;
      case 'memoryRecalled':
        if (mine && ev.payload.previews && ev.payload.previews.length > 0) {
          append({ kind: 'notice', text: '🔗 参考记忆：' + ev.payload.previews.join('；'), turnId: curTurn });
        }
        break;
      case 'turnCompleted':
      case 'turnCancelled':
        if (mine) phase = 'idle';
        break;
      case 'checkpointCreated':
        if (mine) checkpoint = { turnId: ev.turnId ?? '', files: ev.payload.files };
        break;
      case 'checkpointRestored':
        if (mine) {
          const ext = ev.payload.externallyChanged?.length ?? 0;
          append({ kind: 'notice', text: `已回滚 ${ev.payload.restoredFiles.length} 个文件${ev.payload.failedFiles.length ? `，失败 ${ev.payload.failedFiles.length}` : ''}${ext > 0 ? `；其中 ${ext} 个在检查点后被外部修改过，回滚已覆盖外部改动` : ''}` });
          // 回滚落地：本轮总结卡随撤销消失，避免再对已还原的更改点"审查/撤销"
          if (turnChanges && ev.payload.turnId === turnChanges.turnId) {
            turnChanges = null;
            checkpoint = null;
          }
        }
        break;
      case 'modeChanged':
        mode = ev.payload.mode;
        break;
      case 'threadTitleChanged':
        threads = threads.map((t) => (t.id === ev.payload.threadId ? { ...t, title: ev.payload.title } : t));
        break;
      case 'threadMoved':
        threads = threads.map((t) => (t.id === ev.payload.threadId ? { ...t, workspaceRoot: ev.payload.workspaceRoot } : t));
        break;
      case 'threadResumed':
        if (mine) {
          const parts: string[] = [`已恢复 ${ev.payload.restoredTurnCount} 轮对话`];
          if (ev.payload.interruptedTurnIds.length > 0) parts.push(`${ev.payload.interruptedTurnIds.length} 轮未完成已中止`);
          if (ev.payload.pendingApprovalCount) parts.push(`${ev.payload.pendingApprovalCount} 个未决审批已失效`);
          append({ kind: 'notice', text: parts.join('，'), tone: 'warn' });
        }
        break;
      case 'threadCreated':
        threads = [...threads, { id: ev.payload.threadId, title: ev.payload.title, turnIds: [], busy: false, createdAt: ev.ts, ...(ev.payload.workspaceRoot ? { workspaceRoot: ev.payload.workspaceRoot } : {}) }];
        break;
      default:
        break;
    }

    this.state = { ...s, events, items, threads, mode, tokens, phase, terminated, checkpoint, turnChanges, turnUsage, lastInputTokens, proposals, workMs, runningTurnAt, turnDurations, runningTurnId, turnEnds, turnUsageByTurn, planByTurn };
    for (const l of this.listeners) l();
  }
}

export const runtime = new RuntimeStore();

export function useRuntime<T>(selector: (s: RuntimeState) => T): T {
  return useSyncExternalStore(runtime.subscribe, () => selector(runtime.getState()));
}

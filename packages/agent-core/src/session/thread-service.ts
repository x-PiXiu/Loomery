// 05 §7 ThreadService：四级状态机的编排入口——创建/发送/取消/恢复 + Turn 后记忆管线
// （短期压缩与长期提炼在 Turn 完成后触发，闭合 ADR-0012 的接线）
import { compressIfNeeded, type CompressOutcome } from '../memory/short-term';
import { extractFacts, scopeExtractedFacts } from '../memory/long-term';
import { runTurn } from '../loop/agent-loop';
import { newId } from '../events/id';
import type { FanoutSink } from '../events/fanout-sink';
import type { ContextAssembler } from '../context/assembler';
import type { ToolPipeline } from '../tools/pipeline';
import type { ToolRegistry } from '../tools/registry';
import type { BriefStore } from '@loomery/ports';
import { createHash } from 'node:crypto';
import { estimateTokens, RESIDENT_THREAD_LIMIT } from '@loomery/domain';
import type { RebuiltThread } from './restore';
import { compactForStorage } from './compact-log';
import type {
  AgentMode, Budget, ChatMessage, LoopEvent, LoopEventPayloads, MemoryFact,
} from '@loomery/domain';
import type { Clock, MemoryStore, ModelClient } from '@loomery/ports';

export interface ThreadServiceDeps {
  sink: FanoutSink;
  store: MemoryStore;
  model: ModelClient;
  pipeline: ToolPipeline;
  registry: ToolRegistry;
  /** 当前生效模型 id（usageDelta 出处归因）：可传函数——模型热切换后出处跟随实际所用 */
  modelId?: string | (() => string);
  assembler: ContextAssembler;
  clock: Clock;
  systemBase: () => string;
  budget: Budget;
  contextBudgetTokens: number;
  workspaceRoots: string[];
  /** ADR-0021：任务暂存区根（透传 loop → pipeline 写路径合法域） */
  scratchRoot?: string;
  /** 领土实勘（symlink/junction 防线，适配器注入，透传 loop → pipeline） */
  verifyTerritory?: (absPath: string) => Promise<void>;
  /** ADR-0021：任务简报仓库（超限自动重写用）；缺省不启用 */
  briefs?: BriefStore;
  /** 短期压缩配置；缺省不压缩 */
  compress?: { thresholdTokens?: number; keepRecentGroups?: number };
  /** 内存治理：驻留全量消息的任务数上界（LRU 卸载；缺省 RESIDENT_THREAD_LIMIT） */
  residency?: { maxResident: number };
  /** ADR-0023 触发器埋点：恢复/重放耗时观测（缺省不观测） */
  metrics?: { observe(kind: 'hydrate', ms: number, meta?: { events?: number }): void };
}

interface ThreadState {
  title: string;
  /** null = 未恢复（lite 元数据态）：JSONL 是事实源，首次使用时按需 rebuild */
  messages: ChatMessage[] | null;
  turnIds: string[];
  createdAt: number;
  workspaceRoot?: string;
  /** 任务累计 token（usageDelta 折叠口径）：seed=启动折叠，hydrate/restore=事件重建，send=增量累加；卸载保留 */
  usageMeta?: number;
  /** LRU 依据：最近一次使用时刻 */
  lastUsedAt: number;
}

interface ActiveTurn {
  turnId: string;
  controller: AbortController;
}

export class ThreadService {
  private readonly threads = new Map<string, ThreadState>();
  private readonly active = new Map<string, ActiveTurn>();

  constructor(private readonly deps: ThreadServiceDeps) {}

  private emit<T extends keyof LoopEventPayloads>(
    threadId: string,
    type: T,
    payload: LoopEventPayloads[T],
  ): LoopEvent {
    return this.deps.sink.emit({ threadId, type, payload } as never);
  }

  async createThread(title = '新会话', workspaceRoot?: string): Promise<string> {
    const threadId = newId('thread');
    this.threads.set(threadId, { title, messages: [], turnIds: [], createdAt: this.deps.clock.now(), lastUsedAt: this.deps.clock.now(), ...(workspaceRoot ? { workspaceRoot } : {}) });
    this.emit(threadId, 'threadCreated', { threadId, title, ...(workspaceRoot ? { workspaceRoot } : {}) });
    return threadId;
  }

  /** 内存治理·播种：启动时只注册 lite 元数据（不读第二遍日志、不恢复消息）——首次使用时 ensureHydrated */
  seed(meta: { id: string; title: string; createdAt: number; workspaceRoot?: string; usageTokens?: number; maxSeq?: number }): void {
    if (this.threads.has(meta.id)) return;
    this.threads.set(meta.id, {
      title: meta.title,
      messages: null, // lite：JSONL 是事实源，消息留待按需恢复
      turnIds: [],
      createdAt: meta.createdAt,
      ...(meta.usageTokens !== undefined ? { usageMeta: meta.usageTokens } : {}),
      ...(meta.workspaceRoot ? { workspaceRoot: meta.workspaceRoot } : {}),
      lastUsedAt: 0,
    });
    // seq 续接（种子口径）：否则重启后的元数据事件（threadMoved/threadTitleChanged）拿到 seq=1，
    // 与既有事件主键 (threadId,seq) 碰撞被 INSERT OR IGNORE 静默吞掉——「移动任务重启后撤销」的根因
    if (meta.maxSeq && meta.maxSeq > 0) this.deps.sink.resetSeq(meta.id, meta.maxSeq);
  }

  /** 按需恢复：lite 态 → 从事件日志 rebuild 消息（静默，不发 threadResumed；未决审批落拒绝事件闭环） */
  private async ensureHydrated(threadId: string): Promise<void> {
    const state = this.threads.get(threadId);
    if (!state || state.messages !== null) return;
    const { rebuildThread: rebuild } = await import('./restore');
    const t0 = this.deps.clock.now();
    const events = await this.deps.store.loadEvents(threadId);
    const rebuilt = rebuild(events);
    this.deps.metrics?.observe('hydrate', this.deps.clock.now() - t0, { events: events.length });
    state.messages = rebuilt.messages;
    state.turnIds = rebuilt.turnIds;
    if (rebuilt.workspaceRoot) state.workspaceRoot = rebuilt.workspaceRoot;
    state.usageMeta = rebuilt.usageTokens; // 事件是真值：覆盖 seed 缓存（同口径幂等）
    this.deps.sink.resetSeq(threadId, rebuilt.seq);
    // 挂起审批已随进程消亡：落拒绝事件闭环（与 restore 同语义，推迟到首次触碰）
    for (const approvalId of rebuilt.pendingApprovalIds) {
      this.emit(threadId, 'approvalResolved', { approvalId, decision: 'rejected' });
    }
  }

  /** LRU 触摸 */
  private touch(threadId: string): void {
    const state = this.threads.get(threadId);
    if (state) state.lastUsedAt = this.deps.clock.now();
  }

  /** 内存治理·卸载：驻留（已恢复）任务数超上界时按最久未用丢弃消息——运行中不可卸载，usageMeta 保留 */
  private maybeEvict(): void {
    const maxResident = this.deps.residency?.maxResident ?? RESIDENT_THREAD_LIMIT;
    const hydrated = [...this.threads.entries()].filter(([id, t]) => t.messages !== null && !this.active.has(id));
    let excess = hydrated.length - maxResident;
    if (excess <= 0) return;
    hydrated.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [, state] of hydrated) {
      if (excess <= 0) break;
      state.messages = null;
      state.turnIds = [];
      excess -= 1;
    }
  }

  /** 每 Thread 同时只允许一个活跃 Turn（05 §7） */
  isBusy(threadId: string): boolean {
    return this.active.has(threadId);
  }

  /** 任务队列（FIFO 深度 1）：busy 时新 send 入队而非抛错——连点发送不再失败，Turn 结束自动续发。
   * 串行不变量保留：同一时刻仍只有一个活跃 Turn。cancel 只停当前轮，排队消息照常续发（停止≠撤回新指令）。 */
  private readonly queued = new Map<string, { text: string; mode: AgentMode; images?: { mime: string; base64: string }[] }>();

  async send(threadId: string, text: string, mode: AgentMode, images?: { mime: string; base64: string }[]): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`未知会话 ${threadId}`);
    if (this.isBusy(threadId)) {
      if (this.queued.has(threadId)) throw new Error('该会话已有进行中的请求，且队列中已有一条待发消息——请等它们完成后再发送');
      this.queued.set(threadId, { text, mode, images });
      return;
    }

    const controller = new AbortController();
    const turnId = newId('turn');
    const userMessage: ChatMessage = {
      id: newId('msg'),
      role: 'user',
      // docs/16：图像 part 在前、文本在后（translate 层按模型 vision 能力裁决是否发送图像）
      parts: [...(images ?? []).map((img) => ({ kind: 'image' as const, mime: img.mime, base64: img.base64 })), { kind: 'text', text }],
      createdAt: this.deps.clock.now(),
    };
    this.active.set(threadId, { turnId, controller });
    try {
      // 内存治理：lite 态按需恢复（JSONL → messages），发送前触摸 LRU
      await this.ensureHydrated(threadId);
      this.touch(threadId);
      const result = await runTurn(
        {
          threadId,
          turnId,
          mode,
          // 出处归因随活引用解析（函数式 deps）：切模型后新 Turn 的 usageDelta 记实际所用
          model: (typeof this.deps.modelId === 'function' ? this.deps.modelId() : this.deps.modelId) ?? 'main',
          userMessage,
          history: [...(thread.messages ?? [])],
          // 多项目：路径域按线程归属（缺省回退全局首根）
          workspaceRoots: thread.workspaceRoot ? [thread.workspaceRoot] : undefined,
          abortController: controller,
        },
        {
          model: this.deps.model,
          pipeline: this.deps.pipeline,
          registry: this.deps.registry,
          context: this.deps.assembler,
          sink: this.deps.sink,
          clock: this.deps.clock,
          systemBase: this.deps.systemBase, // 活引用直传（loop 每步调用读取最新 persona）
          budget: this.deps.budget,
          contextBudgetTokens: this.deps.contextBudgetTokens,
          workspaceRoots: this.deps.workspaceRoots,
          ...(this.deps.scratchRoot ? { scratchRoot: this.deps.scratchRoot } : {}),
          ...(this.deps.verifyTerritory ? { verifyTerritory: this.deps.verifyTerritory } : {}),
        },
      );
      thread.messages = result.messages;
      thread.turnIds.push(turnId);
      // 任务级 usage 连续记账：seed/恢复口径（usageDelta 折叠）+ 每 Turn 增量，跨卸载/恢复周期保持
      thread.usageMeta = (thread.usageMeta ?? 0) + result.usage.inputTokens + result.usage.outputTokens;
      // 自动标题：首个 Turn 完成后用首条用户消息生成（04 A1 threadTitleChanged）
      if (thread.title === '新会话' && text.trim().length > 0) {
        thread.title = text.trim().slice(0, 24) + (text.trim().length > 24 ? '…' : '');
        this.emit(threadId, 'threadTitleChanged', { threadId, title: thread.title });
      }
      if (!result.cancelled) {
        await this.afterTurn(threadId, result.messages, turnId);
      }
    } finally {
      this.active.delete(threadId);
      this.maybeEvict(); // 内存治理：Turn 结束是驻留峰值点，顺手收敛
      // 任务队列续发：Turn 结束自动发出排队消息（递归经同一 send 入口，失败只记日志不炸会话）
      const next = this.queued.get(threadId);
      if (next) {
        this.queued.delete(threadId);
        void this.send(threadId, next.text, next.mode, next.images).catch((err: unknown) => {
          console.error('[queue] 排队消息发送失败:', err instanceof Error ? err.message : err);
        });
      }
    }
  }

  cancel(threadId: string): boolean {
    const active = this.active.get(threadId);
    if (!active) return false;
    active.controller.abort();
    return true;
  }

  /** Turn 完成后：短期压缩（事件化）→ 压缩即沉淀 → 长期提炼入库（05 §6 / ADR-0021） */
  private async afterTurn(threadId: string, messages: ChatMessage[], turnId?: string): Promise<void> {
    if (this.deps.compress) {
      await this.runCompression(threadId, messages, turnId, this.deps.compress).catch((err: unknown) => {
        console.error('[memory] 压缩失败（不影响主流程）:', err);
      });
    }
    try {
      const facts = await extractFacts(this.deps.model, messages, this.deps.clock.now());
      this.distill(threadId, turnId, facts);
    } catch (err) {
      console.error('[memory] 提炼失败（不影响主流程）:', err);
    }
    await this.compactBriefIfOverflow(threadId);
  }

  /** 压缩执行 + 事件发布 + 压缩即沉淀（自动与手动共用的同一条链） */
  private async runCompression(
    threadId: string,
    messages: ChatMessage[],
    turnId: string | undefined,
    opts: { thresholdTokens?: number; keepRecentGroups?: number },
  ): Promise<CompressOutcome | null> {
    const outcome = await compressIfNeeded(messages, { ...opts, now: this.deps.clock.now() }, (conversationText) => this.summarizeCheap(conversationText));
    if (!outcome) return null;
    this.threads.get(threadId)!.messages = outcome.messages;
    const event = this.emit(threadId, 'memoryCompressed', {
      compressedMessageIds: outcome.compressedIds,
      summary: outcome.summary,
      tokensSaved: outcome.tokensSaved,
    });
    // 摘要 id 与重放口径对齐（restore.ts 折叠出 restored_summary_<seq>）——否则跨重启的多轮压缩
    // 会因旧摘要 id 对不上而无法删除，重放出重复摘要
    const first = outcome.messages[0];
    if (first && first.parts[0]?.kind === 'summary') first.id = `restored_summary_${event.seq}`;
    void this.gcStorage(threadId, event); // 存储 GC（fire-and-forget，失败只记日志）
    // ADR-0021 压缩即沉淀：对将被压缩掉的消息补提炼 ≤5 条——压掉 ≠ 忘掉
    const byId = new Map(messages.map((m) => [m.id, m]));
    const removed = outcome.compressedIds.map((id) => byId.get(id)).filter((m): m is ChatMessage => !!m);
    if (removed.length > 0) {
      const distilled = (await extractFacts(this.deps.model, removed, this.deps.clock.now())).slice(0, 5);
      this.distill(threadId, turnId, distilled);
    }
    return outcome;
  }

  /** 存储 GC（#3 磁盘无限增长治理）：压缩后把 JSONL 重写为重放等价的稀疏事件流 */
  private async gcStorage(threadId: string, justEmitted: LoopEvent): Promise<void> {
    const rewrite = this.deps.store.rewriteEvents;
    if (!rewrite) return;
    try {
      const loaded = await this.deps.store.loadEvents(threadId);
      // JournalSink 落盘是 fire-and-forget：刚发的事件可能尚未落文件——合并后参与压缩（load 侧 uuid 去重兜底竞态重复）
      const events = loaded.some((e) => e.id === justEmitted.id) ? loaded : [...loaded, justEmitted].sort((a, b) => a.seq - b.seq);
      const compacted = compactForStorage(events);
      if (compacted.length >= events.length) return;
      await rewrite.call(this.deps.store, threadId, compacted);
      console.log(`[journal] ${threadId}: 存储 GC ${events.length} → ${compacted.length} 事件`);
    } catch (err) {
      console.error('[journal] 存储 GC 失败（不影响主流程，日志继续追加）:', err);
    }
  }

  /** 手动压缩（P2）：强制对最老分组执行压缩，运行中/无压缩配置时拒绝 */
  async compactNow(threadId: string): Promise<{ ok: boolean; tokensSaved?: number; reason?: string }> {
    const thread = this.threads.get(threadId);
    if (!thread) return { ok: false, reason: '任务不存在' };
    if (this.active.has(threadId)) return { ok: false, reason: '任务正在运行，请等待本轮结束' };
    if (!this.deps.compress) return { ok: false, reason: '压缩未启用' };
    try {
      await this.ensureHydrated(threadId); // 内存治理：lite 态先恢复再压
      this.touch(threadId);
      const outcome = await this.runCompression(threadId, thread.messages ?? [], undefined, { ...this.deps.compress, thresholdTokens: 0 });
      if (!outcome) return { ok: true, reason: '没有可压缩的内容（消息太少）' };
      return { ok: true, tokensSaved: outcome.tokensSaved };
    } catch (err) {
      return { ok: false, reason: String(err instanceof Error ? err.message : err).slice(0, 200) };
    }
  }

  /** ADR-0021 简报超限自动重写：归档旧版（历史区）→ cheap 精简 → 写回（事件审计） */
  private async compactBriefIfOverflow(threadId: string): Promise<void> {
    const briefs = this.deps.briefs;
    if (!briefs) return;
    try {
      const brief = await briefs.read(threadId);
      if (!brief || estimateTokens(brief.content) <= 3000) return;
      const archived = await briefs.archive(threadId);
      const rewritten = await this.rewriteBrief(brief.content);
      if (!rewritten || estimateTokens(rewritten) >= estimateTokens(brief.content)) return; // 重写未收敛则放弃
      const next = await briefs.write(threadId, rewritten, 'agent');
      const hash = createHash('sha256').update(next.content, 'utf8').digest('hex').slice(0, 16);
      this.emit(threadId, 'briefUpdated', { threadId, rev: next.rev, hash, actor: 'agent' });
      console.log('[memory] 简报超限已重写并归档：' + (archived ?? ''));
    } catch (err) {
      console.error('[memory] 简报重写失败（不影响主流程）:', err);
    }
  }

  private async rewriteBrief(text: string): Promise<string> {
    const chunks: string[] = [];
    for await (const ev of this.deps.model.stream({
      modelTier: 'cheap',
      system: '以下是任务简报，已超长。精简为一半以内：保留目标、关键约束、已定决策、当前进度；删除过程性描述与重复内容。直接输出精简后的简报正文。',
      messages: [
        { id: newId('msg'), role: 'user', parts: [{ kind: 'text', text }], createdAt: this.deps.clock.now() },
      ],
      tools: [],
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'finish' && ev.finishReason === 'error') {
        throw new Error(`简报模型调用失败：${ev.errorMessage ?? '未知错误'}`);
      }
      if (ev.type === 'text-delta') chunks.push(ev.text);
    }
    return chunks.join('').trim();
  }

  /** 提炼落地（ADR-0021 分级）：全局走 saveFact；任务级经 memoryExtracted 事件承载 */
  private distill(threadId: string, turnId: string | undefined, facts: MemoryFact[]): void {
    if (facts.length === 0) return;
    const { global, task } = scopeExtractedFacts(facts, threadId, turnId);
    void Promise.all(global.map((f) => this.deps.store.saveFact(f))).catch((err: unknown) => {
      console.error('[memory] 全局事实落库失败:', err);
    });
    const emitted = [...global, ...task];
    this.emit(threadId, 'memoryExtracted', { facts: emitted });
  }

  private async summarizeCheap(conversationText: string): Promise<string> {
    const chunks: string[] = [];
    for await (const ev of this.deps.model.stream({
      modelTier: 'cheap',
      system: '将以下对话历史压缩为一段不超过 300 字的摘要，保留：用户目标、已做修改、未完成事项。直接输出摘要正文。',
      messages: [
        {
          id: newId('msg'),
          role: 'user',
          parts: [{ kind: 'text', text: conversationText.slice(-24_000) }],
          createdAt: this.deps.clock.now(),
        },
      ],
      tools: [],
      signal: new AbortController().signal,
    })) {
      // 流式失败以 finish{error} 事件承载（不抛错）——必须转译为异常，否则调用方拿到空摘要误判成功
      if (ev.type === 'finish' && ev.finishReason === 'error') {
        throw new Error(`摘要模型调用失败：${ev.errorMessage ?? '未知错误'}`);
      }
      if (ev.type === 'text-delta') chunks.push(ev.text);
    }
    return chunks.join('');
  }

  /** 重放恢复（M7）：重建内存状态 + 续接 seq；announce=false 用于启动静默装载 */
  async restore(threadId: string, opts?: { announce?: boolean }): Promise<RebuiltThread> {
    const { rebuildThread: rebuild } = await import('./restore');
    const events = await this.deps.store.loadEvents(threadId);
    if (events.length === 0) throw new Error(`会话 ${threadId} 没有事件日志`);
    const rebuilt = rebuild(events);
    this.threads.set(threadId, {
      title: rebuilt.title,
      messages: rebuilt.messages,
      turnIds: rebuilt.turnIds,
      createdAt: events[0]?.ts ?? 0,
      ...(rebuilt.workspaceRoot ? { workspaceRoot: rebuilt.workspaceRoot } : {}),
      // 事件真值覆盖（usageDelta 折叠）；后续 send 继续增量累加
      usageMeta: rebuilt.usageTokens,
      lastUsedAt: this.deps.clock.now(),
    });
    this.deps.sink.resetSeq(threadId, rebuilt.seq);
    // 挂起审批已随进程消亡：落拒绝事件闭环（审计语义准确），数量随 threadResumed 告知 UI
    for (const approvalId of rebuilt.pendingApprovalIds) {
      this.emit(threadId, 'approvalResolved', { approvalId, decision: 'rejected' });
    }
    if (opts?.announce !== false) {
      this.emit(threadId, 'threadResumed', {
        threadId,
        restoredTurnCount: rebuilt.turnIds.length,
        interruptedTurnIds: rebuilt.interruptedTurnIds,
        ...(rebuilt.pendingApprovalIds.length > 0
          ? { pendingApprovalCount: rebuilt.pendingApprovalIds.length }
          : {}),
      });
    }
    return rebuilt;
  }

  listThreads(): { id: string; title: string; busy: boolean; createdAt: number; workspaceRoot?: string; usageTokens?: number }[] {
    return [...this.threads.entries()].map(([id, t]) => ({
      id,
      title: t.title,
      busy: this.isBusy(id),
      createdAt: t.createdAt,
      ...(t.usageMeta !== undefined ? { usageTokens: t.usageMeta } : {}),
      ...(t.workspaceRoot ? { workspaceRoot: t.workspaceRoot } : {}),
    }));
  }

  /** 多项目：任务移动到另一项目（事件承载，重启折叠仍生效） */
  moveThread(threadId: string, workspaceRoot: string): void {
    const t = this.threads.get(threadId);
    if (!t) throw new Error(`任务 ${threadId} 不存在`);
    t.workspaceRoot = workspaceRoot;
    this.emit(threadId, 'threadMoved', { threadId, workspaceRoot });
  }

  /** 用户删除任务：中止进行中的 Turn 并移出内存（日志删除由调用方经 MemoryStore 完成） */
  forget(threadId: string): boolean {
    const active = this.active.get(threadId);
    if (active) {
      active.controller.abort();
      this.active.delete(threadId);
    }
    return this.threads.delete(threadId);
  }

  /** 用户重命名任务：内存 + threadTitleChanged 事件（落盘，重启后经 restore 保持） */
  rename(threadId: string, rawTitle: string): { ok: boolean; title?: string; error?: string } {
    const thread = this.threads.get(threadId);
    if (!thread) return { ok: false, error: `会话 ${threadId} 不存在` };
    const title = rawTitle.trim().slice(0, 60);
    if (title.length === 0) return { ok: false, error: '标题不能为空' };
    if (title === thread.title) return { ok: true, title };
    thread.title = title;
    this.emit(threadId, 'threadTitleChanged', { threadId, title });
    return { ok: true, title };
  }

  async getMessages(threadId: string): Promise<ChatMessage[]> {
    await this.ensureHydrated(threadId); // 内存治理：lite 态按需恢复
    this.touch(threadId);
    return this.threads.get(threadId)?.messages ?? [];
  }
}

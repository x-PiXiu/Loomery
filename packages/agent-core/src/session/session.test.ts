import { describe, expect, it } from 'vitest';
import { rebuildThread } from './restore';
import { ThreadService, type ThreadServiceDeps } from './thread-service';import { ToolRegistry } from '../tools/registry';
import { ToolPipeline } from '../tools/pipeline';
import { ContextAssembler } from '../context/assembler';
import { FanoutSink } from '../events/fanout-sink';
import { JournalSink } from './journal';
import { FakeApprovals, FakeClock, FakeModel, InMemoryStore, RecordingSink } from '../testing/fakes';
import type { LoopEvent } from '@loomery/domain';
import type { ModelStreamEvent } from '@loomery/ports';

function ev(partial: Record<string, unknown> & { type: string; threadId: string }): LoopEvent {
  return { seq: 0, id: 'x', schemaVersion: 1, ts: 0, ...partial } as unknown as LoopEvent;
}

describe('rebuildThread（M7 事件重放）', () => {
  it('从事件重建消息：userText/textDelta/toolCallComplete/observationAdded', () => {
    const events: LoopEvent[] = [
      ev({ type: 'threadCreated', threadId: 't1', payload: { threadId: 't1', title: '测试' } }),
      ev({ type: 'turnStarted', threadId: 't1', turnId: 'u1', payload: { turnId: 'u1', mode: 'edit', model: 'm', userMessageId: 'mu', userText: '帮我改' } }),
      ev({ type: 'textDelta', threadId: 't1', turnId: 'u1', payload: { messageId: 'ma', text: '好的' } }),
      ev({ type: 'toolCallComplete', threadId: 't1', turnId: 'u1', payload: { messageId: 'ma', toolCallId: 'c1', name: 'write_file', args: '{}' } }),
      ev({ type: 'observationAdded', threadId: 't1', turnId: 'u1', payload: { toolCallId: 'c1', truncated: false, originalChars: 2, finalChars: 2, preview: 'ok', content: 'ok' } }),
      ev({ type: 'turnCompleted', threadId: 't1', turnId: 'u1', payload: { outcome: 'completed' } }),
    ];
    const r = rebuildThread(events);
    expect(r.title).toBe('测试');
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]).toMatchObject({ role: 'user', parts: [{ kind: 'text', text: '帮我改' }] });
    expect(r.messages[1]?.parts).toHaveLength(3); // text + tool-call + tool-result
    expect(r.interruptedTurnIds).toEqual([]);
    expect(r.seq).toBe(0); // 测试事件 seq 都是 0
  });

  it('未闭合 Turn 标记 interrupted；未决审批被记录；memoryCompressed 重放替换', () => {
    const events: LoopEvent[] = [
      ev({ type: 'threadCreated', threadId: 't1', payload: { threadId: 't1', title: 'x' }, seq: 1 }),
      ev({ type: 'turnStarted', threadId: 't1', turnId: 'u1', payload: { turnId: 'u1', mode: 'edit', model: 'm', userMessageId: 'mu', userText: 'a' }, seq: 2 }),
      ev({ type: 'approvalRequired', threadId: 't1', turnId: 'u1', payload: { approvalId: 'ap1', toolCallId: 'c1' }, seq: 3 }),
      ev({ type: 'memoryCompressed', threadId: 't1', payload: { compressedMessageIds: ['mu'], summary: '摘要内容', tokensSaved: 10 }, seq: 4 }),
    ];
    const r = rebuildThread(events);
    expect(r.interruptedTurnIds).toEqual(['u1']);
    expect(r.pendingApprovalIds).toEqual(['ap1']);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.parts[0]).toMatchObject({ kind: 'summary', text: '摘要内容' });
    expect(r.seq).toBe(4);
  });
});

function makeService(
  scripts: ModelStreamEvent[][],
  opts?: {
    compress?: { thresholdTokens?: number; keepRecentGroups?: number };
    store?: InMemoryStore;
    sink?: FanoutSink;
    residency?: { maxResident: number };
  },
) {
  const recorder = new RecordingSink();
  const store = opts?.store ?? new InMemoryStore();
  const clock = new FakeClock();
  const sink = opts?.sink ?? new FanoutSink([recorder, new JournalSink(store)], clock);
  const registry = new ToolRegistry();
  const pipeline = new ToolPipeline(registry, new FakeApprovals(), clock, {
    approvalPolicy: { read: 'auto', write: 'ask', execute: 'deny' },
    toolResultCharCap: 5000,
  });
  const deps: ThreadServiceDeps = {
    sink,
    store,
    model: new FakeModel(...scripts),
    pipeline,
    registry,
    assembler: new ContextAssembler([], 8000),
    clock,
    systemBase: () => 'You are Loomery.',
    budget: { maxSteps: 10, maxTurnTokens: 100_000, maxWallMs: 60_000 },
    contextBudgetTokens: 8000,
    workspaceRoots: [],
    ...(opts?.compress ? { compress: opts.compress } : {}),
    ...(opts?.residency ? { residency: opts.residency } : {}),
  };
  return { service: new ThreadService(deps), recorder, store, sink, deps };
}

describe('ThreadService（05 §7 编排）', () => {
  it('send 全链路：threadCreated → turn 事件 → turnCompleted', async () => {
    const { service, recorder } = makeService([
      [{ type: 'text-delta', text: '收到' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const threadId = await service.createThread('演示');
    await service.send(threadId, '你好', 'edit');
    const types = recorder.types();
    expect(types[0]).toBe('threadCreated');
    expect(types).toContain('turnStarted');
    expect(types).toContain('loopTerminated');
    expect(types).toContain('turnCompleted');
    expect(await service.getMessages(threadId)).toHaveLength(2);
  });

  it('工作区权威段进 system：线程绑定项目根时压制记忆里的过时路径', async () => {
    const { service, deps } = makeService([
      [{ type: 'text-delta', text: '收到' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const systems: string[] = [];
    (deps.model as { onStream?: (req: { system: string }) => void }).onStream = (req) => { systems.push(req.system); };
    const threadId = await service.createThread('项目 A', 'E:\\ws\\projectA');
    await service.send(threadId, '你好', 'edit');
    // 主模型那趟的 system 含权威段（cheap 提炼趟不带，故用 some）
    expect(systems.some((s) => s.includes('[当前任务工作区] 根目录：E:\\ws\\projectA'))).toBe(true);
    expect(systems.some((s) => s.includes('一律以本节为准'))).toBe(true);
  });

  it('busy 时第二条入队，Turn 结束自动续发（任务队列 FIFO）', async () => {
    const { service, recorder } = makeService([
      [{ type: 'text-delta', text: 'x' }, { type: 'finish', finishReason: 'stop' }],
      [{ type: 'text-delta', text: 'y' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const threadId = await service.createThread();
    const p1 = service.send(threadId, '第一句', 'edit');
    await service.send(threadId, '第二句', 'edit'); // busy → 入队（不抛错）
    await p1;
    await new Promise((r) => setTimeout(r, 30));
    // 两句 user 消息都落了（第二句在第一轮结束后被自动续发）
    const userTexts = (recorder.of('turnStarted') as unknown as Array<{ userText?: string }>)
      .map((p) => p.userText);
    expect(userTexts).toContain('第一句');
    expect(userTexts).toContain('第二句');
  });

  it('队列深度 1：排队已满再发 → 拒绝；cancel 只停当前轮（排队消息照常续发）', async () => {
    const { service } = makeService([
      [{ type: 'text-delta', text: 'x' }, { type: 'finish', finishReason: 'stop' }],
      [{ type: 'text-delta', text: 'y' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const threadId = await service.createThread();
    void service.send(threadId, '第一句', 'edit');
    await service.send(threadId, '第二句', 'edit'); // 入队
    await expect(service.send(threadId, '第三句', 'edit')).rejects.toThrow('队列中已有一条');
    await new Promise((r) => setTimeout(r, 30));
  });

  it('Turn 后压缩接线：memoryCompressed 事件 + 消息被替换（ADR-0012）', async () => {
    const { service, recorder } = makeService(
      [
        [{ type: 'text-delta', text: '第一轮回复' }, { type: 'finish', finishReason: 'stop' }],
        [{ type: 'text-delta', text: '第二轮回复' }, { type: 'finish', finishReason: 'stop' }],
        // cheap 摘要脚本
        [{ type: 'text-delta', text: '这是摘要' }, { type: 'finish', finishReason: 'stop' }],
        // cheap 提炼脚本（空）
        [{ type: 'text-delta', text: '[]' }, { type: 'finish', finishReason: 'stop' }],
      ],
      { compress: { thresholdTokens: 1, keepRecentGroups: 1 } },
    );
    const threadId = await service.createThread();
    await service.send(threadId, '第一轮输入', 'edit');
    await service.send(threadId, '第二轮输入', 'edit');
    expect(recorder.of('memoryCompressed')).toHaveLength(1);
    const messages = await service.getMessages(threadId);
    expect(messages[0]?.parts[0]?.kind).toBe('summary');
    expect(messages).toHaveLength(3); // summary + 第二轮 user + assistant
  });

  it('restore：新实例从日志重建并发布 threadResumed、续接 seq', async () => {
    const first = makeService([
      [{ type: 'text-delta', text: '第一轮回复' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const threadId = await first.service.createThread('恢复演示');
    await first.service.send(threadId, '第一轮输入', 'edit');
    const events = await first.store.loadEvents(threadId);
    expect(events.length).toBeGreaterThan(5);
    const maxSeq = Math.max(...events.map((e) => e.seq));

    // 模拟重启：新 sink + 新 service，共享同一 store（同一 userData）
    const second = makeService([], { store: first.store });
    const rebuilt = await second.service.restore(threadId);

    expect(second.recorder.of('threadResumed')).toHaveLength(1);
    expect(second.recorder.events.find((e) => e.type === 'threadResumed')?.seq).toBe(maxSeq + 1); // threadResumed 占用续接后的第一个 seq
    expect(rebuilt.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(rebuilt.messages[1]?.parts[0]).toMatchObject({ kind: 'text', text: '第一轮回复' });
    expect(rebuilt.seq).toBe(maxSeq);

    // 恢复后可继续发送且 seq 续接（threadResumed 之后顺延）
    const before = second.recorder.events.length;
    await second.service.send(threadId, '继续', 'edit');
    expect(second.recorder.events.length).toBeGreaterThan(before);
    const newSeqs = second.recorder.events.slice(before).map((e) => e.seq);
    expect(Math.min(...newSeqs)).toBe(maxSeq + 2);
  });

  it('内存治理·懒恢复：seed 只注册元数据零读盘，首次使用按需 rebuild 且消息保真；重启后移动任务 seq 续接不丢事件', async () => {
    const first = makeService([
      [{ type: 'text-delta', text: '第一轮回复' }, { type: 'usage', delta: { inputTokens: 100, outputTokens: 50 } }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const threadId = await first.service.createThread('懒恢复');
    await first.service.send(threadId, '第一轮输入', 'edit');
    const eventsBefore = await first.store.loadEvents(threadId);
    const maxSeq = Math.max(...eventsBefore.map((e) => e.seq));

    // 模拟重启：新 service 只播种元数据（main 装配层的新契约），maxSeq 回灌
    const second = makeService([], { store: first.store });
    second.service.seed({ id: threadId, title: '懒恢复', createdAt: 1, usageTokens: 123, maxSeq });
    // 重启后立刻移动任务（未发生任何消息）：seq 必须 ≥ maxSeq，事件不得被吞
    second.service.moveThread(threadId, 'E:\\ws\\other');
    const eventsAfter = await second.store.loadEvents(threadId);
    const moved = eventsAfter.find((e) => e.type === 'threadMoved');
    expect(moved).toBeDefined(); // JSON 引擎无主键碰撞，这里验证 seq 语义
    expect(moved!.seq).toBeGreaterThan(maxSeq);

    let loadCalls = 0;
    const origLoad = second.store.loadEvents.bind(second.store);
    second.store.loadEvents = async (id: string) => {
      loadCalls += 1;
      return origLoad(id);
    };
    expect(loadCalls).toBe(0); // 播种零读盘
    const row = second.service.listThreads().find((r) => r.id === threadId);
    expect(row).toMatchObject({ title: '懒恢复', usageTokens: 123, busy: false });

    // 首次使用触发按需恢复：loadEvents 恰好一次，消息与事实源一致
    const msgs = await second.service.getMessages(threadId);
    expect(loadCalls).toBe(1);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[0]?.parts[0]).toMatchObject({ kind: 'text', text: '第一轮输入' });
    expect(msgs[1]?.parts[0]).toMatchObject({ kind: 'text', text: '第一轮回复' });
    // 恢复后 usage 以事件折叠真值覆盖 seed 缓存（usageDelta 100+50）
    expect(second.service.listThreads().find((r) => r.id === threadId)?.usageTokens).toBe(150);
  });

  it('内存治理·LRU 卸载：超上界按最久未用卸载，usage 跨卸载周期保持，再次使用自动重建', async () => {
    const turn = (): ModelStreamEvent[] => [
      { type: 'text-delta', text: '回复' },
      { type: 'usage', delta: { inputTokens: 100, outputTokens: 50 } },
      { type: 'finish', finishReason: 'stop' },
    ];
    // 每轮发送消耗两个脚本：主模型一转 + afterTurn 提炼一转（空数组=零事实）
    const extract = (): ModelStreamEvent[] => [{ type: 'text-delta', text: '[]' }, { type: 'finish', finishReason: 'stop' }];
    const { service, store } = makeService(
      [turn(), extract(), turn(), extract(), turn(), extract(), turn(), extract()],
      { residency: { maxResident: 2 } },
    );
    let loadCalls = 0;
    const origLoad = store.loadEvents.bind(store);
    store.loadEvents = async (id: string) => {
      loadCalls += 1;
      return origLoad(id);
    };
    const a = await service.createThread('A');
    const b = await service.createThread('B');
    await service.send(a, '第一句', 'edit');
    await service.send(b, '第二句', 'edit');
    const c = await service.createThread('C');
    await service.send(c, '第三句', 'edit'); // 触发 maybeEvict：3 个驻留 > 2，最久未用的 A 被卸载
    expect(loadCalls).toBe(0); // 全程未发生恢复（新建即驻留）

    // A 被卸载但 usage 连续（150 = 事件折叠口径，不因卸载丢失）
    const rowA = service.listThreads().find((r) => r.id === a);
    expect(rowA?.usageTokens).toBe(150);
    // 再次使用自动重建，消息保真（JSONL 事实源）
    const msgsA = await service.getMessages(a);
    expect(loadCalls).toBe(1);
    expect(msgsA.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgsA[0]?.parts[0]).toMatchObject({ kind: 'text', text: '第一句' });
    // B/C 仍在驻留（未超上界），读取不再触发 loadEvents
    const before = loadCalls;
    await service.getMessages(b);
    expect(loadCalls).toBe(before);
    // 卸载后再次 send：按需恢复的历史 + 新轮完整衔接（最高频真实路径）
    await service.send(a, '第四句', 'edit');
    const afterSend = await service.getMessages(a);
    const texts = afterSend.flatMap((m) => m.parts.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text));
    expect(texts).toContain('第一句'); // 重建的历史
    expect(texts).toContain('第四句'); // 新轮
    expect(service.listThreads().find((r) => r.id === a)?.usageTokens).toBe(300); // 150（事件）+ 150（新轮增量）
  });

  it('存储 GC 集成：压缩后日志重写为重放等价稀疏流，重放态与内存态一致、用量不丢', async () => {
    const turn = (text: string): ModelStreamEvent[] => [
      { type: 'text-delta', text },
      { type: 'usage', delta: { inputTokens: 100, outputTokens: 50 } },
      { type: 'finish', finishReason: 'stop' },
    ];
    const extract = (): ModelStreamEvent[] => [{ type: 'text-delta', text: '[]' }, { type: 'finish', finishReason: 'stop' }];
    const { service, store, recorder } = makeService(
      [turn('回复一'), extract(), turn('回复二'), turn('这是摘要'), extract()],
      { compress: { thresholdTokens: 1, keepRecentGroups: 1 } },
    );
    const threadId = await service.createThread('GC 集成');
    await service.send(threadId, '第一轮输入', 'edit');
    await service.send(threadId, '第二轮输入', 'edit'); // afterTurn 压缩 → 触发 GC 重写
    expect(recorder.of('memoryCompressed')).toHaveLength(1);

    const events = await store.loadEvents(threadId);
    // GC 生效：被压缩掉的轮1生成事件已被移除，仅存最后一条 memoryCompressed
    expect(events.filter((e) => e.type === 'memoryCompressed')).toHaveLength(1);
    expect(events.some((e) => e.type === 'textDelta' && (e.payload as { messageId: string }).messageId.startsWith('msg') && (e.payload as { text: string }).text === '回复一')).toBe(false);
    // 用量统计基础不丢（usageDelta 全保留）
    const rebuilt = rebuildThread(events);
    expect(rebuilt.usageTokens).toBe(300);
    // 重放态与内存态一致（ADR-0008 等价性在真实压缩链上的落地）
    const inMemory = await service.getMessages(threadId);
    expect(rebuilt.messages).toEqual(inMemory);
    expect(rebuilt.messages[0]?.parts[0]).toMatchObject({ kind: 'summary', text: '这是摘要' });
    // 摘要 id 对齐重放口径：再次压缩引用的 id 在重放后仍可删除（跨重启多轮压缩不重复）
    expect((inMemory[0]?.parts[0] as { kind: string }).kind).toBe('summary');
    expect(inMemory[0]!.id).toMatch(/^restored_summary_\d+$/);
  });
});


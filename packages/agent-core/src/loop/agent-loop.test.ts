import { describe, expect, it } from 'vitest';
import { runTurn, type AgentLoopDeps, type TurnInput } from './agent-loop';
import { createTaskCompleteTool } from '../tools/task-complete';
import { ToolRegistry } from '../tools/registry';
import { ToolPipeline } from '../tools/pipeline';
import { ContextAssembler } from '../context/assembler';
import { FanoutSink } from '../events/fanout-sink';
import { JournalSink } from '../session/journal';
import {
  FakeApprovals, FakeClock, FakeModel, InMemoryStore, RecordingSink,
} from '../testing/fakes';
import type { Budget } from '@loomery/domain';
import type { RegisteredTool, ModelStreamEvent } from '@loomery/ports';

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws';
const INSIDE = process.platform === 'win32' ? 'C:\\ws\\a.txt' : '/ws/a.txt';

function writeTool(): RegisteredTool {
  return {
    name: 'stub_write',
    description: '写',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' }, content: { type: 'string' } },
    },
    sideEffect: 'write',
    source: 'builtin',
    handler: async (input) => ({
      ok: true,
      content: 'written',
      affectedPaths: [(input as { path: string }).path],
    }),
  };
}

function toolCallStep(name: string, args: object): ModelStreamEvent[] {
  return [
    { type: 'tool-call-complete', toolCallId: `c_${Math.random().toString(36).slice(2, 8)}`, name, args: JSON.stringify(args) },
    { type: 'usage', delta: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', finishReason: 'tool-calls' },
  ];
}

function setup(
  scripts: ModelStreamEvent[][],
  budget?: Partial<Budget>,
  opts?: { clock?: FakeClock; approvals?: FakeApprovals },
) {
  const recorder = new RecordingSink();
  const store = new InMemoryStore();
  const clock = opts?.clock ?? new FakeClock();
  const sink = new FanoutSink([recorder, new JournalSink(store)], clock);
  const registry = new ToolRegistry();
  const handlerCalls: unknown[] = [];
  registry.register({
    ...writeTool(),
    handler: async (input) => {
      handlerCalls.push(input);
      return { ok: true, content: 'written', affectedPaths: [(input as { path: string }).path] };
    },
  });
  registry.register(createTaskCompleteTool()); // docs/15：完成声明工具（finish 相关测试用；既有测试不受影响）
  const pipeline = new ToolPipeline(registry, opts?.approvals ?? new FakeApprovals(), clock, {
    approvalPolicy: { read: 'auto', write: 'ask', execute: 'deny' },
    toolResultCharCap: 5000,
  });
  const model = new FakeModel(...scripts);
  const deps: AgentLoopDeps = {
    model,
    pipeline,
    registry,
    context: new ContextAssembler([], 8000),
    sink,
    clock,
    systemBase: () => 'You are Loomery.',
    budget: { maxSteps: 10, maxTurnTokens: 100_000, maxWallMs: 60_000, ...budget },
    contextBudgetTokens: 8000,
    workspaceRoots: [ROOT],
  };
  const abortController = new AbortController();
  const input: TurnInput = {
    threadId: 't1',
    turnId: 'u1',
    mode: 'edit',
    model: 'test-model',
    userMessage: { id: 'm_user', role: 'user', parts: [{ kind: 'text', text: '帮我改文件' }], createdAt: 1 },
    history: [],
    abortController,
  };
  return { deps, input, recorder, store, handlerCalls, abortController, model, clock };
}

describe('runTurn（05 §3 主循环）', () => {
  it('自然终止：模型流 → 工具审批执行 → 回灌 → 二轮收尾', async () => {
    const { deps, input, recorder, handlerCalls } = setup([
      [
        { type: 'text-delta', text: '我来修改文件。' },
        ...toolCallStep('stub_write', { path: INSIDE, content: 'x' }),
      ],
      [{ type: 'text-delta', text: '已完成。' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const result = await runTurn(input, deps);

    expect(result.reason).toBe('natural');
    expect(result.cancelled).toBe(false);
    expect(result.degraded).toBe(false);
    expect(handlerCalls).toHaveLength(1);

    const types = recorder.types();
    expect(types[0]).toBe('turnStarted');
    expect(types).toContain('contextAssembled');
    expect(types).toContain('approvalRequired'); // write=ask 走审批门
    expect(types).toContain('approvalResolved');
    expect(types).toContain('toolExecuted');
    expect(types).toContain('observationAdded');
    expect(types[types.length - 1]).toBe('turnCompleted');

    // 消息结构：user + assistant(tool-call+tool-result) + assistant(text)
    expect(result.messages).toHaveLength(3);
    const step1 = result.messages[1];
    expect(step1?.parts.some((p) => p.kind === 'tool-call')).toBe(true);
    expect(step1?.parts.some((p) => p.kind === 'tool-result')).toBe(true);
    expect(result.messages[2]?.parts[0]).toMatchObject({ kind: 'text', text: '已完成。' });

    // 事件溯源日志已同步落盘
    expect(recorder.of('loopTerminated')[0]).toMatchObject({ reason: 'natural' });
    expect(recorder.of('turnCompleted')[0]).toMatchObject({ outcome: 'completed' });
  });

  it('maxSteps 熔断 → 降级收尾（禁用工具总结）', async () => {
    const { deps, input, recorder } = setup(
      [
        toolCallStep('stub_write', { path: INSIDE }),
        toolCallStep('stub_write', { path: INSIDE }),
        // 降级收尾脚本（cheap）
        [{ type: 'text-delta', text: '进展：已写一个文件。停止原因：步数预算。' }, { type: 'finish', finishReason: 'stop' }],
      ],
      { maxSteps: 2 },
    );
    const result = await runTurn(input, deps);
    expect(result.reason).toBe('maxSteps');
    expect(result.degraded).toBe(true);
    expect(result.finalSummary).toContain('进展');
    expect(recorder.of('degradationStarted').length).toBe(1);
    expect(recorder.of('loopTerminated')[0]).toMatchObject({ reason: 'maxSteps', finalSummary: expect.any(String) });
    expect(recorder.of('turnCompleted')[0]).toMatchObject({ outcome: 'degraded' });
  });

  it('循环双阈值：第 3 次同参重复注入提醒（模型自纠），第 5 次才 loopDetected', async () => {
    const same = () => toolCallStep('stub_write', { path: INSIDE, content: 'same' });
    const { deps, input, recorder } = setup([
      same(), same(), same(), same(), // 第 3、4 次重复：软提醒，不终止
      toolCallStep('stub_write', { path: INSIDE, content: 'same' }), // 第 5 次：硬熔断
      [{ type: 'text-delta', text: '总结。' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const result = await runTurn(input, deps);
    expect(result.reason).toBe('loopDetected');
    expect(result.degraded).toBe(true);
    // 软提醒进入模型可见的 tool-result（第 3、4 次各一条）
    const reminded = result.messages
      .flatMap((m) => m.parts)
      .filter((p) => p.kind === 'tool-result' && (p as { content: string }).content.includes('[循环提醒]'));
    expect(reminded.length).toBe(2);
    expect(JSON.stringify(reminded[0])).toContain('第 3 次');
    expect(recorder.of('observationAdded').length).toBeGreaterThanOrEqual(2);
  });

  it('循环软阈值不终止：第 3 次重复后模型改弦更张则正常收尾', async () => {
    const { deps, input } = setup([
      toolCallStep('stub_write', { path: INSIDE, content: 'same' }),
      toolCallStep('stub_write', { path: INSIDE, content: 'same' }),
      toolCallStep('stub_write', { path: INSIDE, content: 'same' }), // 触发软提醒
      [{ type: 'text-delta', text: '已改为直接总结。' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const result = await runTurn(input, deps);
    expect(result.reason).toBe('natural'); // 模型自纠成功：不熔断
    expect(result.degraded).toBe(false);
  });

  it('取消：abort 后以 userCancelled 收尾，且不发 turnCompleted', async () => {
    const { deps, input, recorder, abortController } = setup([
      [{ type: 'text-delta', text: 'x' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    abortController.abort();
    const result = await runTurn(input, deps);
    expect(result.cancelled).toBe(true);
    expect(result.reason).toBe('userCancelled');
    expect(recorder.types()).toContain('turnCancelled');
    expect(recorder.types()).not.toContain('turnCompleted');
  });

  it('plan 模式：注册表只暴露 read 工具（schema 层过滤）', async () => {
    const { deps, input, recorder, model } = setup([
      [{ type: 'text-delta', text: '只读模式。' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    input.mode = 'plan';
    let receivedTools: string[] = [];
    model.onStream = (req) => {
      receivedTools = req.tools.map((t) => t.name);
    };
    await runTurn(input, deps);
    expect(receivedTools).toEqual(['task_complete']) // docs/15：task_complete 属 read 类，plan 模式下保持可用（声明收尾合法）; // 只有写工具被注册，plan 模式下不可见
    expect(recorder.of('turnCompleted')[0]).toMatchObject({ outcome: 'completed' });
  });

  it('usage 累计与 token 预算：越 80% 触发 budgetWarning', async () => {
    const { deps, input, recorder } = setup([
      toolCallStep('stub_write', { path: INSIDE }), // 15 tokens
      [
        { type: 'usage', delta: { inputTokens: 60, outputTokens: 30 } },
        { type: 'finish', finishReason: 'tool-calls' }, // 无工具调用 → 下一轮检查预算
      ],
      [{ type: 'text-delta', text: 'ok' }, { type: 'finish', finishReason: 'stop' }],
    ], { maxTurnTokens: 100 });
    await runTurn(input, deps);
    expect(recorder.of('budgetWarning')).toHaveLength(1); // 105/100 越线即警告
    expect(recorder.of('budgetWarning')[0]).toMatchObject({ kind: 'maxTurnTokens' });
  });

  it('模型错误 → modelError + failed', async () => {
    const { deps, input, recorder } = setup([
      [{ type: 'finish', finishReason: 'error', errorMessage: '429 exhausted' }],
      [{ type: 'finish', finishReason: 'stop' }], // 降级脚本
    ]);
    const result = await runTurn(input, deps);
    expect(result.reason).toBe('modelError');
    expect(recorder.of('turnCompleted')[0]).toMatchObject({ outcome: 'degraded' });
    expect(recorder.of('error').length).toBeGreaterThan(0);
  });

  it('模型错误时孤儿 tool-call 被合成 tool-result 配对（F0.2：历史不脏）', async () => {
    const { deps, input, handlerCalls } = setup([
      [
        { type: 'tool-call-complete', toolCallId: 'c_orphan', name: 'stub_write', args: JSON.stringify({ path: INSIDE }) },
        { type: 'finish', finishReason: 'error', errorMessage: 'gateway 500' },
      ],
      [{ type: 'text-delta', text: '总结。' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const result = await runTurn(input, deps);
    expect(result.reason).toBe('modelError');
    // assistant 消息里的 tool-call 必须有配对 tool-result（否则持久化后下轮撞网关）
    const step = result.messages.find((m) => m.parts.some((p) => p.kind === 'tool-call'));
    expect(step).toBeDefined();
    const paired = step!.parts.find((p) => p.kind === 'tool-result');
    expect(paired).toMatchObject({ toolCallId: 'c_orphan', content: '[轮次中断，工具未执行]' });
    // handler 未被调用（工具确实没执行）
    expect(handlerCalls).toHaveLength(0);
  });

  it('审批等待时间不计入 wall 预算（F0.3：用户离开再批准不触发 timeout）', async () => {
    const clock = new FakeClock();
    // 用户在审批卡上停留 10s（远超 maxWallMs=3000）后批准
    const approvals = new FakeApprovals(() => {
      clock.advance(10_000);
      return { kind: 'approved' } as const;
    });
    const { deps, input } = setup(
      [
        toolCallStep('stub_write', { path: INSIDE, content: 'x' }),
        [{ type: 'text-delta', text: '已完成。' }, { type: 'finish', finishReason: 'stop' }],
      ],
      { maxWallMs: 3_000 },
      { clock, approvals },
    );
    const result = await runTurn(input, deps);
    // 若扣除逻辑缺失，第二轮 checkBudget 将以 timeout 熔断
    expect(result.reason).toBe('natural');
    expect(result.degraded).toBe(false);
  });

  it('plan_write → planUpdated 事件入册（ADR-0026 计划分解）', async () => {
    // agent-core 不依赖适配器（依赖向内）：注册同构内联 plan 工具（契约见 fs-tools/plan-tool.ts）
    const planTool: RegisteredTool = {
      name: 'plan_write',
      description: '计划',
      inputSchema: { type: 'object', required: ['steps'], properties: { steps: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, status: { type: 'string' } } } } } },
      sideEffect: 'read',
      source: 'builtin',
      handler: async (input) => ({
        ok: true,
        content: '计划已更新',
        affectedPaths: [],
        planUpdate: (input as { steps: { title: string; status: 'pending' | 'in_progress' | 'completed' | 'failed' }[] }).steps.map((s, i) => ({ id: 's' + (i + 1), title: s.title, status: s.status })),
      }),
    };
    const { deps, input, recorder } = setup([
      [
        { type: 'tool-call-complete', toolCallId: 'c_plan', name: 'plan_write', args: JSON.stringify({ steps: [{ title: '读目录', status: 'completed' }, { title: '写文件', status: 'in_progress' }] }) },
        { type: 'usage', delta: { inputTokens: 10, outputTokens: 5 } },
        { type: 'finish', finishReason: 'tool-calls' },
      ],
      [{ type: 'text-delta', text: '已按计划推进。' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    deps.registry.register(planTool);
    const result = await runTurn(input, deps);
    expect(result.reason).toBe('natural');
    const ev = recorder.of('planUpdated')[0] as { steps: { title: string; status: string }[] };
    expect(ev.steps).toHaveLength(2);
    expect(ev.steps[1]).toMatchObject({ title: '写文件', status: 'in_progress' });
  });

  it('事件日志同步进入 MemoryStore（事件溯源）', async () => {
    const { deps, input, store } = setup([
      [{ type: 'text-delta', text: 'ok' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    await runTurn(input, deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(store.events.length).toBeGreaterThan(5);
    expect(store.events.every((e) => e.threadId === 't1')).toBe(true);
    const seqs = store.events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // seq 单调
  });
  // ===== docs/15 自主完成协议 =====

  /** 带机器证据的 stub 命令工具（run_command 的证据形态替身） */
  function cmdTool(ok = true): RegisteredTool {
    return {
      name: 'stub_cmd',
      description: '命令',
      inputSchema: { type: 'object', properties: {} },
      sideEffect: 'read',
      source: 'builtin',
      handler: async () => ({
        ok,
        content: ok ? 'exit 0' : 'exit 1',
        affectedPaths: [],
        evidence: { kind: 'command', ok, detail: `stub_cmd → exit=${ok ? 0 : 1}` },
      }),
    };
  }

  function finishCall(summary: string, verification: string): ModelStreamEvent[] {
    return toolCallStep('task_complete', { summary, outstanding: [], verification, confidence: 'high', outcome: 'complete' });
  }

  function cheapVerdict(complete: boolean, missing: string[] = []): ModelStreamEvent[] {
    return [
      { type: 'text-delta', text: JSON.stringify({ complete, missing }) },
      { type: 'usage', delta: { inputTokens: 5, outputTokens: 5 } },
      { type: 'finish', finishReason: 'stop' },
    ];
  }

  it('task_complete 证据背书 → selfReport 收尾（summary 交 TurnResult）', async () => {
    const { deps, input, recorder, model } = setup([
      [ ...toolCallStep('stub_cmd', {}) ],
      [ ...finishCall('做完了', 'stub_cmd exit 0') ],
    ]);
    deps.registry.register(cmdTool(true));
    const result = await runTurn(input, deps);

    expect(result.reason).toBe('selfReport');
    expect(result.finalSummary).toBe('做完了');
    expect(result.degraded).toBe(false);
    // 声明的 tool-call 有配对 tool-result（历史完整性）
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg?.parts.some((p) => p.kind === 'tool-call' && (p as { name: string }).name === 'task_complete')).toBe(true);
    expect(lastMsg?.parts.some((p) => p.kind === 'tool-result')).toBe(true);
    const verdicts = recorder.of('completionAudit');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ verdict: 'selfReport' });
    expect(recorder.of('loopTerminated')[0]).toMatchObject({ reason: 'selfReport' });
    expect(recorder.of('turnCompleted')[0]).toMatchObject({ outcome: 'completed' });
    expect(model.remaining).toBe(0);
  });

  it('证据门：虚报验证被拦一次，补证据后重声明放行', async () => {
    const { deps, input, recorder } = setup([
      [ ...finishCall('做完了', '测试全部通过') ],           // 无任何成功证据 → 拦
      [ ...toolCallStep('stub_cmd', {}) ],                   // 补验证
      [ ...finishCall('做完了', 'stub_cmd exit 0') ],        // 重声明（有证据）→ 放行
    ]);
    deps.registry.register(cmdTool(true));
    const result = await runTurn(input, deps);

    expect(result.reason).toBe('selfReport');
    const verdicts = recorder.of('completionAudit');
    expect(verdicts.map((v) => (v as { verdict: string }).verdict)).toEqual(['evidence-gate', 'selfReport']);
    // 被拦次的 tool-result 携带证据核对注记（模型可见）
    const gateMsg = result.messages.find((m) => m.parts.some((p) => p.kind === 'tool-result' && p.content.includes('证据核对')));
    expect(gateMsg).toBeDefined();
  });

  it('升级A：outcome=blocked 受阻收尾——跳过证据门直接接受，不硬磨', async () => {
    const { deps, input, recorder } = setup([
      [ ...toolCallStep('stub_cmd', {}) ],
      // blocked 声明：verification 含"测试"字样但零成功证据——若套证据门会被误拦；blocked 必须直接放行
      [ ...toolCallStep('task_complete', { summary: '无法继续：缺少数据库连接权限', outstanding: ['需要用户提供 DB 口令'], verification: '尝试运行测试失败（缺依赖）', confidence: 'low', outcome: 'blocked' }) ],
    ]);
    deps.registry.register(cmdTool(true));
    const result = await runTurn(input, deps);
    expect(result.reason).toBe('selfReport');
    expect(result.finalSummary).toContain('无法继续');
    const verdicts = recorder.of('completionAudit').map((v) => (v as { verdict: string }).verdict);
    expect(verdicts).toEqual(['selfReport']); // 无 evidence-gate 事件
    expect(recorder.of('completionAudit')[0]).toMatchObject({ missing: ['需要用户提供 DB 口令'] });
  });

  it('完成审计：自然终止 → cheap 裁决未完成 → nudge 续跑 → 二次自然终止裁决通过', async () => {
    const { deps, input, recorder, model } = setup([
      [ ...toolCallStep('stub_cmd', {}) ],
      [ ...toolCallStep('stub_cmd', {}) ],
      [ { type: 'text-delta', text: '差不多收工。' }, { type: 'finish', finishReason: 'stop' } ],  // step3 自然终止 → 审计1
      cheapVerdict(false, ['文件尚未写入']),                                                        // cheap 裁决1
      [ ...toolCallStep('stub_cmd', {}) ],
      [ { type: 'text-delta', text: '这次真的完成了。' }, { type: 'finish', finishReason: 'stop' } ], // step4? 自然终止 → 审计2
      cheapVerdict(true),                                                                            // cheap 裁决2
    ]);
    deps.registry.register(cmdTool(true));
    const systems: string[] = [];
    model.onStream = (req) => { if (req.modelTier === 'main') systems.push(req.system); };
    const result = await runTurn(input, deps);

    expect(result.reason).toBe('natural');
    const verdicts = recorder.of('completionAudit').map((v) => (v as { verdict: string }).verdict);
    expect(verdicts).toEqual(['audit-continue', 'audit-pass']);
    // nudge 随 system 注入（不进对话转录）
    expect(systems.some((sys) => sys.includes('完成审计'))).toBe(true);
  });

  it('审计有界：连续 2 次未通过后第 3 次自然终止直接放行', async () => {
    const { deps, input, recorder, model } = setup([
      [ ...toolCallStep('stub_cmd', {}) ],
      [ ...toolCallStep('stub_cmd', {}) ],
      [ { type: 'finish', finishReason: 'stop' } ],  // step3 → 审计1 未过
      cheapVerdict(false, ['a']),
      [ { type: 'finish', finishReason: 'stop' } ],  // step4 → 审计2 未过
      cheapVerdict(false, ['b']),
      [ { type: 'finish', finishReason: 'stop' } ],  // step5 → 审计额度用尽 → 放行
    ]);
    deps.registry.register(cmdTool(true));
    const result = await runTurn(input, deps);

    expect(result.reason).toBe('natural');
    const verdicts = recorder.of('completionAudit').map((v) => (v as { verdict: string }).verdict);
    expect(verdicts).toEqual(['audit-continue', 'audit-continue']);
    expect(model.remaining).toBe(0); // 两份 cheap 脚本恰好耗尽（第 3 次未再调审计）
  });

  it('P0④ 边际产出提醒：连续 8 步零产出（读类无新信息）→ system 注入提醒', async () => {
    const { deps, input, model } = setup([
      ...Array.from({ length: 9 }, (_, k) => [ ...toolCallStep('stub_cmd', { seq: k }) ]), // 9 步参数各异的空转（观察恒 6 字节、零写文件——不触发重复检测，正是盲区形态）
      [ { type: 'text-delta', text: '基于现有信息直接总结。' }, { type: 'finish', finishReason: 'stop' } ],
      cheapVerdict(true), // 自然终止审计（第 10 步）
    ]);
    deps.registry.register(cmdTool(true));
    const systems: string[] = [];
    model.onStream = (req) => { if (req.modelTier === 'main') systems.push(req.system); };
    const result = await runTurn(input, deps);

    expect(result.reason).toBe('natural');
    expect(systems.some((sys) => sys.includes('边际产出提醒'))).toBe(true);
  });

  it('纯问答（零工具）跳过完成审计', async () => {
    const { deps, input, recorder, model } = setup([
      [ { type: 'text-delta', text: '直接回答。' }, { type: 'finish', finishReason: 'stop' } ],
    ]);
    const result = await runTurn(input, deps);
    expect(result.reason).toBe('natural');
    expect(recorder.of('completionAudit')).toHaveLength(0);
    expect(model.remaining).toBe(0);
  });

  it('审计 fail-open：cheap 模型不可用 → 放行收尾', async () => {
    const { deps, input, recorder } = setup([
      [ ...toolCallStep('stub_cmd', {}) ],
      [ ...toolCallStep('stub_cmd', {}) ],
      [ { type: 'finish', finishReason: 'stop' } ], // step3 → 审计发起但 cheap 脚本耗尽（FakeModel 抛错）→ fail-open
    ]);
    deps.registry.register(cmdTool(true));
    const result = await runTurn(input, deps);
    expect(result.reason).toBe('natural');
    expect(recorder.of('completionAudit')[0]).toMatchObject({ verdict: 'audit-fail-open' });
  });
});

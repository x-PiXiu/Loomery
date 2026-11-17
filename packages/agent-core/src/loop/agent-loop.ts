// 05 §3 agent-loop：编排、判停、熔断、降级——不持有任何 IO 能力
import {
  BUDGET_WARN_RATIO, CONTEXT_HASH_STREAK, LOOP_HARD_THRESHOLD, LOOP_REPEAT_THRESHOLD, MARGINAL_REMIND_EVERY, MARGINAL_STALL_STEPS, MAX_COMPLETION_AUDITS, MAX_EVIDENCE_GATES, MAX_IMAGES_PER_TURN,
  type AgentMode, type Budget, type ChatMessage, type EventType, type EvidenceEntry,
  type LoopEventPayloads, type LoopState, type PlanStep, type TerminationReason,
  checkReportEvidence, hashToolCall, selfReportObservation,
} from '@loomery/domain';
import { runCompletionAudit } from './completion-audit';
import { degradeSummaryInstruction } from '../prompts';
import type { Clock, ModelClient, ModelStreamEvent } from '@loomery/ports';
import type { FanoutSink } from '../events/fanout-sink';
import { newId } from '../events/id';
import type { ContextAssembler } from '../context/assembler';
import type { ToolPipeline } from '../tools/pipeline';
import type { ToolRegistry } from '../tools/registry';

export class BudgetExceededError extends Error {
  constructor(
    public readonly reason: Extract<TerminationReason, 'maxSteps' | 'maxTurnTokens' | 'timeout'>,
    public readonly used: number,
    public readonly limit: number,
  ) {
    super(`预算越线: ${reason}（${used}/${limit}）`);
  }
}

export class LoopDetectedError extends Error {
  constructor(detail: string) {
    super(`检测到死循环: ${detail}`);
  }
}

export interface AgentLoopDeps {
  model: ModelClient;
  pipeline: ToolPipeline;
  registry: ToolRegistry;
  context: ContextAssembler;
  sink: FanoutSink;
  clock: Clock;
  /** 基础人格 prompt（2026-11-13 改活引用：persona/提示词更新即时生效，无需重启） */
  /** 当前生效模型 id（usageDelta 出处归因，P2 统计） */
  modelId?: string;
  systemBase: () => string;
  budget: Budget;
  /** 上下文贡献者的 token 预算 */
  contextBudgetTokens: number;
  workspaceRoots: string[];
  /** ADR-0021：本任务暂存区根（scratch 写免审合法域）；缺省不启用 */
  scratchRoot?: string;
  /** 领土实勘（symlink/junction 防线，适配器注入，见 ports.ToolContext.verifyTerritory） */
  verifyTerritory?: (absPath: string) => Promise<void>;
}

export interface TurnInput {
  threadId: string;
  turnId: string;
  mode: AgentMode;
  /** 展示名（turnStarted 载荷） */
  model: string;
  /** ADR 多项目：本线程的路径域（缺省回退 deps.workspaceRoots） */
  workspaceRoots?: string[];
  userMessage: ChatMessage;
  history: ChatMessage[];
  /** session 持有；停止按钮触发 abort（07 §6 取消传播链） */
  abortController: AbortController;
}

export interface TurnResult {
  reason: TerminationReason;
  finalSummary?: string;
  /** 本 Turn 全量消息（history + user + 产生的 assistant），供 session 持久化记忆 */
  messages: ChatMessage[];
  /** 本 Turn 消耗（usageDelta 同源），供任务级 usage 连续记账（跨卸载/恢复周期） */
  usage: { inputTokens: number; outputTokens: number };
  degraded: boolean;
  cancelled: boolean;
}

export async function runTurn(input: TurnInput, deps: AgentLoopDeps): Promise<TurnResult> {
  const { sink, clock } = deps;
  const emit = (<T extends EventType>(type: T, payload: LoopEventPayloads[T]) =>
    sink.emit({ threadId: input.threadId, turnId: input.turnId, type, payload })) as EmitWithStep;
  function emitAt(step: number): EmitWithStep {
    return (<T extends EventType>(type: T, payload: LoopEventPayloads[T]) =>
      sink.emit({ threadId: input.threadId, turnId: input.turnId, step, type, payload })) as EmitWithStep;
  }

  emit('turnStarted', {
    turnId: input.turnId,
    mode: input.mode,
    model: input.model,
    userMessageId: input.userMessage.id,
    userText: lastUserText([input.userMessage]),
    // docs/16 多模态：用户附带的截图随轮次启动落事件（重放/渲染用户消息图像所需）
    images: input.userMessage.parts.flatMap((p2) => (p2.kind === 'image' ? [{ mime: p2.mime, base64: p2.base64 }] : [])),
  });

  const startedAt = clock.now();
  /** 累计的用户审批等待时长（F0.3）：wall 预算只衡量 agent 活跃时间，用户交互时间不计入 */
  let approvalWaitMsTotal = 0;
  const messages: ChatMessage[] = [...input.history, input.userMessage];
  // LoopState 显式维护（03 §4 契约）；重复计数/预警去重/上下文哈希缓存属实现细节，不入契约
  const state: LoopState = {
    threadId: input.threadId,
    turnId: input.turnId,
    messages,
    stepCount: 0,
    seenToolCalls: new Set<string>(),
    contextHashStreak: 0,
    budget: deps.budget,
    spent: { steps: 0, tokens: 0, wallMs: 0 },
    abort: input.abortController.signal,
  };
  const repeatCounts = new Map<string, number>();
  const lastResultByHash = new Map<string, string>(); // 同参调用的上次结果哈希（语义化 no-op 判定：同参同果才累计）
  const warned = new Set<string>();
  let lastContextHash = '';
  // docs/15 自主完成协议：证据账本（机器事实）+ 计划快照 + 写文件集（审计输入）
  const evidenceLedger: EvidenceEntry[] = [];
  let planSnapshot: PlanStep[] | undefined;
  const filesTouched = new Set<string>();
  let toolsUsedThisTurn = 0;
  let auditsFired = 0;
  let evidenceGatesFired = 0;
  let completionNudge: string | undefined;
  // 2026-11-13 P0④ 循环盲区治理（实证：60 次参数各异的读类调用不触发任何阈值）：边际产出追踪——
  // 连续 N 步"零写文件且观察几乎无新增"=原地打转，注入软提醒让模型自纠（advisory，不熔断——硬熔断留给重复检测/三闸）
  let lastProgressAtStep = 0;
  let obsBytesAtBaseline = 0;
  let obsBytesTotal = 0;
  let filesAtBaseline = 0;
  let imagesThisTurn = 0; // docs/16：每轮图像配额（MAX_IMAGES_PER_TURN）
  /** 跨步聚合的任务级用量（TurnResult.usage 与 usageDelta 事件同源） */
  const totalUsage = { inputTokens: 0, outputTokens: 0 };
  const turnCtx = {
    threadId: input.threadId,
    turnId: input.turnId,
    mode: input.mode,
    workspaceRoots: input.workspaceRoots ?? deps.workspaceRoots,
    ...(deps.scratchRoot ? { scratchRoot: deps.scratchRoot } : {}),
    ...(deps.verifyTerritory ? { verifyTerritory: deps.verifyTerritory } : {}),
    signal: input.abortController.signal,
    injectionFlagged: false,
  };

  let outcome: 'completed' | 'degraded' | 'failed' = 'completed';
  let termination: TerminationReason = 'natural';
  let finalSummary: string | undefined;
  let cancelled = false;

  const checkBudget = (step: number): void => {
    const b = deps.budget;
    // wall = agent 活跃时间：扣除审批等待（用户离开 10 分钟再批准不应触发 timeout）
    const wall = clock.now() - startedAt - approvalWaitMsTotal;
    state.spent.wallMs = wall;
    warn(step, 'maxSteps', state.spent.steps, b.maxSteps);
    warn(step, 'maxTurnTokens', state.spent.tokens, b.maxTurnTokens);
    warn(step, 'timeout', wall, b.maxWallMs);
    if (state.spent.steps >= b.maxSteps) throw new BudgetExceededError('maxSteps', state.spent.steps, b.maxSteps);
    if (state.spent.tokens >= b.maxTurnTokens) throw new BudgetExceededError('maxTurnTokens', state.spent.tokens, b.maxTurnTokens);
    if (wall >= b.maxWallMs) throw new BudgetExceededError('timeout', wall, b.maxWallMs);
  };

  function warn(step: number, kind: 'maxSteps' | 'maxTurnTokens' | 'timeout', used: number, limit: number): void {
    const key = kind;
    if (warned.has(key) || used < limit * BUDGET_WARN_RATIO) return;
    warned.add(key);
    emitAt(step)('budgetWarning', { kind, used, limit });
  }

  try {
    // 主循环：构建 messages → stream → 判停 → 工具执行 → 回灌 → 下一轮
    while (true) {
      checkBudget(state.stepCount + 1);
      if (state.contextHashStreak >= CONTEXT_HASH_STREAK) {
        throw new LoopDetectedError(`连续 ${state.contextHashStreak} 轮上下文不变`);
      }

      // ---- 装配（含长期记忆 provider，ADR-0012）----
      // 降档禁工具不走状态位：degrade() 整段绕开主循环（toolsDisabled 死位 11-17 已删）
      const toolSpecs = deps.registry.listSpecs(input.mode);
      // 预算余量提示（Fix D）：剩余步数少时提醒模型收尾——已实证"读到熔断"的浪费模式
      const remaining = deps.budget.maxSteps - state.spent.steps;
      const budgetHint = remaining <= 6
        ? `[预算提醒] 本任务剩余约 ${remaining} 步。请尽快开始产出结果（写文件/给结论），不要再发起大量只读探查；若信息已足够，直接完成当前工作并在最后总结。`
        : undefined;
      const assembled = await deps.context.assemble({
        threadId: input.threadId,
        mode: input.mode,
        systemBase: deps.systemBase(),
        latestUserMessage: lastUserText(messages),
        messages,
        tools: toolSpecs,
        // 多项目路径域进 system（权威段）：护栏拦截过时路径的治本面
        workspaceRoots: input.workspaceRoots ?? deps.workspaceRoots,
        ...(budgetHint ? { budgetHint } : {}),
        // ADR-0021 召回可解释性：贡献者 side-channel → 事件总线（弱类型桥接，未知类型由 sink 忽略/透传）
        emit: (type: string, payload: unknown) => emit(type as EventType, payload as LoopEventPayloads[EventType]),
        ...(completionNudge ? { completionNudge } : {}),
      });
      completionNudge = undefined; // 一次性注入（后续是否继续 nudging 由证据门/审计的 bounded 计数决定）
      emitAt(state.stepCount + 1)('contextAssembled', {
        providers: assembled.providers,
        totalTokens: assembled.totalTokens,
        dropped: assembled.dropped,
        breakdown: assembled.breakdown,
      });

      // ---- 死循环：上下文哈希连击检测 ----
      const ctxHash = hashToolCall('ctx', {
        n: messages.length,
        last: messages[messages.length - 1]?.id,
        tools: toolSpecs.map((t) => t.name),
      });
      state.contextHashStreak = ctxHash === lastContextHash ? state.contextHashStreak + 1 : 0;
      lastContextHash = ctxHash;

      const step = state.stepCount + 1;
      const emitStep = emitAt(step);
      emitStep('stepStarted', { step });

      // ---- 模型流 ----
      let finish: Extract<ModelStreamEvent, { type: 'finish' }> | undefined;
      const assistantId = newId('msg');
      const textChunks: string[] = [];
      const toolCalls: { toolCallId: string; name: string; args: string }[] = [];
      const usage = { inputTokens: 0, outputTokens: 0 };

      for await (const ev of deps.model.stream({
        modelTier: 'main',
        system: assembled.system,
        messages,
        tools: toolSpecs,
        signal: input.abortController.signal,
      })) {
        switch (ev.type) {
          case 'text-delta':
            textChunks.push(ev.text);
            emitStep('textDelta', { messageId: assistantId, text: ev.text });
            break;
          case 'reasoning-delta':
            emitStep('reasoningDelta', { messageId: assistantId, text: ev.text });
            break;
          case 'tool-call-delta':
            emitStep('toolCallDelta', { messageId: assistantId, toolCallId: ev.toolCallId, argsDelta: ev.argsDelta });
            break;
          case 'tool-call-complete':
            toolCalls.push({ toolCallId: ev.toolCallId, name: ev.name, args: ev.args });
            emitStep('toolCallComplete', { messageId: assistantId, toolCallId: ev.toolCallId, name: ev.name, args: ev.args });
            break;
          case 'usage':
            usage.inputTokens += ev.delta.inputTokens;
            usage.outputTokens += ev.delta.outputTokens;
            totalUsage.inputTokens += ev.delta.inputTokens;
            totalUsage.outputTokens += ev.delta.outputTokens;
            state.spent.tokens += ev.delta.inputTokens + ev.delta.outputTokens;
            emitStep('usageDelta', { inputTokens: ev.delta.inputTokens, outputTokens: ev.delta.outputTokens, ...(input.model && input.model !== 'main' ? { model: input.model } : {}) });
            break;
          case 'retrying':
            emitStep('retrying', { attempt: ev.attempt, reason: ev.reason });
            break;
          case 'finish':
            finish = ev;
            break;
        }
      }
      if (!finish) throw new Error('模型流未正常结束');

      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        createdAt: clock.now(),
        parts: [
          ...(textChunks.length > 0 ? [{ kind: 'text' as const, text: textChunks.join('') }] : []),
          ...toolCalls.map((c) => ({
            kind: 'tool-call' as const,
            toolCallId: c.toolCallId,
            name: c.name,
            args: c.args,
          })),
        ],
      };
      messages.push(assistantMsg);

      const fr = finish.finishReason;
      if (fr !== 'tool-calls') {
        emitStep('stepCompleted', {
          finishReason: fr,
          usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costEstimate: 0 },
        });
        state.stepCount = step;
        state.spent.steps = step;
        if (fr === 'error') {
          termination = 'modelError';
          outcome = 'failed';
          emitStep('error', { source: 'model', message: finish.errorMessage ?? '模型错误', recoverable: false });
          break;
        }
        if (fr === 'length') {
          // 05 §3：length 按 natural 终止，但额外提示
          emitStep('error', { source: 'model', message: '模型输出被截断（length）', recoverable: true });
        }
        // docs/15 机制二：完成审计——自然终止先过批判者（有界 MAX_COMPLETION_AUDITS；纯问答/步数<3 跳过）
        if (fr === 'stop' && toolsUsedThisTurn > 0 && state.spent.steps >= 3 && auditsFired < MAX_COMPLETION_AUDITS) {
          auditsFired++;
          const verdict = await runCompletionAudit(deps.model, {
            userRequest: lastUserText(messages) ?? '',
            ...(planSnapshot ? { plan: planSnapshot } : {}),
            evidence: evidenceLedger,
            filesTouched: [...filesTouched],
            stepsUsed: state.spent.steps,
          }, input.abortController.signal);
          emitStep('completionAudit', { verdict: verdict ? (verdict.complete ? 'audit-pass' : 'audit-continue') : 'audit-fail-open', ...(verdict && !verdict.complete ? { missing: verdict.missing } : {}) });
          if (verdict && !verdict.complete && verdict.missing.length > 0) {
            // 不收尾：nudge 随下一轮 system 注入，主循环继续（assistant 消息已在 messages 中）
            completionNudge =
              `[完成审计] 你提前结束了本轮，但审计认为以下事项可能未完成：${verdict.missing.join('；')}。` +
              `若确已完成或确实无法继续，请调用 task_complete 说明原因与遗留项；否则继续处理。`;
            continue;
          }
        }
        termination = 'natural';
        break;
      }

      // ---- 工具执行（逐个、串行）----
      for (const call of toolCalls) {
        const hash = hashToolCall(call.name, safeParse(call.args));
        state.seenToolCalls.add(hash);
        // 双阈值循环治理（2026-11-13 语义化修正）：重复计数只累计"同参同果"（真 no-op）；
        // "同参异果"= 有效进展（页面状态变了/服务恢复了），重置计数——实证：恢复后的验证性 read
        // 与空白页的 read 同参异果，被旧行为累计到第 5 次误杀（loopDetected 假阳性）
        const repeatsBefore = (repeatCounts.get(hash) ?? 0) + 1;
        if (repeatsBefore >= LOOP_HARD_THRESHOLD) {
          throw new LoopDetectedError(`工具 ${call.name} 相同入参同果重复 ${repeatsBefore - 1} 次`);
        }
        const result = await deps.pipeline.execute(
          { toolCallId: call.toolCallId, name: call.name, args: call.args },
          { ...turnCtx, step },
          (type, payload) => sink.emit({ threadId: input.threadId, turnId: input.turnId, step, type, payload }),
        );
        approvalWaitMsTotal += result.approvalWaitMs ?? 0;
        toolsUsedThisTurn++;
        // docs/15：证据账本记账 + 计划快照 + 写文件集（完成审计的 ground truth 输入）
        if (result.evidence) evidenceLedger.push({ ...result.evidence, atStep: step });
        if (result.planUpdate) planSnapshot = result.planUpdate;
        for (const p of result.affectedPaths ?? []) filesTouched.add(p);
        // ---- docs/15 机制一：task_complete 完成声明（证据门先于收尾）----
        if (result.finish) {
          // 升级 A：blocked=受阻收尾（卡死的一等出口）——跳过证据门直接接受（其诚实形态常是零成功证据，套门会误拦）
          const gate = result.finish.outcome === 'blocked' ? { backed: true as const } : checkReportEvidence(result.finish, evidenceLedger);
          if (!gate.backed && evidenceGatesFired < MAX_EVIDENCE_GATES) {
            // 证据门阻断一次（Stop-hook exit-2 语义：把原因喂回模型，放行权仍在模型——补验证或如实降级后重声明）
            evidenceGatesFired++;
            const gateNote = `[证据核对] ${gate.reason}。请先补做验证（run_command / preview_control），或如实验证措辞后重新 task_complete；若确实无需验证，可在 verification 说明原因并再次声明。`;
            assistantMsg.parts.push({
              kind: 'tool-result',
              toolCallId: call.toolCallId,
              content: gateNote,
              truncated: false,
              originalChars: gateNote.length,
            });
            emitStep('observationAdded', { toolCallId: call.toolCallId, truncated: false, originalChars: gateNote.length, finalChars: gateNote.length, preview: gateNote.slice(0, 200), content: gateNote });
            emitStep('completionAudit', { verdict: 'evidence-gate' });
            completionNudge = gateNote;
            // 跳出工具循环；stepCompleted/状态更新由外层单点结算，主循环 continue（finish 不被接受，本轮未收尾）
            break;
          }
          // 接受声明（证据背书 / 门已用尽放行）：termination='selfReport'，summary 交 TurnResult
          const accepted = selfReportObservation(result.finish);
          assistantMsg.parts.push({
            kind: 'tool-result',
            toolCallId: call.toolCallId,
            content: accepted,
            truncated: false,
            originalChars: accepted.length,
          });
          emitStep('observationAdded', { toolCallId: call.toolCallId, truncated: false, originalChars: accepted.length, finalChars: accepted.length, preview: accepted.slice(0, 200), content: accepted });
          emitStep('completionAudit', { verdict: 'selfReport', ...(result.finish.outstanding.length > 0 ? { missing: result.finish.outstanding } : {}) });
          termination = 'selfReport';
          finalSummary = result.finish.summary;
          break;
        }
        obsBytesTotal += result.observation.length;
        // 软提醒：追加到模型可见的 tool-result（下一轮模型据此自纠）；并补发 observationAdded 让 UI 同步显示
        let observation = result.observation;
        const resultHash = hashToolCall('result', observation);
        const prevResultHash = lastResultByHash.get(hash);
        if (prevResultHash === undefined) {
          repeatCounts.set(hash, 1); // 首次执行：基线（该调用第 1 次连续同果）
        } else if (prevResultHash === resultHash) {
          repeatCounts.set(hash, repeatsBefore); // 同参同果：连续 no-op 累计
        } else {
          repeatCounts.delete(hash); // 同参异果：有效进展 → 重置
        }
        lastResultByHash.set(hash, resultHash);
        const repeatsNow = repeatCounts.get(hash) ?? 0;
        if (repeatsNow >= LOOP_REPEAT_THRESHOLD) {
          observation +=
            `\n\n[循环提醒] 这是第 ${repeatsNow} 次以完全相同的参数调用 ${call.name} 且结果相同，结果不会因此改变。` +
            `请检查参数是否正确、换一种做法，或直接向用户总结现状并结束本轮。`;
          emitStep('observationAdded', {
            toolCallId: call.toolCallId,
            truncated: result.truncated,
            originalChars: result.originalChars,
            finalChars: observation.length,
            preview: observation.slice(0, 200),
            content: observation,
          });
        }
        // docs/16：图像配额（每轮 ≤2 张，超出剥离并注记；translate 层按模型 vision 裁决是否发送）
        let keptImages = result.images ?? [];
        if (keptImages.length > 0) {
          const remaining = MAX_IMAGES_PER_TURN - imagesThisTurn;
          if (remaining <= 0) {
            keptImages = [];
            observation += '\n\n[截图已省略：本轮图像配额已用完——更早的截图仍在上下文中。]';
          } else if (keptImages.length > remaining) {
            keptImages = keptImages.slice(0, remaining);
            observation += `\n\n[本轮仅保留前 ${remaining} 张截图，其余已省略。]`;
          }
          imagesThisTurn += keptImages.length;
        }
        assistantMsg.parts.push({
          kind: 'tool-result',
          toolCallId: call.toolCallId,
          content: observation,
          truncated: result.truncated,
          originalChars: result.originalChars,
          ...(keptImages.length > 0 ? { images: keptImages } : {}),
        });
      }
      emitStep('stepCompleted', {
        finishReason: 'tool-calls',
        usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costEstimate: 0 },
      });
      state.stepCount = step;
      state.spent.steps = step;
      // ---- P0④ 边际产出软提醒：8 步零进展触发，此后每 4 步再提醒一次（advisory-only）----
      {
        const progressed = filesTouched.size > 0 && lastProgressAtStep === 0
          ? true
          : obsBytesTotal - obsBytesAtBaseline > 400 || filesTouched.size > filesAtBaseline;
        if (progressed) {
          lastProgressAtStep = step;
          obsBytesAtBaseline = obsBytesTotal;
          filesAtBaseline = filesTouched.size;
        } else if (lastProgressAtStep > 0 && step - lastProgressAtStep >= MARGINAL_STALL_STEPS) {
          completionNudge =
            `[边际产出提醒] 已连续 ${step - lastProgressAtStep} 步没有实质进展（无文件修改、工具结果几乎无新信息）。` +
            `这可能意味着：路径不对/方法不对/信息已足够。请停下重新评估：要么换一种做法，要么基于现有信息直接产出结果，要么调用 task_complete 收尾说明情况。`;
          lastProgressAtStep = step - MARGINAL_REMIND_EVERY; // 4 步后再提醒
          obsBytesAtBaseline = obsBytesTotal;
        }
        if (lastProgressAtStep === 0) lastProgressAtStep = step; // 首步建立基线
      }
      // docs/15：finish 已在本步处理（收尾或证据门阻断）——外层循环按 termination/nudge 决定
      if (termination === 'selfReport') break;
      if (completionNudge !== undefined) continue;
    }
  } catch (err) {
    if (input.abortController.signal.aborted || isAbortError(err)) {
      cancelled = true;
    } else if (err instanceof BudgetExceededError) {
      termination = err.reason;
      outcome = 'degraded';
      emit('degradationStarted', { reason: `预算越线: ${err.reason}` });
      finalSummary = await degrade(deps, emit, input, messages, `预算越线（${err.reason}）`).catch(() => undefined);
    } else if (err instanceof LoopDetectedError) {
      termination = 'loopDetected';
      outcome = 'degraded';
      emit('degradationStarted', { reason: err.message });
      finalSummary = await degrade(deps, emit, input, messages, err.message).catch(() => undefined);
    } else {
      emit('error', { source: 'system', message: String(err instanceof Error ? err.message : err), recoverable: false });
      termination = 'fatal';
      outcome = 'failed';
      const summary = await degrade(deps, emit, input, messages, '发生内部错误').catch(() => undefined);
      if (summary !== undefined) {
        finalSummary = summary;
        outcome = 'degraded';
      }
    }
  }

  // 模型错误：尝试用 cheap 档降级收尾（可能成功——如主模型限流而 cheap 可用）
  if (termination === 'modelError') {
    emit('degradationStarted', { reason: '模型错误，尝试降级收尾' });
    const summary = await degrade(deps, emit, input, messages, '模型调用失败').catch(() => undefined);
    if (summary !== undefined) {
      finalSummary = summary;
      outcome = 'degraded';
    }
  }

  // 消息完整性不变量：模型错误/预算熔断/用户取消等路径会留下"已 push 的 tool-call 无配对 result"，
  // 直接持久化将污染历史（下轮协议层 400/网关 500，translate 过滤只是治标）。单点修补覆盖全部终止路径。
  pairOrphanToolCalls(messages);

  if (cancelled) {
    emit('loopTerminated', { reason: 'userCancelled' });
    emit('turnCancelled', { turnId: input.turnId });
    return { reason: 'userCancelled', messages, usage: { inputTokens: totalUsage.inputTokens, outputTokens: totalUsage.outputTokens }, degraded: false, cancelled: true };
  }
  emit('loopTerminated', {
    reason: termination,
    ...(finalSummary !== undefined ? { finalSummary } : {}),
  });
  emit('turnCompleted', { outcome });
  return { reason: termination, finalSummary, messages, usage: { inputTokens: totalUsage.inputTokens, outputTokens: totalUsage.outputTokens }, degraded: outcome === 'degraded', cancelled: false };
}

/** 降级收尾：禁用工具，让 cheap 模型总结进展与停止原因（07 §4 / 05 §3） */
async function degrade(
  deps: AgentLoopDeps,
  emit: EmitWithStep,
  input: TurnInput,
  messages: ChatMessage[],
  reason: string,
): Promise<string> {
  const chunks: string[] = [];
  for await (const ev of deps.model.stream({
    modelTier: 'cheap',
    system: deps.systemBase() + degradeSummaryInstruction(reason),
    messages,
    tools: [],
    signal: input.abortController.signal,
  })) {
    if (ev.type === 'text-delta') chunks.push(ev.text);
    if (ev.type === 'finish' && ev.finishReason === 'error') {
      throw new Error(ev.errorMessage ?? '降级收尾失败');
    }
  }
  return chunks.join('');
}

function lastUserText(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      const text = m.parts
        .filter((p): p is Extract<typeof p, { kind: 'text' }> => p.kind === 'text')
        .map((p) => p.text)
        .join('');
      return text || undefined;
    }
  }
  return undefined;
}

function safeParse(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * 消息完整性不变量：每个 tool-call 必须有配对的 tool-result。
 * 为无配对的 tool-call 注入合成 result（原地修补，幂等）。
 */
function pairOrphanToolCalls(messages: ChatMessage[]): number {
  const paired = new Set<string>();
  for (const m of messages) {
    for (const p of m.parts) if (p.kind === 'tool-result') paired.add(p.toolCallId);
  }
  let patched = 0;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind === 'tool-call' && !paired.has(p.toolCallId)) {
        m.parts.push({
          kind: 'tool-result',
          toolCallId: p.toolCallId,
          content: '[轮次中断，工具未执行]',
          truncated: false,
          originalChars: 0,
        });
        paired.add(p.toolCallId);
        patched++;
      }
    }
  }
  return patched;
}

type EmitWithStep = <T extends EventType>(type: T, payload: LoopEventPayloads[T]) => void;

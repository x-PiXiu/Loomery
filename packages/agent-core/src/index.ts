// agent-core：用例层（loop / tools / context / memory / skills / session / events）
export { FanoutSink, type EventDraft, type EmitFn } from './events/fanout-sink';
export { newId } from './events/id';
export { JournalSink } from './session/journal';
export { ToolRegistry } from './tools/registry';
export {
  ToolPipeline,
  type PipelineConfig,
  type PipelineTurnCtx,
  type ToolCallRequest,
  type ToolExecutionOutcome,
} from './tools/pipeline';
export { ContextAssembler, type AssembleInput, type AssembleResult } from './context/assembler';
export { BriefProvider } from './memory/brief-provider';
export { SkillIndexProvider } from './skills/skill-provider';
export {
  groupMessages,
  partsToText,
} from './memory/groups';
export {
  compressIfNeeded,
  type CompressOptions,
  type CompressOutcome,
} from './memory/short-term';
export { extractFacts, parseFacts } from './memory/long-term';
export { MemoryRecallProvider } from './memory/memory-provider';
export { rebuildThread, type RebuiltThread } from './session/restore';
export { threadFingerprint, corpusFingerprint, compareGolden } from './testing/replay-eval';
export { ThreadService, type ThreadServiceDeps } from './session/thread-service';
export {
  runTurn,
  BudgetExceededError,
  LoopDetectedError,
  type AgentLoopDeps,
  type TurnInput,
  type TurnResult,
} from './loop/agent-loop';
// 测试基建（内部使用；供适配器包的集成测试复用）
export {
  FakeClock,
  FakeModel,
  FakeApprovals,
  RecordingSink,
  InMemoryStore,
} from './testing/fakes';
export { createTaskCompleteTool } from './tools/task-complete';
export { COMPLETION_AUDIT_SYSTEM, FACT_EXTRACT_SYSTEM, degradeSummaryInstruction } from './prompts';

// P2 统计二期：usageDelta 补 model 出处（新数据可按模型归因；历史无 model 字段归"历史"桶）
const fs = require('node:fs');
const R = 'packages/';
const patch = (file, pairs) => {
  let s = fs.readFileSync(R + file, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) { console.error('MISS in ' + file + ': ' + a.slice(0, 70)); process.exit(1); }
    s = s.replace(a, b);
  }
  fs.writeFileSync(R + file, s);
  console.log('ok: ' + file);
};

// 1) domain：usageDelta 载荷 + model?
patch('domain/src/event.ts', [
  ["  usageDelta: { inputTokens: number; outputTokens: number };", "  usageDelta: { inputTokens: number; outputTokens: number; /** 出处模型 id（P2 统计；历史事件无此字段） */ model?: string };"],
]);

// 2) loop：TurnInput.model 透传给 usageDelta（thread-service 传入实际 modelId）
patch('agent-core/src/loop/agent-loop.ts', [
  ["            emitStep('usageDelta', { inputTokens: ev.delta.inputTokens, outputTokens: ev.delta.outputTokens });", "            emitStep('usageDelta', { inputTokens: ev.delta.inputTokens, outputTokens: ev.delta.outputTokens, ...(input.model && input.model !== 'main' ? { model: input.model } : {}) });"],
]);

// 3) thread-service：TurnInput.model 从 deps.modelId（bootstrap 传实际模型 id）
patch('agent-core/src/session/thread-service.ts', [
  ["          model: 'main',", "          model: this.deps.modelId ?? 'main',"],
]);
patch('agent-core/src/loop/agent-loop.ts', [
  [`  systemBase: string;
  budget: Budget;`, `  /** 当前生效模型 id（usageDelta 出处归因，P2 统计） */
  modelId?: string;
  systemBase: string;
  budget: Budget;`],
]);
patch('agent-core/src/session/thread-service.ts', [
  [`  /** 当前生效模型 id（usageDelta 出处归因，P2 统计） */
  modelId?: string;
  systemBase: string;`, `  /** 当前生效模型 id（usageDelta 出处归因，P2 统计） */
  modelId?: string;
  systemBase: string;`],
]);
// ThreadServiceDeps 加字段（找准接口位置：pipeline 之后）
let s = fs.readFileSync(R + 'agent-core/src/session/thread-service.ts', 'utf8');
if (!s.includes('modelId?: string')) {
  s = s.replace(
    '  pipeline: ToolPipeline;\n  registry: ToolRegistry;',
    '  pipeline: ToolPipeline;\n  registry: ToolRegistry;\n  /** 当前生效模型 id（usageDelta 出处归因，P2 统计） */\n  modelId?: string;');
  fs.writeFileSync(R + 'agent-core/src/session/thread-service.ts', s);
}
console.log('kernel provenance done');

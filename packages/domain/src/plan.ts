// ADR-0026 计划分解：计划是"模型能力经工具外显"，内核只持有实体契约与事件通道
// 全量快照语义（last-write-wins）：重放逐条覆盖即得终态，与折叠哲学（ADR-0014 系）天然一致
export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface PlanStep {
  /** 稳定键（校验器按序生成 s1..sN，模型不提供 id——少一个出错面） */
  id: string;
  title: string;
  status: PlanStepStatus;
}

export interface PlanState {
  turnId: string;
  steps: PlanStep[];
  updatedAt: number;
}

export const PLAN_MIN_STEPS = 2;
export const PLAN_MAX_STEPS = 12;
export const PLAN_TITLE_MAX = 60;

const VALID_STATUS: readonly PlanStepStatus[] = ['pending', 'in_progress', 'completed', 'failed'];

/**
 * LLM 输出的守门员：非法输入返回 null（调用方转为工具失败观察，模型自纠）。
 * 迁移宽松（任意→任意合法状态）——模型友好优先，不做状态机限制。
 */
export function validatePlanSteps(input: unknown): PlanStep[] | null {
  if (!Array.isArray(input) || input.length < PLAN_MIN_STEPS || input.length > PLAN_MAX_STEPS) return null;
  const out: PlanStep[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i] as { title?: unknown; status?: unknown } | null;
    if (!raw || typeof raw !== 'object') return null;
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (title.length === 0 || title.length > PLAN_TITLE_MAX) return null;
    if (!VALID_STATUS.includes(raw.status as PlanStepStatus)) return null;
    out.push({ id: `s${i + 1}`, title, status: raw.status as PlanStepStatus });
  }
  return out;
}

/** 进度计数（胶囊 N/M 显示用） */
export function planProgress(steps: PlanStep[]): { done: number; total: number } {
  return { done: steps.filter((s) => s.status === 'completed').length, total: steps.length };
}

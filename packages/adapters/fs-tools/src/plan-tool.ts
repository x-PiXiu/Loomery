// ADR-0026：计划分解 = 模型能力经工具外显（TodoWrite 模式）
// 纯状态自报、零 IO——sideEffect:'read'（免审 + plan/explain 模式可用）；校验失败回灌可自纠的观察
import { validatePlanSteps } from '@loomery/domain';
import type { RegisteredTool } from '@loomery/ports';

export function createPlanTool(): RegisteredTool {
  return {
    name: 'plan_write',
    description:
      // 11-17 上下文瘦身：适用时机/状态流转与 SYSTEM_BASE「计划分解」去重，保留全量覆盖契约
      '维护当前任务的子步骤计划清单（2~12 步，每步一句话）。每次调用提交全量清单（覆盖式更新）。' +
      '多步任务开工前置清单、状态流转（in_progress/completed/failed）与适用边界见系统提示「计划分解」节。',
    inputSchema: {
      type: 'object',
      required: ['steps'],
      additionalProperties: false,
      properties: {
        steps: {
          type: 'array',
          description: '全量步骤清单（覆盖更新，不是增量）',
          items: {
            type: 'object',
            required: ['title', 'status'],
            additionalProperties: false,
            properties: {
              title: { type: 'string', description: '步骤名（一句话，≤60 字）' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'], description: '步骤状态' },
            },
          },
        },
      },
    },
    sideEffect: 'read',
    source: 'builtin',
    handler: async (input) => {
      const steps = validatePlanSteps((input as { steps: unknown }).steps);
      if (!steps) {
        return {
          ok: false,
          content: `计划未通过校验：steps 必须是 2~12 个对象的数组，每项含非空 title（≤60 字）与 status（pending/in_progress/completed/failed）。请修正后重新提交。`,
          affectedPaths: [],
        };
      }
      const done = steps.filter((s) => s.status === 'completed').length;
      return {
        ok: true,
        content: `计划已更新：共 ${steps.length} 步（完成 ${done}）。继续按计划推进，状态变化时再次提交全量清单。`,
        affectedPaths: [],
        planUpdate: steps,
      };
    },
  };
}

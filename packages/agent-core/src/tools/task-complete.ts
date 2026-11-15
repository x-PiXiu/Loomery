// docs/15 机制一：task_complete 完成声明工具——"要不要停"是模型的智能判断，本工具给判断一个结构化通道。
// 零 I/O 的内核协议工具（SWE-agent submit / OpenHands finish 同构）：sideEffect 'read' 免审。
// 交叉核对（verification vs 证据账本）不在 handler 做——handler 无循环状态，账本核对由 loop 收到 finish 后执行。
import { parseCompletionSelfReport } from '@loomery/domain';
import type { RegisteredTool } from '@loomery/ports';

export function createTaskCompleteTool(): RegisteredTool {
  return {
    name: 'task_complete',
    description:
      '声明本轮任务收尾（调用后本轮即结束）。必须先对照计划自查：outcome=complete（任务完成，默认）或 blocked（无法继续——' +
      '缺权限/需求矛盾/反复失败，此时 outstanding 必须写明阻塞原因，不要硬磨）；summary=做了什么（1-3 句）；' +
      'outstanding=遗留项/未完成项（无则空数组）；verification=做过的验证（编译/测试/preview console 检查——' +
      '做过写操作但没验证过时，先去验证再声明；blocked 时可写尝试过程与失败原因）；confidence=完成把握。' +
      '注意：outcome=complete 时内核会把 verification 与真实命令执行记录交叉核对，虚报会被拦下要求补验证。',
    inputSchema: {
      type: 'object',
      required: ['summary', 'outstanding', 'verification', 'confidence', 'outcome'],
      additionalProperties: false,
      properties: {
        summary: { type: 'string', description: '完成了什么（1-3 句）' },
        outstanding: { type: 'array', items: { type: 'string' }, description: '遗留项/未完成项/阻塞原因（无则空数组）' },
        verification: { type: 'string', description: '做过的验证及结果（如"npm run build exit 0"；无需验证则说明原因）' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: '完成把握' },
        outcome: { type: 'string', enum: ['complete', 'blocked'], description: 'complete=任务完成；blocked=无法继续（缺权限/需求矛盾/反复失败）' },
      },
    },
    sideEffect: 'read',
    source: 'builtin',
    handler: async (input) => {
      const report = parseCompletionSelfReport(input);
      if (!report) {
        return {
          ok: false,
          content: '完成声明缺少 summary（必填，1-3 句）。请补全后重新调用 task_complete。',
          affectedPaths: [],
        };
      }
      return {
        ok: true,
        content: '', // 占位——loop 捕获 finish 后用 selfReportObservation 覆写 tool-result 内容
        affectedPaths: [],
        finish: report,
      };
    },
  };
}

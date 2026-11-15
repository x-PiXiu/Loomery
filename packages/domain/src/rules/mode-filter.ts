// 03 §5 模式过滤规则：plan/explain 只读；edit 全放行
import type { AgentMode } from '../session';
import type { ToolSpec } from '../tool';

export function modeAllows(mode: AgentMode, tool: Pick<ToolSpec, 'sideEffect'>): boolean {
  if (mode === 'edit') return true;
  return tool.sideEffect === 'read';
}

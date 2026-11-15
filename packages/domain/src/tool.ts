// 03 §5 工具契约（模型侧）：可序列化规格，进入 ModelRequest 与事件载荷
// 执行侧契约（ToolHandler/ToolContext/ToolResult/RegisteredTool）归 ports 所有（ADR-0015）
export type SideEffect = 'read' | 'write' | 'execute';

export type ToolSource = 'builtin' | 'plugin' | 'task';

/** JSON Schema 是内核的 schema 规范（ADR-0002）；Zod 仅允许在适配器层构造 */
export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  /** 全局唯一，snake_case */
  name: string;
  /** 面向模型的说明，必填 */
  description: string;
  inputSchema: JsonSchema;
  sideEffect: SideEffect;
  source: ToolSource;
}

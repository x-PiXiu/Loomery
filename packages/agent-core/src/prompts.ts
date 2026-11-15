// 2026-11-13 P1⑤ Prompt 收拢：内核用到的 LLM prompt 常量统一管理（此前散在 completion-audit/long-term 各文件）
// 原则：prompt 是用例层资产——不进 domain（无业务规则），不进 bootstrap（非组合根专属）

/** 完成审计（批判者）system：只输出 JSON 裁决，禁止工具 */
export const COMPLETION_AUDIT_SYSTEM = '你是严格的完成审计员，只输出 JSON。不要执行任何工具。';

/** 长期记忆提炼 system：偏好/约定/事实三类，禁环境快照（11-03 实证：环境快照入全局记忆误导后续会话） */
export const FACT_EXTRACT_SYSTEM =
  '从对话中提炼值得跨会话记住的信息：用户偏好（preference）、项目约定（convention）、事实（fact）。' +
  '只输出 JSON 数组，元素形如 {"kind":"preference","content":"..."}；没有值得记住的内容时输出 []。不要输出其他文字。' +
  '禁止提炼环境快照类信息——当前工作区路径、当前可用的工具列表、会话/任务状态、正在做什么——这些从环境即可得知且随切换而过时，' +
  '存成全局记忆会误导后续会话（应用已在系统提示里权威注入工作区）。只记稳定的偏好、约定与领域事实。';

/** 降级收尾 user 后缀（agent-loop degrade）：强制禁用工具总结 */
export function degradeSummaryInstruction(reason: string): string {
  return `

Agent 刚刚被强制停止，原因：${reason}。请用不超过 200 字总结目前已完成的进展与停止原因。不要提议执行任何工具操作。`;
}

// 03 §7 结构化诊断（P3 任务系统/LSP 消费，P1 定义）
export interface Diagnostic {
  /** 绝对路径（ADR-0013） */
  file: string;
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
  severity: 'error' | 'warning' | 'info' | 'hint';
  code?: string;
  message: string;
  /** 'tsc' | 'eslint' | 'go-build' | ... */
  source?: string;
}

// 03 §9 P3 预留：任务系统端口（结构化诊断在 domain/Diagnostic）
import type { Diagnostic } from '@loomery/domain';

export interface TaskDef {
  id: string;
  name: string;
  command: string;
  kind: 'build' | 'test' | 'run';
}

export interface TaskRun {
  onOutput(cb: (chunk: string) => void): void;
  onDiagnostics(cb: (diagnostics: Diagnostic[]) => void): void;
  kill(): void;
}

export interface TaskProvider {
  /** 项目类型检测：package.json / pyproject.toml / go.mod / Cargo.toml */
  detect(workspaceRoots: string[]): Promise<string | null>;
  listTasks(): Promise<TaskDef[]>;
  run(taskId: string): TaskRun;
}

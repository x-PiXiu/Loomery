// fs-tools：内置文件工具集合。注册由组合根（shell/bootstrap）完成。
import type { CheckpointPort, ProcessPort, RegisteredTool } from '@loomery/ports';
import { CheckpointService } from './checkpoint/checkpoint';
import { createApplyDiff } from './apply-diff';
import { createListDir } from './list-dir';
import { createReadFile } from './read-file';
import { createSearchText } from './search-text';
import { createWriteFile } from './write-file';
import { createEditorDiagnosticsTool } from './editor-diagnostics-tool';
import { createBrowserControlTool } from './browser-control-tool';
import { createDeleteFile } from './delete-file';
import { createRunCommand, type RunCommandOptions } from './execute';
import { createBriefWrite, createMemoryPin, createReadArtifact, createReadSkill, type MemoryToolsDeps } from './memory-tools';

export { CheckpointService } from './checkpoint/checkpoint';
export { rollbackTurn } from './checkpoint/rollback';
export { validateHunks, applyHunks, makeHunkProposal, makeFullFileProposal } from './diff-engine';
export { createBriefWrite, createMemoryPin, createReadArtifact, createReadSkill, type MemoryToolsDeps } from './memory-tools';
export { createRunCommand } from './execute';
export type { RunCommandOptions } from './execute';
export { createGitTools, createGitStatus, createGitDiff, createGitLog, createGitCommit } from './git-tools';
export { createPreviewTool } from './preview-tool';
export { createEditorDiagnosticsTool } from './editor-diagnostics-tool';
export { createBrowserControlTool } from './browser-control-tool';
export { createDeleteFile } from './delete-file';
export { createPlanTool } from './plan-tool';
import { createPreviewTool, type PreviewToolDeps } from './preview-tool';
import { createPlanTool } from './plan-tool';

export interface BuiltinToolsOptions {
  /** checkpoint 快照根目录（userData/checkpoints） */
  checkpointRoot: string;
}

export function createCheckpointService(opts: BuiltinToolsOptions): CheckpointService {
  return new CheckpointService(opts.checkpointRoot);
}

/**
 * P2.0（ADR-0021/0022）：memoryTools 缺省不注册（无四仓库依赖的调用方保持原行为）。
 * process 存在时注册 run_command（12 §F1.2）。
 */
export function createBuiltinTools(
  checkpoint: CheckpointPort,
  memoryTools?: MemoryToolsDeps,
  process?: ProcessPort,
  runCommandOpts?: RunCommandOptions,
  preview?: PreviewToolDeps,
): RegisteredTool[] {
  const base = [
    createReadFile(),
    createListDir(),
    createSearchText(),
    createWriteFile(checkpoint),
    createApplyDiff(checkpoint),
    createPlanTool(), // ADR-0026：计划分解（免审 read 类，零依赖）
    createEditorDiagnosticsTool(), // 2026-11-13 P0①：编辑器级验证闭环（Monaco 实时诊断查询，免审 read）
    createBrowserControlTool(), // docs/16 P2：浏览器标签控制（截图/交互/读取，免审 read）
    createDeleteFile(checkpoint), // 2026-11-13 P1④：删除文件（write 类+审批+checkpoint 可回滚）
  ];
  if (process) base.push(createRunCommand(process, runCommandOpts));
  if (preview) base.push(createPreviewTool(preview));
  if (!memoryTools) return base;
  return [
    ...base,
    createMemoryPin(),
    createBriefWrite(memoryTools),
    createReadArtifact(memoryTools),
    createReadSkill(memoryTools),
  ];
}
export { makeTerritoryVerifier, resolveRealPath } from './territory';
export { createProjectInstructionsProvider } from './agents-md-provider';

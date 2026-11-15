// 05 §4 / ADR-0021：存储相关纯规则——产物拦截判定、路径合法域（workspace ∪ scratch）
import { estimateTokens } from './token-estimate';
import { isPathInsideWorkspace } from './path-guard';
import type { ArtifactRef } from '../memory';

/** 产物拦截判定（tool-runtime 管道第 7 步调用）：超过阈值 token 的结果整体入库，上下文只留引用 */
export function decideArtifactCapture(content: string, thresholdTokens: number): { capture: boolean; tokens: number } {
  const tokens = estimateTokens(content);
  return { capture: tokens > thresholdTokens, tokens };
}

/** 产物一行摘要：首个非空行，截到 80 字符（含省略号；进上下文与事件的全部内容） */
export function artifactSummary(content: string): string {
  const firstLine = content.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const line = firstLine.trim();
  return line.length > 80 ? line.slice(0, 79) + '…' : line;
}

/** 组装 ArtifactRef 的可序列化部分（hash 由适配器计算后补齐） */
export function artifactMeta(content: string, kind: ArtifactRef['kind']): { kind: ArtifactRef['kind']; summary: string; size: number } {
  return { kind, summary: artifactSummary(content), size: Buffer.byteLength(content, 'utf8') };
}

/**
 * 写路径合法域：workspace ∪ 本任务 scratch 目录（ADR-0021）。
 * scratchRoot 为 null/undefined 时退化为纯工作区判定（兼容既有调用）。
 */
export function isWritablePath(absolutePath: string, workspaceRoots: string[], scratchRoot?: string | null): boolean {
  if (isPathInsideWorkspace(absolutePath, workspaceRoots)) return true;
  if (scratchRoot && isPathInsideWorkspace(absolutePath, [scratchRoot])) return true;
  return false;
}

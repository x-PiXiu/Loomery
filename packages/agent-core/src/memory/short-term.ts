// 05 §6 短期记忆压缩：超阈值时把最老 K 组压成 summary part（cheap 模型）
// 压缩决策与结果本身必须作为 memoryCompressed 事件落日志（ADR-0012，由调用方发布）
import { SHORT_TERM_TOKEN_THRESHOLD } from '@loomery/domain';
import type { ChatMessage } from '@loomery/domain';
import { estimateTokens } from '@loomery/domain';
import { newId } from '../events/id';
import { groupMessages, partsToText } from './groups';

export interface CompressOptions {
  thresholdTokens?: number;
  /** 保留最近 N 组不压缩 */
  keepRecentGroups?: number;
  /** 摘要消息时间戳（注入时钟，保持与事件 ts 同源；缺省 Date.now） */
  now?: number;
}

export interface CompressOutcome {
  /** 压缩后的完整消息数组（summary 消息 + 保留的近期组） */
  messages: ChatMessage[];
  compressedIds: string[];
  summary: string;
  tokensSaved: number;
}

export async function compressIfNeeded(
  messages: ChatMessage[],
  opts: CompressOptions,
  /** 由调用方注入 cheap 模型（ModelClient 的 cheap 档），保持本模块可测 */
  summarize: (conversationText: string) => Promise<string>,
): Promise<CompressOutcome | null> {
  const threshold = opts.thresholdTokens ?? SHORT_TERM_TOKEN_THRESHOLD;
  const keepRecent = opts.keepRecentGroups ?? 2;
  const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(partsToText(m)), 0);
  if (totalTokens < threshold) return null;

  const groups = groupMessages(messages);
  if (groups.length <= keepRecent) return null;

  const toCompress = groups.slice(0, groups.length - keepRecent).flat();
  const compressedIds = toCompress.map((m) => m.id);
  const originalTokens = toCompress.reduce((sum, m) => sum + estimateTokens(partsToText(m)), 0);
  const summary = await summarize(toCompress.map(partsToText).join('\n\n'));
  // 摘要为空 = 模型调用失败（无密钥/网络/限流）——按失败处理（抛错），绝不用空摘要替换真实历史
  if (summary.trim().length === 0) throw new Error('摘要模型返回为空（请检查 cheap 档模型与 API Key 配置）');

  const summaryMessage: ChatMessage = {
    id: newId('msg'),
    role: 'assistant',
    createdAt: opts.now ?? Date.now(),
    parts: [
      {
        kind: 'summary',
        text: summary,
        summarizedRange: [1, compressedIds.length],
      },
    ],
  };
  const kept = groups.slice(groups.length - keepRecent).flat();
  return {
    messages: [summaryMessage, ...kept],
    compressedIds,
    summary,
    tokensSaved: Math.max(0, originalTokens - estimateTokens(summary)),
  };
}

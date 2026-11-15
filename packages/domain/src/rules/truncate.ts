// 07 §9 工具结果硬截断：一切工具输出进入 messages 前必须经过；不提供关闭开关
export interface TruncationResult {
  content: string;
  truncated: boolean;
  originalChars: number;
  finalChars: number;
}

export function truncateText(text: string, cap: number): TruncationResult {
  if (text.length <= cap) {
    return { content: text, truncated: false, originalChars: text.length, finalChars: text.length };
  }
  const content = `${text.slice(0, cap)}\n…[truncated ${text.length - cap} chars]`;
  return { content, truncated: true, originalChars: text.length, finalChars: content.length };
}

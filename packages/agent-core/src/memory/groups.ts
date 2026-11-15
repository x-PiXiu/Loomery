// 05 §6 记忆压缩以"tool-call/tool-result 配对组"为最小单元：组边界 = 用户消息
import type { ChatMessage, MessagePart } from '@loomery/domain';

/** 将消息序列切分为压缩组：每条用户消息开启新组，其后所有 assistant 归入同组（保证配对不拆散） */
export function groupMessages(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'user' || groups.length === 0) {
      groups.push([message]);
    } else {
      groups[groups.length - 1]?.push(message);
    }
  }
  return groups;
}

/** 消息的可读化文本（压缩与提炼的输入） */
export function partsToText(message: ChatMessage): string {
  const render = (p: MessagePart): string => {
    switch (p.kind) {
      case 'text':
        return p.text;
      case 'summary':
        return `[摘要] ${p.text}`;
      case 'image':
        return `[图像 ${p.mime}]`;
      case 'tool-call':
        return `[调用工具 ${p.name}，参数 ${p.args.slice(0, 200)}]`;
      case 'tool-result':
        return `[工具结果 ${p.toolCallId}] ${p.content.slice(0, 300)}`;
    }
  };
  return message.parts.map(render).join('\n');
}

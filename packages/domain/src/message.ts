// 03 §2 消息模型：内核自有类型，禁止 AI SDK 类型渗入（ADR-0002）
export type Role = 'user' | 'assistant' | 'system';

/** docs/16 多模态：图像引用（base64 内联；单张 ~150KB JPEG，每轮 ≤2 张由 loop 配额保证） */
export interface ImageRef {
  mime: 'image/jpeg' | 'image/png';
  base64: string;
}

export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mime: string; base64: string }
  | { kind: 'summary'; text: string; summarizedRange: [number, number] }
  | { kind: 'tool-call'; toolCallId: string; name: string; args: string }
  | {
      kind: 'tool-result';
      toolCallId: string;
      content: string;
      truncated: boolean;
      originalChars: number;
      /** docs/16：工具产生的图像（截图等）——translate 层按模型 vision 能力裁决进消息的方式 */
      images?: ImageRef[];
    };

export interface ChatMessage {
  id: string;
  role: Role;
  parts: MessagePart[];
  createdAt: number;
}

// ADR-0002：自有消息模型 ↔ AI SDK ModelMessage 的翻译层（全工程唯一 import 'ai' 的包）
// 关键规则：tool-result 必须落在独立的 { role: 'tool' } 消息里（SDK 约束）
import type { ChatMessage, ToolSpec } from '@loomery/domain';
import type { FinishReason, ModelMessage, ToolSet } from 'ai';
import { jsonSchema, tool } from 'ai';

function safeParseArgs(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

export interface TranslateOptions {
  /** docs/16：当前档位模型的视觉能力（ModelConfig.capabilities.input 含 'image'）——false 时图像剥离并注记 */
  vision?: boolean;
}

/** docs/16 修正（2026-11-13 实证）：图像必须以二进制传入——data URL 字符串会被 AI SDK 当 URL 发起下载
 * （"Failed to download data:image/png;base64,..."），Uint8Array 则直接转 base64 上传 */
function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

export function toModelMessages(messages: ChatMessage[], opts?: TranslateOptions): ModelMessage[] {
  const vision = opts?.vision === true;
  const out: ModelMessage[] = [];
  const toolResults: Array<{
    type: 'tool-result';
    toolCallId: string;
    toolName: string;
    output: { type: 'text'; value: string };
  }> = [];

  // docs/16 修正（2026-11-13 实证）：图像注入必须遵守两条铁律——
  // ① 位置：只能在 assistant(tool-calls) → tool(results) 出队之后（此前实现在 assistant 消息中途 flush，
  //    tool 消息被提前到 assistant 之前 → MiniMax 2013 "tool id not found" → modelError）
  // ② !vision：降级注记拼进最后一条 tool 文本（绝不插入 user 消息——MiniMax 对 tool 后接 user 报同样错误）
  let pendingImages: { mime: string; base64: string }[] = [];
  let strippedNoted = false;
  const stripNote = '[截图已省略：当前模型不支持视觉输入。可用 preview_control(action="content") 以文本方式读取页面内容，或在模型设置切换多模态模型。]';
  const flushImages = (images: { mime: string; base64: string }[] | undefined): void => {
    if (!images || images.length === 0) return;
    if (!vision) {
      if (!strippedNoted && toolResults.length > 0) {
        strippedNoted = true;
        const last = toolResults[toolResults.length - 1];
        if (last) last.output.value += '\n\n' + stripNote;
      }
      return;
    }
    out.push({
      role: 'user',
      content: images.map((img) => ({ type: 'image' as const, image: base64ToBytes(img.base64) })),
    });
  };

  const flushToolResults = (): void => {
    if (toolResults.length === 0) return;
    out.push({ role: 'tool', content: toolResults.splice(0) });
  };

  for (const m of messages) {
    if (m.role === 'user') {
      flushToolResults();
      const userContent: Array<{ type: 'text'; text: string } | { type: 'image'; image: string | Uint8Array }> = [];
      let userImageCount = 0;
      for (const p of m.parts) {
        if (p.kind === 'text') userContent.push({ type: 'text', text: p.text });
        else if (p.kind === 'image') {
          // docs/16：vision=false 时剥离图像但给模型可见说明（否则模型答"没收到图片"用户一头雾水）
          userImageCount++;
          if (vision) userContent.push({ type: 'image', image: base64ToBytes(p.base64) });
        }
      }
      if (userImageCount > 0 && !vision) {
        userContent.unshift({ type: 'text', text: `[用户附加了 ${userImageCount} 张截图——当前模型不支持视觉输入。请提示用户在模型设置开启该模型的视觉能力（👁），或切换多模态模型；在此之前请基于文字描述回应。]` });
      }
      if (userContent.length === 0) userContent.push({ type: 'text', text: '（空消息）' });
      out.push({ role: 'user', content: userContent });
      continue;
    }
    if (m.role === 'system') {
      flushToolResults();
      out.push({
        role: 'system',
        content: m.parts
          .filter((p): p is Extract<typeof p, { kind: 'text' | 'summary' }> => p.kind === 'text' || p.kind === 'summary')
          .map((p) => p.text)
          .join('\n'),
      });
      continue;
    }
    // assistant：text/summary/tool-call 进 assistant 消息；tool-result 收集后单独成消息。
    // 协议边界不变量【P2 实证】：未配对 tool-call（无同消息 result）绝不出网——异常终止
    // （loopDetected/modelError/强杀）会留下"有 call 无 result"的消息，OpenAI 兼容网关对其直接 500
    //（用户实测 MiMo 报 Internal Error 且不可重试）。配对过滤在这里做（协议归属地），历史保持原样。
    const pairedIds = new Set(
      m.parts.filter((p) => p.kind === 'tool-result').map((p) => (p as { toolCallId: string }).toolCallId),
    );
    const assistantContent: Array<
      { type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
    > = [];
    for (const p of m.parts) {
      if (p.kind === 'text') {
        assistantContent.push({ type: 'text', text: p.text });
      } else if (p.kind === 'summary') {
        assistantContent.push({ type: 'text', text: `[早期对话摘要]\n${p.text}` });
      } else if (p.kind === 'tool-call') {
        if (!pairedIds.has(p.toolCallId)) continue; // 未配对：丢弃（历史不改，只挡在协议边界）
        assistantContent.push({
          type: 'tool-call',
          toolCallId: p.toolCallId,
          toolName: p.name,
          input: safeParseArgs(p.args),
        });
      } else if (p.kind === 'tool-result') {
        // toolName 从同一消息内的配对 tool-call 查找
        const call = m.parts.find(
          (q) => q.kind === 'tool-call' && q.toolCallId === p.toolCallId,
        );
        toolResults.push({
          type: 'tool-result',
          toolCallId: p.toolCallId,
          toolName: call && call.kind === 'tool-call' ? call.name : 'unknown',
          output: { type: 'text', value: p.content },
        });
        if (p.images && p.images.length > 0) pendingImages.push(...p.images);
      }
    }
    // 全部 tool-call 被过滤的空 assistant 消息也不出网（只有被丢弃的 call 时 content 为空）
    const hasRealContent = assistantContent.some((c) => c.type === 'text' ? c.text.length > 0 : true);
    if (assistantContent.length > 0 && hasRealContent) {
      out.push({ role: 'assistant', content: assistantContent });
      // docs/16 修正①：assistant 出队后 → tool(results) → 图像 user 段（顺序合法）
      // !vision 注记必须写进未 splice 的 toolResults 再 flush（顺序：注记在 tool 消息内，绝不插 user 消息）
      if (pendingImages.length > 0 && !vision) {
        const lastTool = toolResults[toolResults.length - 1];
        if (lastTool && !strippedNoted) {
          strippedNoted = true;
          lastTool.output.value += '\n\n' + stripNote;
        }
      }
      flushToolResults();
      flushImages(pendingImages);
      pendingImages = [];
    }
    flushToolResults();
  }
  flushToolResults();
  return out;
}

/** 工具规格 → SDK 工具集；不传 execute——执行权在循环手里（ADR-0001） */
export function toSdkTools(tools: ToolSpec[]): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
    });
  }
  return set;
}

export function mapFinishReason(fr: FinishReason): 'stop' | 'tool-calls' | 'length' | 'error' {
  if (fr === 'stop') return 'stop';
  if (fr === 'tool-calls') return 'tool-calls';
  if (fr === 'length') return 'length';
  return 'error';
}

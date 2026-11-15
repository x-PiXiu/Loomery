// 05 §6 长期记忆提炼：Turn 结束后从对话中提炼偏好/约定/事实（cheap 模型，JSON 输出）
import { FACT_EXTRACT_SYSTEM } from '../prompts';
import type { ChatMessage, MemoryFact } from '@loomery/domain';
import type { ModelClient } from '@loomery/ports';
import { newId } from '../events/id';
import { partsToText } from './groups';



export async function extractFacts(
  model: ModelClient,
  messages: ChatMessage[],
  now: number,
): Promise<MemoryFact[]> {
  const conversation = messages.map(partsToText).join('\n').slice(-8000);
  const chunks: string[] = [];
  for await (const ev of model.stream({
    modelTier: 'cheap',
    system: FACT_EXTRACT_SYSTEM,
    messages: [
      { id: newId('msg'), role: 'user', parts: [{ kind: 'text', text: conversation }], createdAt: now },
    ],
    tools: [],
    signal: new AbortController().signal,
  })) {
    if (ev.type === 'text-delta') chunks.push(ev.text);
  }
  return parseFacts(chunks.join(''), now);
}

/** 容忍 markdown 围栏与前后噪声 */
export function parseFacts(text: string, now: number): MemoryFact[] {
  const match = /\[[\s\S]*\]/.exec(text);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const kinds = new Set(['preference', 'convention', 'fact']);
  const facts: MemoryFact[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const { kind, content } = item as { kind?: unknown; content?: unknown };
    if (typeof kind !== 'string' || !kinds.has(kind)) continue;
    if (typeof content !== 'string' || content.trim().length === 0) continue;
    facts.push({
      id: newId('fact'),
      kind: kind as MemoryFact['kind'],
      content: content.trim(),
      createdAt: now,
      source: 'extracted',
    });
  }
  return facts;
}

/**
 * ADR-0021 提炼分级（纯函数）：preference=用户偏好升全局（store.saveFact 落 facts.json）；
 * convention/fact=任务级，由 memoryExtracted 事件承载（读模型=事件折叠，saveFact 对 task scope 无操作）。
 */
export function scopeExtractedFacts(facts: MemoryFact[], threadId: string, turnId?: string): { global: MemoryFact[]; task: MemoryFact[] } {
  const global: MemoryFact[] = [];
  const task: MemoryFact[] = [];
  for (const fact of facts) {
    if (fact.kind === 'preference') {
      global.push(fact);
    } else {
      task.push({ ...fact, scope: 'task', threadId, ...(turnId ? { turnId } : {}) });
    }
  }
  return { global, task };
}

import { describe, expect, it } from 'vitest';
import { scopeExtractedFacts } from './long-term';
import type { MemoryFact } from '@loomery/domain';

function fact(kind: MemoryFact['kind'], content: string): MemoryFact {
  return { id: 'f_' + content, kind, content, createdAt: 0, source: 'extracted' };
}

describe('scopeExtractedFacts（ADR-0021 提炼分级）', () => {
  it('preference 升全局；convention/fact 落任务级并带 threadId/turnId', () => {
    const { global, task } = scopeExtractedFacts(
      [fact('preference', '回答用中文'), fact('convention', '提交用 conventional commits'), fact('fact', '入口在 src/main.ts')],
      't1',
      'u1',
    );
    expect(global.map((f) => f.kind)).toEqual(['preference']);
    expect(global[0]!.scope).toBeUndefined();
    expect(task).toHaveLength(2);
    expect(task.every((f) => f.scope === 'task' && f.threadId === 't1' && f.turnId === 'u1')).toBe(true);
  });
  it('turnId 缺省时不带该字段', () => {
    const { task } = scopeExtractedFacts([fact('fact', 'x')], 't1');
    expect(task[0]!.turnId).toBeUndefined();
    expect('turnId' in task[0]!).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { ContextAssembler } from './assembler';
import type { ContextProvider } from '@loomery/ports';

function provider(id: string, priority: number, tokens: number, text = `chunk-${id}`): ContextProvider {
  return { id, priority, provide: async () => ({ providerId: id, text, priority, tokens }) };
}

describe('ContextAssembler（05 §5 预算分配）', () => {
  it('按 priority 升序保留，超预算的低优先级被丢弃', async () => {
    const a = new ContextAssembler(
      [provider('low', 9, 500), provider('high', 1, 300), provider('mid', 5, 300)],
      600,
    );
    const r = await a.assemble({ threadId: 't1', mode: 'edit', systemBase: 'BASE' });
    expect(r.providers.map((p) => p.id)).toEqual(['high', 'mid']);
    expect(r.dropped).toEqual(['low']);
    expect(r.totalTokens).toBe(600);
    expect(r.system).toBe('BASE\n\nchunk-high\n\nchunk-mid');
  });

  it('单个 provider 抛错不拖垮装配', async () => {
    const broken: ContextProvider = { id: 'broken', priority: 1, provide: async () => { throw new Error('boom'); } };
    const ok = provider('ok', 2, 100);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = new ContextAssembler([broken, ok], 1000);
    const r = await a.assemble({ threadId: 't1', mode: 'plan', systemBase: 'B' });
    expect(r.providers).toEqual([{ id: 'ok', tokens: 100 }]);
    errSpy.mockRestore();
  });

  it('latestUserMessage 传递给 provider', async () => {
    let received: unknown;
    const p: ContextProvider = {
      id: 'spy', priority: 1,
      provide: async (ctx) => { received = ctx.latestUserMessage; return null; },
    };
    const a = new ContextAssembler([p], 100);
    await a.assemble({ threadId: 't1', mode: 'edit', systemBase: 'B', latestUserMessage: '帮我改配置' });
    expect(received).toBe('帮我改配置');
  });

  it('无 provider 时仅返回 base', async () => {
    const a = new ContextAssembler([], 100);
    const r = await a.assemble({ threadId: 't1', mode: 'edit', systemBase: 'BASE' });
    expect(r.system).toBe('BASE');
    expect(r.totalTokens).toBe(0);
  });
});

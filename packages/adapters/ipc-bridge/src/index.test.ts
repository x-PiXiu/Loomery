// MainCallInvoker 超时防线测试（11-17 基准集揪出的挂死：桥未注册时 pending 永不归还 → assemble 永久挂起）
import { describe, expect, it, vi } from 'vitest';

const ipcOn = vi.hoisted(() => ({}) as Record<string, (...args: unknown[]) => void>);
vi.mock('electron', () => ({
  ipcMain: {
    on: (ch: string, fn: (...args: unknown[]) => void) => { ipcOn[ch] = fn; },
    handle: () => undefined,
  },
}));

import { CHANNELS, MainCallInvoker, RENDERER_CALL_TIMEOUT_MS } from './index';

function makeTarget() {
  const sent: Array<{ id: string; channel: string; payload: unknown }> = [];
  return {
    sent,
    target: {
      isDestroyed: () => false,
      send: (ch: string, env: { id: string; channel: string; payload: unknown }) => {
        sent.push({ id: env.id, channel: env.channel, payload: env.payload });
      },
    } as never,
  };
}

describe('MainCallInvoker（main→渲染调用）', () => {
  it('超时拒绝：无回执时到点 reject，迟到回执被忽略（不抛不改结果）', async () => {
    vi.useFakeTimers();
    try {
      const { sent, target } = makeTarget();
      const invoker = new MainCallInvoker(() => target);
      const p = invoker.call('editor.getState', { x: 1 });
      const assertion = expect(p).rejects.toThrow(/渲染层响应超时/);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(RENDERER_CALL_TIMEOUT_MS + 1);
      await assertion;
      // 迟到回执：pending 已删 → 静默忽略（模拟渲染层晚于超时才响应）
      expect(() => ipcOn[CHANNELS.rpcMainReply]!(null, { id: sent[0]!.id, result: { ok: true } })).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('正常回执 resolve，且超时定时器被清除', async () => {
    vi.useFakeTimers();
    try {
      const { sent, target } = makeTarget();
      const invoker = new MainCallInvoker(() => target);
      const p = invoker.call('editor.getState');
      ipcOn[CHANNELS.rpcMainReply]!(null, { id: sent[0]!.id, result: 42 });
      await expect(p).resolves.toBe(42);
      // 定时器已清：再推进时间不会产生未处理拒绝
      await vi.advanceTimersByTimeAsync(RENDERER_CALL_TIMEOUT_MS * 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('渲染层回 __error 时 reject 错误消息', async () => {
    const { sent, target } = makeTarget();
    const invoker = new MainCallInvoker(() => target);
    const p = invoker.call('editor.getState');
    ipcOn[CHANNELS.rpcMainReply]!(null, { id: sent[0]!.id, result: { __error: 'boom' } });
    await expect(p).rejects.toThrow('boom');
  });

  it('目标不可用立即 reject（不进 pending）', async () => {
    const invoker = new MainCallInvoker(() => undefined);
    await expect(invoker.call('editor.getState')).rejects.toThrow('渲染层不可用');
  });
});

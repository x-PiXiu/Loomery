// 全局并发闸测试（#8）：上限钳制 / FIFO 公平 / abort 感知出队 / 释放链
import { describe, expect, it } from 'vitest';
import { Semaphore } from './semaphore';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('Semaphore（全局模型并发闸）', () => {
  it('limit 内立即获取，超出排队等待', async () => {
    const gate = new Semaphore(2);
    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    expect(gate.load).toBe(2);
    let acquired = false;
    void gate.acquire().then((r) => { acquired = true; r(); });
    await tick();
    expect(acquired).toBe(false); // 第 3 个在排队
    expect(gate.load).toBe(3);
    r1();
    await tick();
    expect(acquired).toBe(true); // 释放后唤醒
    r2();
  });

  it('并发在途数永不超过 limit', async () => {
    const gate = new Semaphore(3);
    let inFlight = 0;
    let peak = 0;
    const run = async (): Promise<void> => {
      const release = await gate.acquire();
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
      release();
    };
    await Promise.all(Array.from({ length: 12 }, run));
    expect(peak).toBe(3);
    expect(gate.load).toBe(0);
  });

  it('排队中被 abort：立即以 AbortError 出队，不占名额', async () => {
    const gate = new Semaphore(1);
    const release = await gate.acquire();
    const ctrl = new AbortController();
    const queued = gate.acquire(ctrl.signal);
    await tick();
    expect(gate.load).toBe(2);
    ctrl.abort();
    await expect(queued).rejects.toThrow();
    expect(gate.load).toBe(1); // 出队后不再计入
    release();
    expect(gate.load).toBe(0);
  });

  it('acquire 前已 abort：直接拒绝', async () => {
    const gate = new Semaphore(1);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(gate.acquire(ctrl.signal)).rejects.toThrow();
  });

  it('FIFO 公平：先排队者先获得释放的名额', async () => {
    const gate = new Semaphore(1);
    const order: number[] = [];
    const r1 = await gate.acquire();
    const p2 = gate.acquire().then((r) => { order.push(2); return r; });
    const p3 = gate.acquire().then((r) => { order.push(3); return r; });
    await tick();
    r1();
    const rel2 = await p2; // 名额先给先排队的 2
    expect(order).toEqual([2]);
    rel2();
    await p3;
    expect(order).toEqual([2, 3]);
  });
});

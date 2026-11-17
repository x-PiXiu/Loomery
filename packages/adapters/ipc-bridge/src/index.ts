// ipc-bridge main 侧：RPC Server + 事件转发 + 审批桥 + 主→渲染调用器 + 环境事件枢纽
import { ipcMain, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { CHANNELS, isRpcEnvelope, type RpcEnvelope } from './envelope';
import type { ApprovalDecision, ApprovalRequester, ApprovalSpec, EventSink } from '@loomery/ports';
import type { LoopEvent } from '@loomery/domain';

export { CHANNELS, RPC, MAX_MESSAGE_BYTES, isRpcEnvelope, type RpcEnvelope } from './envelope';

export type RpcHandler = (payload: unknown) => unknown | Promise<unknown>;

export class RpcServer {
  private readonly handlers = new Map<string, RpcHandler>();

  handle(channel: string, handler: RpcHandler): this {
    this.handlers.set(channel, handler);
    return this;
  }

  attach(): void {
    ipcMain.handle(CHANNELS.rpc, async (_event, raw: unknown) => {
      if (!isRpcEnvelope(raw)) throw new Error('非法 RPC 信封');
      const handler = this.handlers.get(raw.channel);
      if (!handler) throw new Error(`未知频道: ${raw.channel}`);
      return await handler(raw.payload);
    });
  }
}

/** main→渲染调用超时（与测试共用同一常量）：桥未注册（启动竞态/F5 重载窗口）时消息无人接收 */
export const RENDERER_CALL_TIMEOUT_MS = 10_000;

/** 主进程 → 渲染层的方法调用（EditorGateway 端口的传输载体） */
export class MainCallInvoker {
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private readonly getTarget: () => WebContents | undefined) {
    ipcMain.on(CHANNELS.rpcMainReply, (_event, reply: { id: string; result: unknown }) => {
      const p = this.pending.get(reply.id);
      if (!p) return;
      this.pending.delete(reply.id);
      const r = reply.result as { __error?: string } | null | undefined;
      if (r && typeof r === 'object' && '__error' in r) p.reject(new Error(r.__error));
      else p.resolve(reply.result);
    });
  }

  call<T>(channel: string, payload?: unknown): Promise<T> {
    const target = this.getTarget();
    if (!target || target.isDestroyed()) return Promise.reject(new Error('渲染层不可用'));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      // 超时防线（11-17 基准集揪出）：桥未注册时 pending 永不归还 → assemble 的 provider
      // await 永久挂起、任务卡 busy（实证 240s 零事件）。超时拒绝让 safeProvide 捕获后
      // 降级（编辑器上下文缺省），迟到回执因 pending 已删被静默忽略。
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`渲染层响应超时: ${channel}`));
      }, RENDERER_CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      target.send(CHANNELS.rpcMain, { v: 1, id, channel, payload } satisfies RpcEnvelope);
    });
  }
}

/** LoopEvent → 渲染层（EventSink 实现；扇出下游之一） */
export class EventForwarder implements EventSink {
  constructor(private readonly getTargets: () => WebContents[]) {}

  publish(event: LoopEvent): void {
    for (const target of this.getTargets()) {
      if (target.isDestroyed()) continue;
      try {
        target.send(CHANNELS.loopEvent, event);
      } catch {
        // 渲染帧已销毁（reload/崩溃）：跳过，主流程不中断
      }
    }
  }
}

export interface EnvEvent {
  type: string;
  payload: unknown;
}

/** 渲染层环境事件（04 §2 流向 B）的接收与分发；事件体为 domain EnvironmentEvent */
export class EnvHub {
  private readonly listeners = new Set<(event: EnvEvent) => void>();

  attach(): void {
    ipcMain.on(CHANNELS.envEvent, (_event, ev: unknown) => {
      if (typeof ev !== 'object' || ev === null || typeof (ev as { type?: unknown }).type !== 'string') return;
      const e = ev as EnvEvent;
      for (const l of this.listeners) l(e);
    });
  }

  subscribe(listener: (event: EnvEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** ApprovalRequester 实现：审批卡在渲染层，决策经 RPC 回传；挂起不限时（07 §1.3） */
export class ApprovalBridge implements ApprovalRequester {
  private readonly pending = new Map<string, (d: ApprovalDecision) => void>();

  request(spec: ApprovalSpec, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const settle = (d: ApprovalDecision): void => {
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(spec.approvalId);
        resolve(d);
      };
      const onAbort = (): void => settle({ kind: 'rejected', message: '已取消' });
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(spec.approvalId, settle);
    });
  }

  resolve(approvalId: string, decision: ApprovalDecision): boolean {
    const settle = this.pending.get(approvalId);
    if (!settle) return false;
    settle(decision);
    return true;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** 应用退出/线程关闭：所有未决审批按拒绝收尾（04 §1.3 expired 语义） */
  expireAll(reason = '会话关闭，审批过期'): number {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.resolve(id, { kind: 'rejected', message: reason });
    return ids.length;
  }
}

// ipc-bridge 渲染层侧：类型化桥接访问器
import type { EnvironmentEvent, LoopEvent } from '@loomery/domain';

export interface LoomeryBridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  onLoopEvent(cb: (event: LoopEvent) => void): () => void;
  onWorkspaceEvent(cb: (event: { type: string; paths: string[] }) => void): () => void;
  /** 12 §F2.2 终端数据流（高频；xterm 自带缓冲） */
  onTerminalData(cb: (payload: { id: string; chunk: string }) => void): () => void;
  onTerminalExit(cb: (payload: { id: string; exitCode: number }) => void): () => void;
  sendEnvEvent(event: EnvironmentEvent): void;
  /** 配置变更广播（双窗口一致性）：另一窗口保存配置后本窗口同步刷新 */
  onConfigChanged(cb: (config: unknown) => void): () => void;
  onMainCall(handler: (channel: string, payload: unknown) => Promise<unknown>): void;
}

declare global {
  interface Window {
    loomery?: LoomeryBridge;
  }
}

export function bridge(): LoomeryBridge {
  const b = window.loomery;
  if (!b) throw new Error('preload 未注入——渲染层必须经 Electron 窗口加载');
  return b;
}

export class RpcClient {
  async call<T>(channel: string, payload?: unknown): Promise<T> {
    return (await bridge().invoke(channel, payload)) as T;
  }
}

export const rpc = new RpcClient();

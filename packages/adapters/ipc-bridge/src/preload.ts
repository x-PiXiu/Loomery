// 预加载脚本（sandbox: true 下仅 contextBridge/ipcRenderer 可用）；打包为 CJS
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from './envelope';

contextBridge.exposeInMainWorld('loomery', {
  invoke: async (channel: string, payload: unknown): Promise<unknown> =>
    ipcRenderer.invoke(CHANNELS.rpc, { v: 1, id: crypto.randomUUID(), channel, payload }),
  onWorkspaceEvent: (cb: (event: unknown) => void): (() => void) => {
    const listener = (_e: unknown, event: unknown): void => cb(event);
    ipcRenderer.on(CHANNELS.workspaceEvent, listener);
    return () => ipcRenderer.removeListener(CHANNELS.workspaceEvent, listener);
  },
  // 12 §F2.2 终端数据流（高频；渲染层 xterm 自带缓冲）
  onTerminalData: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_e: unknown, payload: unknown): void => cb(payload);
    ipcRenderer.on(CHANNELS.terminalData, listener);
    return () => ipcRenderer.removeListener(CHANNELS.terminalData, listener);
  },
  onTerminalExit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_e: unknown, payload: unknown): void => cb(payload);
    ipcRenderer.on(CHANNELS.terminalExit, listener);
    return () => ipcRenderer.removeListener(CHANNELS.terminalExit, listener);
  },
  onConfigChanged: (cb: (config: unknown) => void): (() => void) => {
    const listener = (_e: unknown, config: unknown): void => cb(config);
    ipcRenderer.on(CHANNELS.configChanged, listener);
    return () => ipcRenderer.removeListener(CHANNELS.configChanged, listener);
  },
  onLoopEvent: (cb: (event: unknown) => void): (() => void) => {
    const listener = (_e: unknown, event: unknown): void => cb(event);
    ipcRenderer.on(CHANNELS.loopEvent, listener);
    return () => ipcRenderer.removeListener(CHANNELS.loopEvent, listener);
  },
  sendEnvEvent: (event: unknown): void => {
    ipcRenderer.send(CHANNELS.envEvent, event);
  },
  onMainCall: (handler: (channel: string, payload: unknown) => Promise<unknown>): void => {
    ipcRenderer.on(CHANNELS.rpcMain, async (_e, env: { id: string; channel: string; payload?: unknown }) => {
      let result: unknown;
      try {
        result = await handler(env.channel, env.payload);
      } catch (err) {
        result = { __error: String(err instanceof Error ? err.message : err) };
      }
      ipcRenderer.send(CHANNELS.rpcMainReply, { id: env.id, result });
    });
  },
});

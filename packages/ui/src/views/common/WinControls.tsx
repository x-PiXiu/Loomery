// 窗口控制（— □ ✕）：frameless 窗口的真实控制，出现在右列顶部（跟随互换）
import type { ReactElement } from 'react';
import { Minus, Square, X } from 'lucide-react';
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';
import { rpc } from '@loomery/adapter-ipc-bridge/renderer';

export function WinControls(): ReactElement {
  return (
    <span className="win-controls">
      <button className="win-btn" title="最小化窗口" onClick={() => void rpc.call(RPC.windowControl, { action: 'minimize' })}><Minus size={13} /></button>
      <button className="win-btn" title="最大化/还原窗口" onClick={() => void rpc.call(RPC.windowControl, { action: 'toggleMaximize' })}><Square size={11} /></button>
      <button className="win-btn close" title="关闭窗口" onClick={() => void rpc.call(RPC.windowControl, { action: 'close' })}><X size={13} /></button>
    </span>
  );
}

// 数据目录面板（ADR 便携化）：谦卑视图，RPC 读写
import { useState, type ReactElement } from 'react';
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';
import { rpc } from '@loomery/adapter-ipc-bridge/renderer';

export function DataDirCard(): ReactElement {
  const [info, setInfo] = useState<{ current: string; defaultDir: string; redirect: string | null } | null>(null);
  const [note, setNote] = useState('');
  const load = (): void => { void rpc.call<typeof info>(RPC.userDataGet, {}).then((r) => setInfo(r)); };
  if (!info) { load(); }
  const change = async (): Promise<void> => {
    const pick = await rpc.call<{ canceled: boolean; dir?: string }>(RPC.userDataChoose, {});
    if (pick.canceled || !pick.dir) return;
    const res = await rpc.call<{ ok: boolean; copied: number; note: string; target: string }>(RPC.userDataSet, { dir: pick.dir });
    setNote(`已迁移 ${res.copied} 项到 ${res.target} —— ${res.note}`);
    load();
  };
  return (
    <div className="settings-pane">
      <div className="settings-pane-title">数据目录</div>
      <div className="datadir-rows">
        <div className="datadir-row">
          <span className="k">当前</span>
          <span className="v">{info?.current ?? '…'}</span>
        </div>
        <div className="datadir-row">
          <span className="k">默认</span>
          <span className="v">{info?.defaultDir ?? '…'}（随程序所在盘，不进 C 盘 AppData）</span>
        </div>
        {info?.redirect ? (
          <div className="datadir-row">
            <span className="k">方式</span>
            <span className="v">自定义目录（默认位置留有指路条）</span>
          </div>
        ) : null}
      </div>
      <button className="mode-btn" onClick={() => void change()}>更改数据目录…（自动迁移现有数据）</button>
      {note ? <div className="notice">{note} —— 请重启应用。</div> : null}
    </div>
  );
}

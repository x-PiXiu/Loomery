// V2.2 主窗口：三列比例化布局（拖宽联动缩放）+ 中右互换 + 标签页弹出
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ArrowLeftRight, X } from "lucide-react";
import { bridge, rpc } from '@loomery/adapter-ipc-bridge/renderer';
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';
import type { AppConfig } from '@loomery/domain';
import { runtime } from '../stores/runtime';
import { mountEditorBridge, notifyFileChanges } from '../gateway/mount';
import { Sidebar } from '../views/sidebar/Sidebar';
import { ChatPanel } from '../views/chat/Composer';
import { EditorArea } from '../views/editor/EditorArea';
import { EventTimeline } from '../views/debug/EventTimeline';
import { SettingsPage } from '../views/settings/SettingsView';

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

interface Fracs { left: number; mid: number }

function loadFracs(): Fracs {
  const l = Number(localStorage.getItem('loomery.frac.left'));
  const m = Number(localStorage.getItem('loomery.frac.mid'));
  return {
    left: Number.isFinite(l) && l > 0.05 ? l : 0.21,
    mid: Number.isFinite(m) && m > 0.05 ? m : 0.42,
  };
}

function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactElement }): ReactElement {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay-card" onClick={(e) => e.stopPropagation()}>
        <div className="overlay-head">
          <span>{title}</span>
          <button className="icon-btn" onClick={onClose}><X size={15} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function App(): ReactElement {
  const mainRef = useRef<HTMLDivElement | null>(null);
  const [fracs, setFracs] = useState<Fracs>(loadFracs);
  const [swapped, setSwapped] = useState(() => localStorage.getItem('loomery.swap') === '1');
  // 焦点模式（编辑器占满）只在本次会话有效：重启一律回到默认主窗口三列形态
  const [focusRight, setFocusRight] = useState(() => {
    const stale = localStorage.getItem('loomery.focusRight') === '1';
    if (stale) {
      localStorage.setItem('loomery.focusRight', '0');
      console.log('[drag-log][focus-reset] cleared stale focusRight at boot');
    }
    return false;
  });
  // 编辑区显隐（聊天头部开关）：隐藏 = 聊天占满（与"编辑器占满"focusRight 正交）
  const [editorVisible, setEditorVisible] = useState(() => localStorage.getItem('loomery.editorVisible') !== '0');
  // 侧栏收起：持久化偏好；收起时左栏列宽动画归零但保持挂载（保留侧栏内部状态），三件套移驻聊天头栏
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('loomery.sidebarCollapsed') === '1');
  const toggleSidebar = (): void => setSidebarCollapsed((v) => {
    localStorage.setItem('loomery.sidebarCollapsed', v ? '0' : '1');
    return !v;
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  // onboarding 完成写回：configSave patch + 本窗口 runtime 即时同步（双窗口广播会兜底另一窗）
  const finishOnboarding = (openSettings: boolean): void => {
    const cfg = runtime.getState().config;
    void rpc.call(RPC.configSave, { onboardingDone: true });
    if (cfg) runtime.set({ config: { ...cfg, onboardingDone: true } });
    if (openSettings) {
      settingsSectionRef.current = 'models';
      setSettingsOpen(true);
    }
  };
  const settingsSectionRef = useRef<string>('models');
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const dragRef = useRef<'left' | 'mid' | null>(null);

  useEffect(() => {
    mountEditorBridge();
    // 事件泵：LoopEvent → 视图模型（唯一入口）
    const off = bridge().onLoopEvent((ev) => {
      runtime.applyEvent(ev);
      if (ev.type === 'toolExecuted') notifyFileChanges(ev.payload.affectedPaths);
      else if (ev.type === 'checkpointRestored') notifyFileChanges(ev.payload.restoredFiles);
    });
    // 2026-11-14 双窗口一致性：另一窗口保存配置 → 本窗口 runtime 同步（configGet 初载之外的活更新）
    const offCfg = bridge().onConfigChanged((cfg) => {
      runtime.set({ config: cfg as AppConfig });
    });
    // #7 外部文件变更：watcher 推送 → 横幅数据源
    const offWs = bridge().onWorkspaceEvent((ev) => {
      if (ev.type === 'file-externally-changed') runtime.noteExternalChanges(ev.paths);
    });
    void rpc
      .call<AppConfig>(RPC.configGet)
      .then((cfg) => runtime.set({ config: cfg }))
      .catch(() => undefined);
    const onOpenSettings = (ev?: Event): void => { settingsSectionRef.current = (ev as CustomEvent | undefined)?.detail ?? 'models'; setSettingsOpen(true); };
    const onOpenHelp = (): void => setHelpOpen(true);
    const onOpenTimeline = (): void => setTimelineOpen(true);
    // focusRight（编辑器占满）：编辑器列旧按钮翻转；重启自动复位（上方 state）
    const onFocusRight = (): void => setFocusRight((v) => !v);
    // 编辑区显隐（聊天头部开关）：detail.visible 指定目标值（函数式 set 避免 effect 闭包 stale）
    const onToggleEditor = (ev?: Event): void => {
      const visible = (ev as CustomEvent<{ visible?: boolean }> | undefined)?.detail?.visible;
      setEditorVisible((v) => {
        const next = visible ?? !v;
        localStorage.setItem('loomery.editorVisible', next ? '1' : '0');
        return next;
      });
    };
    window.addEventListener('loomery:open-settings', onOpenSettings);
    window.addEventListener('loomery:open-help', onOpenHelp);
    window.addEventListener('loomery:open-timeline', onOpenTimeline);
    window.addEventListener('loomery:focus-right', onFocusRight);
    window.addEventListener('loomery:toggle-editor', onToggleEditor);
    // 编辑区隐藏时点文件：editorBus 挂 pending + 发 show-editor → 自动显示编辑区（挂载后 takePendingOpen 打开该文件）
    const onShowEditor = (): void => setEditorVisible(true);
    window.addEventListener('loomery:show-editor', onShowEditor);
    return () => {
      off();
      offWs();
      offCfg();
      window.removeEventListener('loomery:open-settings', onOpenSettings);
      window.removeEventListener('loomery:open-help', onOpenHelp);
      window.removeEventListener('loomery:open-timeline', onOpenTimeline);
      window.removeEventListener('loomery:focus-right', onFocusRight);
      window.removeEventListener('loomery:toggle-editor', onToggleEditor);
      window.removeEventListener('loomery:show-editor', onShowEditor);
    };
  }, []);

  // 分隔条：两个比例都按"整窗宽度"计，拖动与渲染同一口径——放大后可缩小（双向联动）
  const startDrag = (kind: 'left' | 'mid') => (e: React.MouseEvent): void => {
    e.preventDefault();
    dragRef.current = kind;
    document.body.classList.add('dragging');
    const onMove = (me: MouseEvent): void => {
      const rect = mainRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const px = me.clientX - rect.left;
      setFracs((f) => {
        let left = f.left;
        let mid = f.mid;
        if (dragRef.current === 'left') {
          left = clamp(px / rect.width, 0.13, 0.32);
          if (left + mid > 0.85) mid = 0.85 - left;
        } else {
          mid = clamp(px / rect.width - f.left, 0.18, 0.7);
          if (left + mid > 0.85) mid = 0.85 - left;
        }
        const next = { left, mid };
        localStorage.setItem('loomery.frac.left', String(next.left));
        localStorage.setItem('loomery.frac.mid', String(next.mid));
        return next;
      });
    };
    const onUp = (): void => {
      dragRef.current = null;
      document.body.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const swap = (): void => {
    setSwapped((v) => {
      localStorage.setItem('loomery.swap', v ? '0' : '1');
      return !v;
    });
  };
  // 分界线互换钮：编辑器未开时单纯换位无可见变化——顺带打开空编辑器给出反馈
  const swapFromHandle = (): void => {
    swap();
  };

  const chat = <ChatPanel sidebarCollapsed={sidebarCollapsed && !focusRight} onToggleSidebar={toggleSidebar} />;
  const editor = <EditorArea />;
  const middle = swapped ? editor : chat;
  const right = swapped ? chat : editor;


  return (
    <div className="loomery-root">
      <div className={`loomery-main${editorVisible ? '' : ' editor-hidden'}`} ref={mainRef}>
        {!focusRight ? (
          <>
            <div className={`col sidebar-col${sidebarCollapsed ? ' collapsed' : ''}`} style={{ width: `${(fracs.left * 100).toFixed(2)}%`, flexShrink: 0 }}>
              <Sidebar onToggleSidebar={toggleSidebar} />
            </div>
            {/* 两列模式（未开编辑器）同样保留分隔条：拖拽调宽 + 视觉分界（P2 反馈） */}
            <div
              className={`splitter${sidebarCollapsed ? ' collapsed' : ''}`}
              onMouseDown={startDrag('left')}
              onDoubleClick={() => { setFracs({ left: 0.21, mid: 0.42 }); localStorage.setItem('loomery.frac.left', '0.21'); localStorage.setItem('loomery.frac.mid', '0.42'); }}
              title="拖拽调宽 · 双击复位"
            />
          </>
        ) : null}
        {!focusRight ? (
          <>
            {/* 编辑区显隐 = 隐藏"含编辑器的那一列"（swap 感知），聊天在原地填充；display:none 保挂载（标签/状态不丢） */}
            <div
              className="col"
              style={!editorVisible && swapped ? { display: 'none' } : !editorVisible ? { flex: 1, minWidth: 0 } : { width: `${(fracs.mid * 100).toFixed(2)}%`, flexShrink: 0 }}
            >
              {middle}
            </div>
            {editorVisible ? (
              <div className="splitter" onMouseDown={startDrag('mid')} onDoubleClick={() => { setFracs((f) => ({ ...f, mid: 0.42 })); localStorage.setItem('loomery.frac.mid', '0.42'); }} title="拖拽调宽 · 双击复位">
                {/* 互换钮：骑在聊天/编辑器分界线中点（原状态栏入口迁此） */}
                <button
                  className="swap-handle"
                  title="对话 ⇄ 编辑器互换位置"
                  onMouseDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onClick={swapFromHandle}
                >
                  <ArrowLeftRight size={11} />
                </button>
              </div>
            ) : null}
            <div className="col col-grow" style={!editorVisible && !swapped ? { display: 'none' } : undefined}>{right}</div>
          </>
        ) : (
          <div className="col col-grow">{right}</div>
        )}
      </div>
      {settingsOpen ? <SettingsPage onClose={() => setSettingsOpen(false)} initialSection={settingsSectionRef.current} /> : null}
      {helpOpen ? (
        <Overlay title="帮助 · 快捷键" onClose={() => setHelpOpen(false)}>
          <div className="help-list">
            <div><kbd>Ctrl+N</kbd> 新建项目</div>
            <div><kbd>Ctrl+S</kbd> 保存当前文件</div>
            <div><kbd>Enter</kbd> 发送 · <kbd>Shift+Enter</kbd> 换行</div>
            <div><kbd>Ctrl+Enter</kbd> 接受审批 · <kbd>Esc</kbd> 拒绝/关闭</div>
            <div><kbd>⇄</kbd> 对话与编辑器互换位置（右上角按钮）</div>
            <div className="notice">模型与密钥在「设置」中配置；写操作默认需要审批。</div>
          </div>
        </Overlay>
      ) : null}
      {runtime.getState().config && runtime.getState().config!.onboardingDone !== true ? (
        <Overlay title="欢迎使用 Loomery" onClose={() => finishOnboarding(false)}>
          <div>
            <div className="help-list">
              <div><b>1 · 配模型</b>　左下角模型菜单选模型，或「打开模型设置」填 Base URL / API Key（每个供应商独立一把）</div>
              <div><b>2 · 建项目</b>　侧栏「新建项目」选文件夹——agent 只在该目录内读写（领土护栏）</div>
              <div><b>3 · 发任务</b>　聊天框直接下需求：文件修改 / 终端命令 / 浏览器验证全程可视，审批卡随时可拦</div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => finishOnboarding(true)}>打开模型设置</button>
              <button className="btn primary" onClick={() => finishOnboarding(false)}>开始使用</button>
            </div>
          </div>
        </Overlay>
      ) : null}

      {timelineOpen ? (
        <Overlay title="事件时间线" onClose={() => setTimelineOpen(false)}>
          <EventTimeline />
        </Overlay>
      ) : null}
    </div>
  );
}

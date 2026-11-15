// 渲染崩溃自愈：React 树内错误 → 显示崩溃屏（重载按钮）而非整页黑屏
// 边界原则：只包最外层（驱动层职责）；错误详情走 console.error → 主进程日志通道
import { Component, type ErrorInfo, type ReactNode, type ReactElement } from 'react';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui-crash]', error.message, (info.componentStack ?? '').slice(0, 400));
  }

  render(): ReactElement {
    if (this.state.error) {
      return (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 200, background: 'var(--bg-panel, #16181d)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14,
            color: 'var(--text, #e6e6e6)', fontFamily: 'inherit',
          }}
        >
          <b style={{ fontSize: 16 }}>界面遇到问题</b>
          <span style={{ fontSize: 12.5, color: 'var(--text-dim, #999)', maxWidth: 520, wordBreak: 'break-all', textAlign: 'center' }}>
            {this.state.error.message.slice(0, 200)}
          </span>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={() => { this.setState({ error: null }); location.reload(); }}
              style={{ padding: '7px 20px', borderRadius: 7, border: 0, background: 'var(--accent, #4f8cff)', color: '#fff', cursor: 'pointer' }}
            >
              重载应用
            </button>
            <button
              onClick={() => this.setState({ error: null })}
              style={{ padding: '7px 20px', borderRadius: 7, border: '1px solid var(--border, #333)', background: 'transparent', color: 'var(--text, #e6e6e6)', cursor: 'pointer' }}
            >
              尝试恢复
            </button>
          </div>
        </div>
      );
    }
    return this.props.children as ReactElement;
  }
}

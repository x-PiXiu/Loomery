import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { ErrorBoundary } from './app/ErrorBoundary';
import { PopoutViewer } from './views/popout/PopoutViewer';
import { mountEditorBridge } from './gateway/mount';
import './monaco-setup';
import './theme.css';

// 主题：仅深色 / 浅色两套（用户定稿），启动时应用持久化选择
document.documentElement.dataset.theme = localStorage.getItem('loomery.theme') ?? 'dark';

// 弹出窗口路由：#popout?file=... → 独立查看/编辑器（ADR-0018）
if (window.location.hash.startsWith('#popout')) {
  const params = new URLSearchParams(window.location.hash.slice('#popout?'.length));
  const file = params.get('file') ?? '';
  const rootEl = document.getElementById('root');
  if (rootEl && file) createRoot(rootEl).render(<ErrorBoundary><PopoutViewer file={file} /></ErrorBoundary>);
} else {
  mountEditorBridge();
  const rootEl = document.getElementById('root');
  if (rootEl) createRoot(rootEl).render(<ErrorBoundary><App /></ErrorBoundary>);
}

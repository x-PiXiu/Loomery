// 弹出窗口：单文件查看/编辑（文本可编辑+Ctrl+S；图片只读预览）
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { monaco } from '../../monaco-setup';
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';
import { rpc } from '@loomery/adapter-ipc-bridge/renderer';
import './popout.css';

function langOf(path: string): string {
  const ext = path.split('.').pop() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', py: 'python', go: 'go', rs: 'rust',
    css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml',
  };
  return map[ext] ?? 'plaintext';
}

export function PopoutViewer({ file }: { file: string }): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<{ kind: 'loading' | 'text' | 'image' | 'error'; content?: string; mime?: string; dirty?: boolean; error?: string }>({ kind: 'loading' });

  useEffect(() => {
    let disposed = false;
    let editor: monaco.editor.IStandaloneCodeEditor | null = null;
    let model: monaco.editor.ITextModel | null = null;

    void (async () => {
      try {
        const res = await rpc.call<{ content?: string; binary?: boolean; image?: string; mime?: string }>(RPC.fsReadFile, { path: file });
        if (disposed) return;
        if (res.image) {
          setState({ kind: 'image', content: res.image, mime: res.mime });
          return;
        }
        setState({ kind: 'text', content: res.binary ? '// [二进制文件]' : (res.content ?? ''), dirty: false });
        const ed = monaco.editor.create(hostRef.current ?? document.body, {
          theme: document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark',
          automaticLayout: true,
          fontSize: 14,
      lineHeight: 1.6,
          minimap: { enabled: false },
          fontFamily: 'Cascadia Mono, Consolas, monospace',
          value: res.binary ? '// [二进制文件]' : (res.content ?? ''),
          language: langOf(file),
        });
        editor = ed;
        model = ed.getModel();
        ed.onDidChangeModelContent(() => setState((s) => ({ ...s, dirty: true })));
        ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          if (!model) return;
          void rpc
            .call(RPC.fsWriteFile, { path: file, content: model.getValue() })
            .then(() => setState((s) => ({ ...s, dirty: false })))
            .catch((err: unknown) => console.error('[popout] 保存失败', err));
        });
      } catch (err) {
        if (!disposed) setState({ kind: 'error', error: String(err instanceof Error ? err.message : err) });
      }
    })();

    return () => {
      disposed = true;
      editor?.dispose();
      model?.dispose();
    };
  }, [file]);

  const name = file.split(/[\\/]/).pop() ?? file;

  return (
    <div className="popout-root">
      <div className="popout-head">
        <span className="popout-name">{name}{state.dirty ? ' ●' : ''}</span>
        <span className="popout-path" title={file}>{file}</span>
      </div>
      <div className="popout-body">
        {state.kind === 'loading' ? <div className="empty-center">加载中…</div> : null}
        {state.kind === 'error' ? <div className="empty-center">加载失败：{state.error}</div> : null}
        {state.kind === 'image' ? (
          <div className="image-view"><img src={`data:${state.mime};base64,${state.content}`} alt={file} /></div>
        ) : null}
        <div ref={hostRef} className="popout-editor" style={{ display: state.kind === 'text' ? 'block' : 'none' }} />
      </div>
    </div>
  );
}

// Monaco + vite worker 装配（离线自带 worker，不依赖 CDN）
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

export { monaco };

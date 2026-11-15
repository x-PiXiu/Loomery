// 修复1：编辑器隐藏时的挂起打开队列（点文件 → 显示编辑器列 → 挂载后自动打开）
const fs = require('fs');

// ---- editorBus：pending 队列 + show-editor 事件 ----
const ebPath = 'packages/ui/src/gateway/editorBus.ts';
let eb = fs.readFileSync(ebPath, 'utf8');
if (!eb.includes('pendingPath')) {
  eb = eb.replace(
    'let diffOpener: DiffFn | null = null;',
    [
      'let diffOpener: DiffFn | null = null;',
      '',
      '// 编辑器列隐藏时的挂起打开请求（显示列 → 挂载后消费）',
      'let pendingPath: string | null = null;',
      'let pendingDiff: { path: string; original: string; modified: string } | null = null;',
      'function requestShowEditor(): void {',
      "  window.dispatchEvent(new CustomEvent('loomery:show-editor'));",
      '}',
    ].join('\n'),
  );
  eb = eb.replace(
    'export function openInEditor(path: string, line?: number): Promise<void> {\n  return opener ? opener(path, line) : Promise.resolve();\n}',
    [
      'export function openInEditor(path: string, line?: number): Promise<void> {',
      '  if (opener) return opener(path, line);',
      '  pendingPath = path;',
      "  requestShowEditor();",
      '  return Promise.resolve();',
      '}',
    ].join('\n'),
  );
  eb = eb.replace(
    'export function openInDiff(path: string, original: string, modified: string): void {\n  diffOpener?.(path, original, modified);\n}',
    [
      'export function openInDiff(path: string, original: string, modified: string): void {',
      '  if (diffOpener) { diffOpener(path, original, modified); return; }',
      '  pendingDiff = { path, original, modified };',
      "  requestShowEditor();",
      '}',
    ].join('\n'),
  );
  eb = eb.replace(
    "window.loomeryDev = { openInEditor: (path: string) => { void openInEditor(path); } };",
    [
      'window.loomeryDev = { openInEditor: (path: string) => { void openInEditor(path); } };',
      '',
      '/** 编辑器挂载后消费挂起的打开请求（App 在挂载完成后调用） */',
      'export function takePendingOpen(): { path?: string; diff?: { path: string; original: string; modified: string } } {',
      '  const out: { path?: string; diff?: { path: string; original: string; modified: string } } = {};',
      '  if (pendingPath) out.path = pendingPath;',
      '  if (pendingDiff) out.diff = pendingDiff;',
      '  pendingPath = null;',
      '  pendingDiff = null;',
      '  return out;',
      '}',
    ].join('\n'),
  );
  fs.writeFileSync(ebPath, eb);
  console.log('editorBus pending ok');
} else console.log('editorBus present');

// ---- App：forceEditorOpen 状态 + show-editor 监听 + 渲染条件 ----
const appPath = 'packages/ui/src/app/App.tsx';
let ap = fs.readFileSync(appPath, 'utf8');
if (!ap.includes('forceEditorOpen')) {
  ap = ap.replace(
    '  const [editorTabs, setEditorTabs] = useState(0);',
    '  const [editorTabs, setEditorTabs] = useState(0);\n  const [forceEditorOpen, setForceEditorOpen] = useState(false);',
  );
  ap = ap.replace(
    "    onTabsCount((n) => setEditorTabs(n));",
    "    onTabsCount((n) => { setEditorTabs(n); if (n === 0) setForceEditorOpen(false); });\n    const onShowEditor = (): void => setForceEditorOpen(true);\n    window.addEventListener('loomery:show-editor', onShowEditor);",
  );
  ap = ap.replace(
    "      window.removeEventListener('loomery:focus-right', onFocusRight);",
    "      window.removeEventListener('loomery:show-editor', onShowEditor);\n      window.removeEventListener('loomery:focus-right', onFocusRight);",
  );
  // 渲染条件：editorVisible = editorTabs>0 || forceEditorOpen
  ap = ap.split("!focusRight && editorTabs > 0 ?").join("!focusRight && (editorTabs > 0 || forceEditorOpen) ?");
  ap = ap.replace("{(focusRight || editorTabs > 0) ? right : chat}", "{(focusRight || editorTabs > 0 || forceEditorOpen) ? right : chat}");
  fs.writeFileSync(appPath, ap);
  console.log('app force open ok');
} else console.log('app present');

// ---- EditorArea：挂载后消费挂起请求 ----
const eaPath = 'packages/ui/src/views/editor/EditorArea.tsx';
let ea = fs.readFileSync(eaPath, 'utf8');
if (!ea.includes('takePendingOpen')) {
  ea = ea.replace(
    "import { insertToComposer, registerDiffOpener, registerEditorOpener } from '../../gateway/editorBus';",
    "import { insertToComposer, registerDiffOpener, registerEditorOpener, takePendingOpen } from '../../gateway/editorBus';",
  );
  const anchor = "    setFileReloadHandler((paths) => {";
  ea = ea.replace(
    anchor,
    "    // 消费挂起的打开请求（编辑器列隐藏时点击文件的场景）\n    const pend = takePendingOpen();\n    if (pend.path) void openPath(pend.path);\n    else if (pend.diff) openDiff(pend.diff.path, pend.diff.original, pend.diff.modified);\n\n" + anchor,
  );
  fs.writeFileSync(eaPath, ea);
  console.log('editorArea pending ok');
} else console.log('editorArea present');

console.log('done');

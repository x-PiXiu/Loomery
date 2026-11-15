// DiffPane 第三步：editorBus 扩散 + EditorArea diff 标签页
const fs = require('fs');
let ok = 0;

// ---- editorBus ----
const ebPath = 'packages/ui/src/gateway/editorBus.ts';
let eb = fs.readFileSync(ebPath, 'utf8');
if (!eb.includes('registerDiffOpener')) {
  eb += [
    '',
    '// DiffPane：注册 diff 打开器（EditorArea 实现），供审批卡/汇总卡跳转',
    'type DiffFn = (path: string, original: string, modified: string) => void;',
    'let diffOpener: DiffFn | null = null;',
    'export function registerDiffOpener(fn: DiffFn): void {',
    '  diffOpener = fn;',
    '}',
    'export function openInDiff(path: string, original: string, modified: string): void {',
    '  diffOpener?.(path, original, modified);',
    '}',
    '',
    '/** 读取 diff 原始侧内容：优先 checkpoint 快照（写盘后仍可对照），回退当前文件 */',
    'export async function resolveOriginalContent(turnId: string | undefined, path: string): Promise<string | null> {',
    '  if (turnId) {',
    '    try {',
    "      const snap = await import('@loomery/adapter-ipc-bridge/renderer').then((m) => m.rpc.call<string | null>(`${'checkpoint.read'}` === '' ? '' : 'checkpoint.read', { turnId, path }));",
    '      if (typeof snap === \'string\') return snap;',
    '    } catch { /* 快照不存在则回退当前文件 */ }',
    '  }',
    '  try {',
    "    const res = await import('@loomery/adapter-ipc-bridge/renderer').then((m) => m.rpc.call<{ content?: string; binary?: boolean }>('fs.readFile', { path }));",
    '    return res.binary ? null : (res.content ?? \'\');',
    '  } catch {',
    '    return null;',
    '  }',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(ebPath, eb);
  ok++;
  console.log('editorBus ok');
} else console.log('editorBus present');

// ---- EditorArea ----
const eaPath = 'packages/ui/src/views/editor/EditorArea.tsx';
let ea = fs.readFileSync(eaPath, 'utf8');

// 1) OpenEntry 扩展
ea = ea.replace(
  "interface OpenEntry {\n  path: string;\n  kind: 'text' | 'image' | 'newtab';",
  "interface OpenEntry {\n  path: string;\n  kind: 'text' | 'image' | 'newtab' | 'diff';\n  /** diff 条目元数据 */\n  diffPath?: string;\n  diffOriginal?: string;\n  diffModified?: string;",
);
// 2) import registerDiffOpener + GitCompare
ea = ea.replace(
  "import { registerEditorOpener } from '../../gateway/editorBus';",
  "import { registerDiffOpener, registerEditorOpener } from '../../gateway/editorBus';",
);
if (!ea.includes('GitCompare')) {
  ea = ea.replace("import { ExternalLink, X, ChevronsDown,", "import { GitCompare, ExternalLink, X, ChevronsDown,");
}
// 3) refs 与 openDiff
ea = ea.replace(
  "  const [tabDropOpen, setTabDropOpen] = useState(false);",
  "  const diffHostRef = useRef<HTMLDivElement | null>(null);\n  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);\n  const [tabDropOpen, setTabDropOpen] = useState(false);",
);
const openAnchor = '  const openNewTab = (): void => {';
ea = ea.replace(
  openAnchor,
  [
    '  /** 打开 diff 标签（审批卡/汇总卡跳转，ADR-0020） */',
    '  const openDiff = (realPath: string, original: string, modified: string): void => {',
    '    const key = `diff:${realPath}`;',
    '    setEntries((prev) => {',
    '      if (prev.some((e) => e.path === key)) return prev.filter((e) => e.path !== key);',
    '      return [...prev.filter((e) => e.path !== key), { path: key, kind: \'diff\', diffPath: realPath, diffOriginal: original, diffModified: modified }];',
    '    });',
    '    activeRef.current = key;',
    '    setActive(key);',
    '  };',
    '',
    openAnchor,
  ].join('\n'),
);
// 4) 注册 opener（registerEditorOpener 旁）
ea = ea.replace(
  '    registerEditorOpener(openPath);',
  '    registerEditorOpener(openPath);\n    registerDiffOpener(openDiff);',
);
// 5) useEffect：active 为 diff 时创建 DiffEditor
const cleanupAnchor = "    return () => {\n      window.removeEventListener('loomery:theme', onTheme);\n      ed.dispose();\n    };\n  }, []);";
ea = ea.replace(
  cleanupAnchor,
  [
    "    return () => {",
    "      window.removeEventListener('loomery:theme', onTheme);",
    "      ed.dispose();",
    "    };",
    "  }, []);",
    "",
    "  // DiffEditor 生命周期：仅当激活标签为 diff 时创建（06 §4.3 双栏对照）",
    "  useEffect(() => {",
    "    const entry = entries.find((e) => e.path === active);",
    "    if (!entry || entry.kind !== 'diff' || !diffHostRef.current) return;",
    "    const lang = langOf(entry.diffPath ?? '');",
    "    const original = monaco.editor.createModel(entry.diffOriginal ?? '', lang);",
    "    const modified = monaco.editor.createModel(entry.diffModified ?? '', lang);",
    "    const de = monaco.editor.createDiffEditor(diffHostRef.current, {",
    "      readOnly: true,",
    "      renderSideBySide: true,",
    "      automaticLayout: true,",
    "      fontSize: 14,",
    "      fontFamily: 'Cascadia Mono, Consolas, monospace',",
    "      scrollBeyondLastLine: false,",
    "      renderOverviewRuler: true,",
    "      originalEditable: false,",
    "    });",
    "    de.setModel({ original, modified });",
    "    diffEditorRef.current = de;",
    "    return () => {",
    "      de.dispose();",
    "      original.dispose();",
    "      modified.dispose();",
    "      diffEditorRef.current = null;",
    "    };",
    "  }, [active, entries]);",
  ].join('\n'),
);
// 6) tab 渲染：diff 标签 + 点击分支
ea = ea.replace(
  "onClick={() => (e.kind === 'newtab' ? setActive(NEW_TAB_PATH) : void openPath(e.path))} title={e.path}",
  "onClick={() => (e.kind === 'newtab' ? setActive(NEW_TAB_PATH) : e.kind === 'diff' ? setActive(e.path) : void openPath(e.path))} title={e.kind === 'diff' ? `Diff · ${e.diffPath}` : e.path}",
);
ea = ea.replace(
  "            {e.kind === 'newtab' ? <Plus size={12} /> : tabIcon(e.path)}\n            {e.kind === 'newtab' ? '新标签页' : e.path.split(/[\\\\/]/).pop()}",
  "            {e.kind === 'newtab' ? <Plus size={12} /> : e.kind === 'diff' ? <GitCompare size={12} /> : tabIcon(e.path)}\n            {e.kind === 'newtab' ? '新标签页' : e.kind === 'diff' ? `${(e.diffPath ?? '').split(/[\\\\/]/).pop()} · Diff` : e.path.split(/[\\\\/]/).pop()}",
);
// 7) popout 禁用 diff
ea = ea.replace(
  "disabled={!activeEntry || activeEntry.kind === 'newtab'}",
  "disabled={!activeEntry || activeEntry.kind === 'newtab' || activeEntry.kind === 'diff'}",
);
// 8) stage：diff host 渲染 + monaco host 对 diff 隐藏
ea = ea.replace(
  "        {activeEntry?.kind === 'newtab' ? <div className=\"newtab-scroll\"><NewTabPanel /></div> : null}",
  "        {activeEntry?.kind === 'newtab' ? <div className=\"newtab-scroll\"><NewTabPanel /></div> : null}\n        {activeEntry?.kind === 'diff' ? <div ref={diffHostRef} className=\"diff-host\" /> : null}",
);
ea = ea.replace(
  "style={{ display: activeEntry?.kind === 'image' || activeEntry?.kind === 'newtab' || showMdPreview ? 'none' : 'block' }}",
  "style={{ display: activeEntry?.kind === 'image' || activeEntry?.kind === 'newtab' || activeEntry?.kind === 'diff' || showMdPreview ? 'none' : 'block' }}",
);
fs.writeFileSync(eaPath, ea);
ok++;
console.log('editorArea ok');

console.log('done:', ok);

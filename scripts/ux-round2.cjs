// 本轮 UX 改动 consolidated：
// ①EditorArea：标签数通知/关闭全部事件/右键引用菜单 ②Composer 插入器注册 ③App 编辑器列显隐 ④Sidebar 文件右键引用
const fs = require('fs');
let ok = 0;

// ---------- EditorArea ----------
const eaPath = 'packages/ui/src/views/editor/EditorArea.tsx';
let ea = fs.readFileSync(eaPath, 'utf8');

if (!ea.includes('notifyTabsCount')) {
  ea = ea.replace(
    "import { setEditorHooksProvider, setFileReloadHandler } from '../../gateway/mount';",
    "import { notifyTabsCount, setEditorHooksProvider, setFileReloadHandler } from '../../gateway/mount';",
  );
  const a1 = '    setFileReloadHandler((paths) => {';
  ea = ea.replace(a1, '    useEffect(() => { notifyTabsCount(entries.length); }, [entries]);\n\n' + a1);
  ok++;
}

if (!ea.includes('loomery:close-all-tabs')) {
  const a2 = '    registerDiffOpener(openDiff);';
  ea = ea.replace(
    a2,
    a2 +
      "\n    const onCloseAllTabs = (): void => closeAllTabs();\n    window.addEventListener('loomery:close-all-tabs', onCloseAllTabs);",
  );
  ea = ea.replace(
    "    return () => {\n      window.removeEventListener('loomery:theme', onTheme);\n      ed.dispose();\n    };",
    "    return () => {\n      window.removeEventListener('loomery:theme', onTheme);\n      window.removeEventListener('loomery:close-all-tabs', onCloseAllTabs);\n      ed.dispose();\n    };",
  );
  ok++;
}

if (!ea.includes('引用到聊天框')) {
  // state
  ea = ea.replace(
    '  const [tabDropOpen, setTabDropOpen] = useState(false);',
    '  const [tabDropOpen, setTabDropOpen] = useState(false);\n  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string; selText: string; selRange: string } | null>(null);',
  );
  // 右键处理 + 禁用 monaco 原生菜单
  const a3 = '    registerDiffOpener(openDiff);';
  const inject3 = [
    '    registerDiffOpener(openDiff);',
    "    // 右键引用：选中文本 → 插入 路径:行号区间 + 内容 到聊天框（禁用 monaco 原生菜单）",
    "    ed.updateOptions({ contextmenu: false });",
    '    const hostEl = hostRef.current;',
    '    const onCtx = (e: MouseEvent): void => {',
    '      e.preventDefault();',
    '      const model = ed.getModel();',
    '      const sel = ed.getSelection();',
    "      const selText = model && sel && !sel.isEmpty() ? model.getValueInRange(sel) : '';",
    "      const selRange = model && sel && !sel.isEmpty() ? `${sel.startLineNumber}-${sel.endLineNumber}` : '';",
    "      setCtxMenu({ x: e.clientX, y: e.clientY, path: model?.uri.fsPath ?? '', selText, selRange });",
    '    };',
    "    hostEl?.addEventListener('contextmenu', onCtx);",
  ].join('\n');
  ea = ea.replace(a3, inject3);
  // 清理监听
  ea = ea.replace(
    "      window.removeEventListener('loomery:theme', onTheme);\n      ed.dispose();",
    "      window.removeEventListener('loomery:theme', onTheme);\n      hostEl?.removeEventListener('contextmenu', onCtx);\n      ed.dispose();",
  );
  // 渲染菜单（editor-stage 之前）
  const stageAnchor = '      <div className="editor-stage">';
  const menuJsx = [
    '        {ctxMenu ? (',
    '          <>',
    '            <div className="menu-backdrop" onClick={() => setCtxMenu(null)} />',
    '            <div className="dropdown ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>',
    '              <button',
    "                className={ctxMenu.selText ? '' : 'disabled'}",
    '                onClick={() => {',
    "                  const head = ctxMenu.selRange ? `${ctxMenu.path}:${ctxMenu.selRange}` : ctxMenu.path;",
    "                  insertToComposer(`\\n${head}\\n${ctxMenu.selText}\\n`);",
    '                  setCtxMenu(null);',
    '                }}',
    '              >',
    "                引用到聊天框{ctxMenu.selRange ? `（行 ${ctxMenu.selRange}）` : ''}",
    '              </button>',
    '            </div>',
    '          </>',
    '        ) : null}',
    '        <div className="editor-stage">',
  ].join('\n');
  ea = ea.replace(stageAnchor, menuJsx);
  // import insertToComposer
  ea = ea.replace(
    "import { registerDiffOpener, registerEditorOpener } from '../../gateway/editorBus';",
    "import { insertToComposer, registerDiffOpener, registerEditorOpener } from '../../gateway/editorBus';",
  );
  ok++;
}
fs.writeFileSync(eaPath, ea);

// ---------- Composer：注册插入器 ----------
const cpPath = 'packages/ui/src/views/chat/Composer.tsx';
let cp = fs.readFileSync(cpPath, 'utf8');
if (!cp.includes('registerComposerInserter')) {
  cp = cp.replace(
    "import { openInEditor } from '../../gateway/editorBus';",
    "import { insertToComposer as _unused } from '../../gateway/editorBus';\nimport { openInEditor, registerComposerInserter } from '../../gateway/editorBus';",
  );
  // 修掉别名错引：直接用注册函数；textarea 聚焦追加
  cp = cp.replace(
    "import { insertToComposer as _unused } from '../../gateway/editorBus';\nimport { openInEditor, registerComposerInserter } from '../../gateway/editorBus';",
    "import { openInEditor, registerComposerInserter } from '../../gateway/editorBus';",
  );
  const anchor = '  // 审批快捷键（06 §4.2：Ctrl+Enter 接受 / Esc 拒绝，作用于首个未决审批）';
  const inject = [
    '  // 右键"引用到聊天框"：把引用文本追加进输入区并聚焦',
    '  useEffect(() => {',
    '    registerComposerInserter((text) => {',
    '      setText((prev) => (prev.length > 0 ? prev + text : text));',
    "      taRef.current?.focus();",
    '    });',
    '  }, []);',
    '',
    anchor,
  ].join('\n');
  cp = cp.replace(anchor, inject);
  // taRef 需存在——确认 Composer 已有 taRef
  if (!cp.includes('taRef')) console.log('WARN no taRef');
  ok++;
}
fs.writeFileSync(cpPath, cp);

// ---------- App：编辑器列显隐 ----------
const appPath = 'packages/ui/src/app/App.tsx';
let ap = fs.readFileSync(appPath, 'utf8');
if (!ap.includes('editorTabs')) {
  ap = ap.replace(
    "import { mountEditorBridge, notifyFileChanges } from '../gateway/mount';",
    "import { mountEditorBridge, notifyFileChanges } from '../gateway/mount';\nimport { onTabsCount } from '../gateway/editorBus';",
  );
  ap = ap.replace(
    "  const [focusRight, setFocusRight] = useState(() => localStorage.getItem('loomery.focusRight') === '1');",
    "  const [focusRight, setFocusRight] = useState(() => localStorage.getItem('loomery.focusRight') === '1');\n  const [editorTabs, setEditorTabs] = useState(0);",
  );
  ap = ap.replace(
    "    const onOpenSettings = (): void => setSettingsOpen(true);",
    "    onTabsCount((n) => setEditorTabs(n));\n    const onOpenSettings = (): void => setSettingsOpen(true);",
  );
  // 列渲染重构：编辑器列无标签时隐藏，聊天列自动占满
  const oldMain = [
    '        {!focusRight ? <div className="splitter" onMouseDown={startDrag(\'left\')} onDoubleClick={() => { setFracs({ left: 0.21, mid: 0.42 }); localStorage.setItem(\'loomery.frac.left\', \'0.21\'); localStorage.setItem(\'loomery.frac.mid\', \'0.42\'); }} title="拖拽调宽 · 双击复位" /> : null}',
    '        <div className="col" style={midStyle}>{middle}</div>',
    "        {!focusRight ? <div className=\"splitter\" onMouseDown={startDrag('mid')} onDoubleClick={() => { setFracs((f) => ({ ...f, mid: 0.42 })); localStorage.setItem('loomery.frac.mid', '0.42'); }} title=\"拖拽调宽 · 双击复位\" /> : null}",
    '        <div className="col col-grow">{right}</div>',
  ].join('\n');
  const newMain = [
    '        {!focusRight && editorTabs > 0 ? <div className="splitter" onMouseDown={startDrag(\'left\')} onDoubleClick={() => { setFracs({ left: 0.21, mid: 0.42 }); localStorage.setItem(\'loomery.frac.left\', \'0.21\'); localStorage.setItem(\'loomery.frac.mid\', \'0.42\'); }} title="拖拽调宽 · 双击复位" /> : null}',
    '        {!focusRight && editorTabs > 0 ? <div className="col" style={{ width: `${fracs.mid * 100}%`, flexShrink: 0 }}>{middle}</div> : <div className="col col-grow">{middle}</div>}',
    "        {!focusRight && editorTabs > 0 ? <div className=\"splitter\" onMouseDown={startDrag('mid')} onDoubleClick={() => { setFracs((f) => ({ ...f, mid: 0.42 })); localStorage.setItem('loomery.frac.mid', '0.42'); }} title=\"拖拽调宽 · 双击复位\" /> : null}",
    '        <div className="col col-grow">{right}</div>',
  ].join('\n');
  if (ap.includes(oldMain)) { ap = ap.replace(oldMain, newMain); ok++; console.log('app cols ok'); } else console.log('app cols miss');
  // 左列同样随 editorTabs 隐藏？需求只说编辑器列隐藏——保留左栏。
}
fs.writeFileSync(appPath, ap);

console.log('done, steps ok =', ok);

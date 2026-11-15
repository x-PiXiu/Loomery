// 修复两处 import + App 列渲染锚点适配
const fs = require('fs');
let ok = 0;

// Composer import 补 registerComposerInserter
const cpPath = 'packages/ui/src/views/chat/Composer.tsx';
let cp = fs.readFileSync(cpPath, 'utf8');
const cpLine = "import { openInEditor, openInDiff, resolveOriginalContent } from '../../gateway/editorBus';";
if (cp.includes(cpLine) && !cp.includes('registerComposerInserter } from')) {
  cp = cp.replace(cpLine, "import { openInEditor, openInDiff, registerComposerInserter, resolveOriginalContent } from '../../gateway/editorBus';");
  fs.writeFileSync(cpPath, cp);
  ok++;
  console.log('composer import ok');
} else console.log('composer import:', cp.includes('registerComposerInserter } from') ? 'present' : 'odd');

// EditorArea: notifyTabsCount 从 editorBus 导入（当前误标 mount）
const eaPath = 'packages/ui/src/views/editor/EditorArea.tsx';
let ea = fs.readFileSync(eaPath, 'utf8');
if (ea.includes("import { notifyTabsCount, setEditorHooksProvider, setFileReloadHandler } from '../../gateway/mount';")) {
  ea = ea.replace(
    "import { notifyTabsCount, setEditorHooksProvider, setFileReloadHandler } from '../../gateway/mount';",
    "import { notifyTabsCount } from '../../gateway/editorBus';\nimport { setEditorHooksProvider, setFileReloadHandler } from '../../gateway/mount';",
  );
  fs.writeFileSync(eaPath, ea);
  ok++;
  console.log('ea import ok');
} else console.log('ea import present/odd');

// App 列渲染锚点：宽松定位三行块
const appPath = 'packages/ui/src/app/App.tsx';
let ap = fs.readFileSync(appPath, 'utf8');
const midLineRe = /        <div className="col" style=\{midStyle\}>\{middle\}<\/div>/;
if (midLineRe.test(ap) && !ap.includes('editorTabs > 0 ? <div className="splitter"')) {
  ap = ap.replace(
    midLineRe,
    '        {!focusRight && editorTabs > 0 ? <div className="splitter" onMouseDown={startDrag(\'mid\')} onDoubleClick={() => { setFracs((f) => ({ ...f, mid: 0.42 })); localStorage.setItem(\'loomery.frac.mid\', \'0.42\'); }} title="拖拽调宽 · 双击复位" /> : null}\n'
      + '        <div className="col" style={{ width: `${(fracs.mid * 100).toFixed(2)}%`, flexShrink: 0 }}>{middle}</div>',
  );
  // 原 mid splitter（在 middle 之后）删掉
  ap = ap.replace(
    /        \{!focusRight \? <div className="splitter" onMouseDown=\{startDrag\('mid'\)[\s\S]*?title="拖拽调宽 · 双击复位" \/>\} : null\}\n/,
    '',
  );
  // 左 splitter 加 editorTabs 条件
  ap = ap.replace(
    "        {!focusRight ? <div className=\"splitter\" onMouseDown={startDrag('left')} onDoubleClick={() => { setFracs({ left: 0.21, mid: 0.42 }); localStorage.setItem('loomery.frac.left', '0.21'); localStorage.setItem('loomery.frac.mid', '0.42'); }} title=\"拖拽调宽 · 双击复位\" /> : null}",
    "        {!focusRight && editorTabs > 0 ? <div className=\"splitter\" onMouseDown={startDrag('left')} onDoubleClick={() => { setFracs({ left: 0.21, mid: 0.42 }); localStorage.setItem('loomery.frac.left', '0.21'); localStorage.setItem('loomery.frac.mid', '0.42'); }} title=\"拖拽调宽 · 双击复位\" /> : null}",
  );
  fs.writeFileSync(appPath, ap);
  ok++;
  console.log('app cols ok');
} else console.log('app cols present/miss');

console.log('done ok =', ok);

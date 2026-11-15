// Sidebar：新建任务关编辑器标签 + 文件树右键引用菜单
const fs = require('fs');
const p = 'packages/ui/src/views/sidebar/Sidebar.tsx';
let s = fs.readFileSync(p, 'utf8');
let ok = 0;

// 1) createTask 派发关闭全部标签（新建任务 → 编辑器列隐藏）
if (!s.includes('loomery:close-all-tabs')) {
  const anchor = "  const createTask = async (): Promise<void> => {";
  s = s.replace(anchor, anchor + "\n    window.dispatchEvent(new CustomEvent('loomery:close-all-tabs'));");
  ok++;
  console.log('createTask close-tabs ok');
} else console.log('close-tabs present');

// 2) 文件树右键：引用到聊天框 / 在编辑器中打开
if (!s.includes('引用到聊天框')) {
  // state
  s = s.replace(
    '  const [navVersion, setNavVersion] = useState(0);',
    '  const [navVersion, setNavVersion] = useState(0);\n  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; path: string } | null>(null);',
  );
  // 树行 onContextMenu
  const rowOld = "              onClick={() => { if (!n.isDir) void openInEditor(n.path); }}\n              title={n.path}";
  const rowNew = "              onClick={() => { if (!n.isDir) void openInEditor(n.path); }}\n              onContextMenu={(e) => { if (n.isDir) return; e.preventDefault(); setFileMenu({ x: e.clientX, y: e.clientY, path: n.path }); }}\n              title={n.path}";
  if (s.includes(rowOld)) { s = s.replace(rowOld, rowNew); ok++; console.log('row ctx ok'); } else console.log('row ctx miss');
  // 菜单渲染（sidebar 根部，关闭 backdrop）
  const footAnchor = '      <div className="sidebar-foot">';
  const menuJsx = [
    '      {fileMenu ? (',
    '        <>',
    '          <div className="menu-backdrop" onClick={() => setFileMenu(null)} />',
    '          <div className="dropdown" style={{ position: \'fixed\', left: fileMenu.x, top: fileMenu.y, zIndex: 90 }}>',
    '            <button onClick={() => { insertToComposer(fileMenu.path); setFileMenu(null); }}>',
    '              引用到聊天框',
    '            </button>',
    '            <button onClick={() => { void openInEditor(fileMenu.path); setFileMenu(null); }}>',
    '              在编辑器中打开',
    '            </button>',
    '          </div>',
    '        </>',
    '      ) : null}',
    '      <div className="sidebar-foot">',
  ].join('\n');
  s = s.replace(footAnchor, menuJsx);
  // import insertToComposer
  s = s.replace(
    "import { openInEditor } from '../../gateway/editorBus';",
    "import { insertToComposer, openInEditor } from '../../gateway/editorBus';",
  );
  ok++;
  console.log('file menu ok');
} else console.log('ctx present');

fs.writeFileSync(p, s);
console.log('done ok =', ok);

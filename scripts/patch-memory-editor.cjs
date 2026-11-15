// 记忆更新：编辑器重开 bug 修复批次
const fs = require('fs');
const p = 'C:/Users/29108/.zcode/cli/memories/projects/loomery-3794f0800c2b9453/memory/loomery-agent-editor-project.md';
const entry = `
2026-11-01 **编辑器重开 bug 修复（用户报障：换位后开文件→关全部标签→再点文件打不开；探针复现闭环 PASS）**：根因=**editorBus 模块级 opener 注册后从不注销**——EditorArea 卸载（关全部标签→编辑器列卸载）后 opener 仍指向死闭包，openInEditor 走「if (opener) return opener(...)」分支调死函数（React 对已卸载组件 setState 静默无操作），**pendingPath/show-editor 分支永远不触发**。换位只是让用户撞上的巧合，任何布局关掉编辑器再点文件都会复现。修法（同类三处一起）：①editorBus 加 unregisterEditorOpener/unregisterDiffOpener/unregisterComposerInserter/unregisterComposerReplacer（按引用相等才置 null）；②EditorArea 卸载清理=注销双 opener+setEditorHooksProvider(()=>null)（网关调用回退显式「编辑器尚未就绪」）+setFileReloadHandler(() => undefined)；③ChatPanel 卸载清理=注销 inserter/replacer（focusRight 模式 ChatPanel 不挂载，死回调吞「引用到聊天框/重新编辑」）。修复后链路：点文件→opener=null→pendingPath+show-editor→forceEditorOpen→EditorArea 挂载→register+takePendingOpen。**探针 verify-editor-reopen.cjs 四步闭环**：S 换位→O1 开文件(tabs=1+editorHost)→C 关标签(全消)→O2 再点文件(reopened=true)；修前 O2 必 F。selector 坑：换位按钮在 StatusBar 不叫 swap-btn，是 .status-bar button 文本含「互换」。**模式沉淀：模块级 register* 回调必须在组件卸载时 unregister（按引用相等置 null），否则「先挂载后卸载再交互」必踩死闭包**——registerEditorOpener/registerDiffOpener/registerComposer*/setEditorHooksProvider/setFileReloadHandler 已全数配对。
`;
fs.appendFileSync(p, entry, 'utf8');
const ix = 'C:/Users/29108/.zcode/cli/memories/projects/loomery-3794f0800c2b9453/memory/MEMORY.md';
let s = fs.readFileSync(ix, 'utf8');
const anchor = '迁移后必扫四角落：复制链路/探针基建/双实现语义细节/docs 同步';
if (!s.includes(anchor)) { console.log('anchor missing'); process.exit(1); }
s = s.replace(anchor, anchor + '；**11-01 编辑器重开 bug（换位→开→关全部标签→再点打不开）：editorBus 模块级 opener 死闭包（卸载不注销吞 pending/show-editor）——全模块 register* 配对 unregister（EditorArea/ChatPanel 卸载清理），verify-editor-reopen.cjs 四步闭环 PASS；模式：模块级回调必按引用相等注销**');
fs.writeFileSync(ix, s, 'utf8');
console.log('memory updated');

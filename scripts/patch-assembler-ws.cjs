// assembler 注入工作区权威段
const fs = require('fs');
const p = 'packages/agent-core/src/context/assembler.ts';
let s = fs.readFileSync(p, 'utf8');

const a1 = '  /** ADR-0021：贡献者 side-channel 上报（如 memoryRecalled）→ 事件总线（弱类型桥接） */\n  emit?: (type: string, payload: unknown) => void;\n}';
const n1 = '  /** 本任务的路径域（多项目）：注入 system 权威压制记忆里的过时工作区路径 */\n  workspaceRoots?: string[];\n  /** ADR-0021：贡献者 side-channel 上报（如 memoryRecalled）→ 事件总线（弱类型桥接） */\n  emit?: (type: string, payload: unknown) => void;\n}';
if (!s.includes(a1)) { console.log('a1 missing'); process.exit(1); }
s = s.replace(a1, n1);

const a2 = "    const system = [input.systemBase, ...kept.map((c) => c.text)].join('\\n\\n');";
const n2 = [
  '    // 工作区权威段放在 system 末尾（对记忆注入形成「最后发言权」）：',
  '    // agent 引用过时路径被护栏拦截的根因 = 记忆先于环境（用户切项目后全局记忆仍指向旧根）',
  "    const wsSection = (input.workspaceRoots ?? []).length > 0",
  "      ? '\\n\\n[当前任务工作区] 根目录：' + input.workspaceRoots!.join(' ; ') + '\\n所有文件路径必须位于上述目录内；相对路径以第一个根为基准解析。记忆或历史中出现的其他路径可能属于别的项目或已过时，一律以本节为准。'",
  "      : '';",
  "    const system = [input.systemBase, ...kept.map((c) => c.text)].join('\\n\\n') + wsSection;",
].join('\n');
if (!s.includes(a2)) { console.log('a2 missing'); process.exit(1); }
s = s.replace(a2, n2);
fs.writeFileSync(p, s, 'utf8');
console.log('assembler patched');

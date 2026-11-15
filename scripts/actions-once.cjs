// 操作行：仅最后一条带正文的助手消息在任务结束后显示一次
const fs = require('fs');
const p = 'packages/ui/src/views/chat/Composer.tsx';
let s = fs.readFileSync(p, 'utf8');

// 1) AssistantMessage 增加 showActions
const aOld = 'function AssistantMessage({ text, reasoning, reasoningMs }: { text: string; reasoning?: string; reasoningMs?: number }): ReactElement {\n  const phase = useRuntime((s) => s.phase);';
const aNew = 'function AssistantMessage({ text, reasoning, reasoningMs, showActions }: { text: string; reasoning?: string; reasoningMs?: number; showActions?: boolean }): ReactElement {\n  const phase = useRuntime((s) => s.phase);\n  const show = showActions === true && phase === \'idle\' && text.length > 0;';
if (s.includes(aOld)) { s = s.replace(aOld, aNew); console.log('sig ok'); } else console.log('sig miss');

// 2) 操作行挂 show 条件
const actOld = '      <div className="msg-actions" style={phase === \'idle\' ? undefined : { display: \'none\' }}>';
const actNew = '      {show ? (\n      <div className="msg-actions">';
const actClose = '        <span className="tool-wrap" title="踩（即将支持）"><ThumbsDown size={13} className="tool-icon dim2" /></span>\n      </div>';
if (s.includes(actOld) && s.includes(actClose)) {
  s = s.replace(actOld, actNew);
  s = s.replace(actClose, actClose + '\n      ) : null}');
  console.log('actions gated');
} else console.log('actions miss');

// 3) Item 透传 showActions：最后一条带正文的助手消息
const itemOld = "    case 'message':\n      return item.role === 'user' ? <UserPill text={item.text} /> : (\n        <AssistantMessage text={item.text} reasoning={item.reasoning} reasoningMs={item.reasoningMs} />\n      );";
const itemNew = "    case 'message':\n      return item.role === 'user' ? <UserPill text={item.text} /> : (\n        <AssistantMessage text={item.text} reasoning={item.reasoning} reasoningMs={item.reasoningMs} showActions={item.showActions} />\n      );";
if (s.includes(itemOld)) { s = s.replace(itemOld, itemNew); console.log('item pass ok'); } else console.log('item pass miss');

fs.writeFileSync(p, s);
console.log('done');

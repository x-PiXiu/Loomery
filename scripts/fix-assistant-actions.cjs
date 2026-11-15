// AssistantMessage 签名与 show 变量修复
const fs = require('fs');
const p = 'packages/ui/src/views/chat/Composer.tsx';
let s = fs.readFileSync(p, 'utf8');
if (s.includes('const show = showActions === true')) { console.log('already ok'); process.exit(0); }

// 1) 签名
s = s.replace(
  "function AssistantMessage({ text, reasoning, reasoningMs }: { text: string; reasoning?: string; reasoningMs?: number }): ReactElement {\n  return (",
  "function AssistantMessage({ text, reasoning, reasoningMs, showActions }: { text: string; reasoning?: string; reasoningMs?: number; showActions?: boolean }): ReactElement {\n  const phase = useRuntime((s) => s.phase);\n  const show = showActions === true && phase === 'idle' && text.length > 0;\n  return (",
);
// 2) show 变量在 JSX 条件中使用
s = s.replace('{text.length > 0 ? (', '{show && text.length > 0 ? (');
fs.writeFileSync(p, s);
console.log('fixed');

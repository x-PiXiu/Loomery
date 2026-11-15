// 单一过程折叠条（整任务一条）+ 操作行仅任务结束后显示
const fs = require('fs');
let ok = 0;

// ---- Composer：替换 renderStream/buildGroups/TurnProcessBlock ----
const cpPath = 'packages/ui/src/views/chat/Composer.tsx';
let cp = fs.readFileSync(cpPath, 'utf8');

const startIdx = cp.indexOf('function renderStream(');
const endMarker = 'function TurnProcessBlock(';
const endIdx = cp.indexOf(endMarker);
if (startIdx === -1 || endIdx === -1) { console.log('anchors miss', startIdx, endIdx); process.exit(1); }
// 找 TurnProcessBlock 函数的结束（其后第一个 \n}\n）
const blockEnd = cp.indexOf('\n}\n', cp.indexOf('return (', endIdx));
if (blockEnd === -1) { console.log('block end miss'); process.exit(1); }

const replacement = [
  'function isProcessItem(item: ChatItem): boolean {',
  "  return item.kind === 'tool' || item.kind === 'notice' ||",
  "    (item.kind === 'message' && item.role === 'assistant' && item.text === '' && (item as MessageItem).reasoning !== undefined);",
  '}',
  '',
  'interface WorkInfo { running: boolean; workMs: number; runningSince: number | null }',
  '',
  'function renderStream(items: ChatItem[], work: WorkInfo): ReactElement[] {',
  '  // 整任务一条过程折叠条（用户要求：只在任务开始处出现一次，不随工具调用重复）',
  '  const proc = items.filter(isProcessItem);',
  '  const out: ReactElement[] = [];',
  '  let blockDone = false;',
  '  const pushBlock = (): void => out.push(<TurnProcessBlock key="proc" items={proc} work={work} />);',
  '  items.forEach((item, i) => {',
  '    if (isProcessItem(item)) return;',
  '    out.push(<Item key={`p${i}`} item={item} />);',
  '    if (!blockDone) { pushBlock(); blockDone = true; }',
  '  });',
  '  if (!blockDone && proc.length > 0) pushBlock();',
  '  return out;',
  '}',
  '',
  'function TurnProcessBlock({ items, work }: { items: ChatItem[]; work: WorkInfo }): ReactElement {',
  '  const [now, setNow] = useState(Date.now());',
  '  useEffect(() => {',
  '    if (!work.running) return;',
  '    const t = setInterval(() => setNow(Date.now()), 1000);',
  '    return () => clearInterval(t);',
  '  }, [work.running]);',
  '  const totalMs = work.running && work.runningSince !== null',
  '    ? work.workMs + Math.max(0, now - work.runningSince)',
  '    : work.workMs;',
  '  const secs = Math.floor(totalMs / 1000);',
  "  const label = work.running",
  "    ? `工作中… ${secs >= 60 ? `${Math.floor(secs / 60)} 分 ${secs % 60} 秒` : `${secs} 秒`}`",
  "    : secs > 0",
  "      ? `已工作 ${secs >= 60 ? `${Math.floor(secs / 60)} 分 ${secs % 60} 秒` : `${secs} 秒`}`",
  "      : `过程 · ${items.length} 项`;",
  '  return (',
  '    <details className="turn-process">',
  '      <summary>{running ? <span className="tp-running">⏳ {label}</span> : <span>✓ {label}</span>} <ChevronDown size={13} /></summary>',
  '      <div className="turn-process-body">',
  '        {items.map((it, i) => <Item key={i} item={it} />)}',
  '      </div>',
  '    </details>',
  '  );',
  '}',
  '',
].join('\n');

cp = cp.slice(0, startIdx) + replacement + cp.slice(blockEnd + 3);

// 调用点与 work 信息组装
cp = cp.replace(
  '  const proposals = useRuntime((s) => s.proposals);',
  '  const proposals = useRuntime((s) => s.proposals);\n  const workMs = useRuntime((s) => s.workMs);\n  const runningTurnAt = useRuntime((s) => s.runningTurnAt);',
);
cp = cp.replace(
  'renderStream(items, phase, turnUsage)}',
  'renderStream(items, { running: phase !== \'idle\', workMs, runningSince: runningTurnAt })}',
);
fs.writeFileSync(cpPath, cp);
ok++;
console.log('composer single-bar ok');

// ---- AssistantMessage：操作行仅任务结束后 ----
const amOld = [
  'function AssistantMessage({ text, reasoning, reasoningMs }: { text: string; reasoning?: string; reasoningMs?: number }): ReactElement {',
  '  return (',
  '    <div className="msg-assistant">',
  '      {reasoning ? <ReasoningBlock text={reasoning} ms={reasoningMs} /> : null}',
  '      <Markdown',
].join('\n');
const amNew = [
  'function AssistantMessage({ text, reasoning, reasoningMs }: { text: string; reasoning?: string; reasoningMs?: number }): ReactElement {',
  '  const phase = useRuntime((s) => s.phase);',
  '  return (',
  '    <div className="msg-assistant">',
  '      {reasoning ? <ReasoningBlock text={reasoning} ms={reasoningMs} /> : null}',
  '      <Markdown',
].join('\n');
if (cp.includes(amOld)) { cp = cp.replace(amOld, amNew); console.log('assistant hook ok'); } else console.log('assistant miss');

const actOld = '      <div className="msg-actions">';
const actNew = '      <div className="msg-actions" style={phase === \'idle\' ? undefined : { display: \'none\' }}>';
if (cp.includes(actOld)) { cp = cp.replace(actOld, actNew); ok++; console.log('actions gated ok'); } else console.log('actions miss');

fs.writeFileSync(cpPath, cp);
console.log('done ok =', ok);

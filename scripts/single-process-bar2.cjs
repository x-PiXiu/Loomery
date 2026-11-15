// 用起止行号精确替换 renderStream…TurnProcessBlock 整段
const fs = require('fs');
const p = 'packages/ui/src/views/chat/Composer.tsx';
const lines = fs.readFileSync(p, 'utf8').split('\n');
const startIdx = lines.findIndex((l) => l.startsWith('function renderStream('));
const endIdx = lines.findIndex((l) => l.startsWith('function TurnProcessBlock('));
if (startIdx === -1 || endIdx === -1) { console.log('anchors miss', startIdx, endIdx); process.exit(1); }
// TurnProcessBlock 结束行：从 endIdx 往后找第一个恰为 '}' 的行
let closeIdx = -1;
for (let i = endIdx; i < lines.length; i++) {
  if (lines[i] === '}') { closeIdx = i; break; }
}
if (closeIdx === -1) { console.log('close miss'); process.exit(1); }

const replacement = [
  'function isProcessItem(item: ChatItem): boolean {',
  "  return item.kind === 'tool' || item.kind === 'notice' ||",
  "    (item.kind === 'message' && item.role === 'assistant' && item.text === '' && (item as MessageItem).reasoning !== undefined);",
  '}',
  '',
  'interface WorkInfo { running: boolean; workMs: number; runningSince: number | null }',
  '',
  'function renderStream(items: ChatItem[], work: WorkInfo): ReactElement[] {',
  '  // 整任务一条过程折叠条（只在任务开始处出现一次，不随工具调用重复）',
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
  "  const fmt = (v: number): string => (v >= 60 ? `${Math.floor(v / 60)} 分 ${v % 60} 秒` : `${v} 秒`);",
  "  const label = work.running",
  "    ? `工作中… ${fmt(secs)}`",
  '    : secs > 0',
  "      ? `已工作 ${fmt(secs)}`",
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
].join('\n').split('\n');

lines.splice(startIdx, closeIdx - startIdx + 1, ...replacement);
fs.writeFileSync(p, lines.join('\n'));
console.log('replaced', closeIdx - startIdx + 1, 'lines with', replacement.length);

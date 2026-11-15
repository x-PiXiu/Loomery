// 每轮一条过程折叠条（按 turnId 分段，放回各自位置，时长用该轮自己的）
const fs = require('fs');
const p = 'packages/ui/src/views/chat/Composer.tsx';
const lines = fs.readFileSync(p, 'utf8').split('\n');
const startIdx = lines.findIndex((l) => l.startsWith('function renderStream('));
if (startIdx === -1) { console.log('renderStream miss'); process.exit(1); }
let closeIdx = -1;
for (let i = startIdx; i < lines.length; i++) {
  if (lines[i] === '}') { closeIdx = i; break; }
}
if (closeIdx === -1) { console.log('close miss'); process.exit(1); }

const replacement = [
  'function renderStream(items: ChatItem[], work: { running: boolean; durations: Record<string, number>; runningTurnId: string | null }): ReactElement[] {',
  '  const lastTextMsgId = [...items].reverse().find((i): i is MessageItem => i.kind === \'message\' && i.role === \'assistant\' && i.text.length > 0)?.messageId;',
  '  // 每轮一条过程折叠条：按 turnId 分段，放回各自位置（对齐 ZCode 每轮一条）',
  '  const segments: { turnId: string; items: ChatItem[] }[] = [];',
  '  for (const item of items) {',
  '    if (!isProcessItem(item)) continue;',
  '    const tid = item.turnId ?? \'?\';',
  '    const last = segments[segments.length - 1];',
  '    if (last && last.turnId === tid) last.items.push(item);',
  '    else segments.push({ turnId: tid, items: [item] });',
  '  }',
  '  const segByKey = new Map(segments.map((s) => [`seg:${s.turnId}`, s]));',
  '  const out: ReactElement[] = [];',
  '  const rendered = new Set<string>();',
  '  items.forEach((item, i) => {',
  '    if (isProcessItem(item)) {',
  '      const tid = item.turnId ?? \'?\';',
  '      const key = `seg:${tid}`;',
  '      if (!rendered.has(key)) {',
  '        rendered.add(key);',
  '        const seg = segByKey.get(key);',
  '        const running = work.running && work.runningTurnId === tid;',
  '        const durationMs = work.durations[tid] ?? 0;',
  '        out.push(<TurnProcessBlock key={key} items={seg.items} running={running} durationMs={durationMs} />);',
  '      }',
  '      return;',
  '    }',
  '    const showActions = item.kind === \'message\' && item.role === \'assistant\' && item.messageId === lastTextMsgId;',
  '    out.push(<Item key={`p${i}`} item={item} showActions={showActions} />);',
  '  });',
  '  return out;',
  '}',
  '',
  'function TurnProcessBlock({ items, running, durationMs }: { items: ChatItem[]; running: boolean; durationMs: number }): ReactElement {',
  '  const [now, setNow] = useState(Date.now());',
  '  useEffect(() => {',
  '    if (!running) return;',
  '    const t = setInterval(() => setNow(Date.now()), 1000);',
  '    return () => clearInterval(t);',
  '  }, [running]);',
  '  const totalMs = running ? Math.max(0, now - (Date.now() - durationMs)) : durationMs;',
  '  const secs = Math.floor(totalMs / 1000);',
  "  const fmt = (v: number): string => (v >= 60 ? `${Math.floor(v / 60)} 分 ${v % 60} 秒` : `${v} 秒`);",
  "  const label = running",
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
].join('\n');

lines.splice(startIdx, closeIdx - startIdx + 1, ...replacement);
fs.writeFileSync(p, lines.join('\n'));
console.log('renderStream per-turn ok');

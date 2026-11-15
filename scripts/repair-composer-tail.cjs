// 修复 Composer 尾部：截断损坏区，追加正确的 renderStream + TurnProcessBlock
const fs = require('fs');
const p = 'packages/ui/src/views/chat/Composer.tsx';
const lines = fs.readFileSync(p, 'utf8').split('\n');
const startIdx = lines.findIndex((l) => l.startsWith('function renderStream(') || l === 'S');
// 找真正起点：向后找第一个以 'function ' 或 'S' 开头的损坏区起点
let cut = lines.findIndex((l) => l.startsWith('function renderStream('));
if (cut === -1) cut = lines.findIndex((l) => l === 'S');
if (cut === -1) { console.log('cut point miss'); process.exit(1); }

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
];

// 截断损坏区（从 cut 到文件尾，保留其前的合法内容；但 startIdx 之前可能有合法代码，cut 之前内容保留）
const head = lines.slice(0, cut).filter((l) => !['S','t','r','e','a','m','(','i','t','e','m','s',':','C','h','a','t','I'].includes(l));
// 上面过滤可能误伤——只移除从 cut 开始的即可；head 保持原样
const headClean = lines.slice(0, cut);
fs.writeFileSync(p, [...headClean, ...replacement].join('\n'));
console.log('tail rebuilt, head lines:', headClean.length);

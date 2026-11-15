// 修复 Composer 尾部残留 + runtime 增加 turnDurations/runningTurnId
const fs = require('fs');

// 1) Composer：清掉 WorkInfo 之后的损坏字符行，修正调用点
const cpPath = 'packages/ui/src/views/chat/Composer.tsx';
let cp = fs.readFileSync(cpPath, 'utf8').split('\n');
// 找 interface WorkInfo 行，删除其后到下一个合法 function 之前的单字符行
const wi = cp.findIndex((l) => l.startsWith('interface WorkInfo'));
if (wi !== -1) {
  // 删除 WorkInfo 之后的所有损坏行（到文件尾）——replacement 会重新追加
  cp = cp.slice(0, wi + 1);
  cp.push('');
  cp.push('function renderStream(items: ChatItem[], work: { running: boolean; durations: Record<string, number>; runningTurnId: string | null }): ReactElement[] {');
  cp.push('  const lastTextMsgId = [...items].reverse().find((i): i is MessageItem => i.kind === \'message\' && i.role === \'assistant\' && i.text.length > 0)?.messageId;');
  cp.push('  // 每轮一条过程折叠条：按 turnId 分段，放回各自位置（对齐 ZCode 每轮一条）');
  cp.push('  const segments: { turnId: string; items: ChatItem[] }[] = [];');
  cp.push('  for (const item of items) {');
  cp.push('    if (!isProcessItem(item)) continue;');
  cp.push('    const tid = item.turnId ?? \'?\';');
  cp.push('    const last = segments[segments.length - 1];');
  cp.push('    if (last && last.turnId === tid) last.items.push(item);');
  cp.push('    else segments.push({ turnId: tid, items: [item] });');
  cp.push('  }');
  cp.push('  const segByKey = new Map(segments.map((s) => [`seg:${s.turnId}`, s]));');
  cp.push('  const out: ReactElement[] = [];');
  cp.push('  const rendered = new Set<string>();');
  cp.push('  items.forEach((item, i) => {');
  cp.push('    if (isProcessItem(item)) {');
  cp.push('      const tid = item.turnId ?? \'?\';');
  cp.push('      const key = `seg:${tid}`;');
  cp.push('      if (!rendered.has(key)) {');
  cp.push('        rendered.add(key);');
  cp.push('        const seg = segByKey.get(key);');
  cp.push('        const running = work.running && work.runningTurnId === tid;');
  cp.push('        const durationMs = work.durations[tid] ?? 0;');
  cp.push('        out.push(<TurnProcessBlock key={key} items={seg.items} running={running} durationMs={durationMs} />);');
  cp.push('      }');
  cp.push('      return;');
  cp.push('    }');
  cp.push('    const showActions = item.kind === \'message\' && item.role === \'assistant\' && item.messageId === lastTextMsgId;');
  cp.push('    out.push(<Item key={`p${i}`} item={item} showActions={showActions} />);');
  cp.push('  });');
  cp.push('  return out;');
  cp.push('}');
  cp.push('');
  cp.push('function TurnProcessBlock({ items, running, durationMs }: { items: ChatItem[]; running: boolean; durationMs: number }): ReactElement {');
  cp.push('  const [now, setNow] = useState(Date.now());');
  cp.push('  useEffect(() => {');
  cp.push('    if (!running) return;');
  cp.push('    const t = setInterval(() => setNow(Date.now()), 1000);');
  cp.push('    return () => clearInterval(t);');
  cp.push('  }, [running]);');
  cp.push('  const totalMs = running ? Math.max(0, now - (Date.now() - durationMs)) : durationMs;');
  cp.push('  const secs = Math.floor(totalMs / 1000);');
  cp.push("  const fmt = (v: number): string => (v >= 60 ? `${Math.floor(v / 60)} 分 ${v % 60} 秒` : `${v} 秒`);");
  cp.push("  const label = running");
  cp.push("    ? `工作中… ${fmt(secs)}`");
  cp.push('    : secs > 0');
  cp.push("      ? `已工作 ${fmt(secs)}`");
  cp.push("      : `过程 · ${items.length} 项`;");
  cp.push('  return (');
  cp.push('    <details className="turn-process">');
  cp.push('      <summary>{running ? <span className="tp-running">⏳ {label}</span> : <span>✓ {label}</span>} <ChevronDown size={13} /></summary>');
  cp.push('      <div className="turn-process-body">');
  cp.push('        {items.map((it, i) => <Item key={i} item={it} />)}');
  cp.push('      </div>');
  cp.push('    </details>');
  cp.push('  );');
  cp.push('}');
  fs.writeFileSync(cpPath, cp.join('\n'));
  console.log('composer tail rebuilt');
} else console.log('workinfo absent');

// 调用点：workMs → durations
let cs = fs.readFileSync(cpPath, 'utf8');
if (cs.includes('workMs, runningSince: runningTurnAt')) {
  cs = cs.replace('workMs, runningSince: runningTurnAt', 'durations: turnDurations, runningTurnId: runningTurnAt');
  if (!cs.includes('const turnDurations = useRuntime')) {
    cs = cs.replace(
      '  const runningTurnAt = useRuntime((s) => s.runningTurnAt);',
      '  const runningTurnAt = useRuntime((s) => s.runningTurnAt);\n  const turnDurations = useRuntime((s) => s.turnDurations);',
    );
  }
  fs.writeFileSync(cpPath, cs);
  console.log('call site fixed');
}

// 2) runtime：turnDurations + runningTurnId
const rtPath = 'packages/ui/src/stores/runtime.ts';
let rt = fs.readFileSync(rtPath, 'utf8');
if (!rt.includes('turnDurations')) {
  rt = rt.replace(
    '  workMs: number;\n  runningTurnAt: number | null;',
    '  workMs: number;\n  runningTurnAt: number | null;\n  /** 每轮工作时长 ms（turnId → ms，过程折叠条用） */\n  turnDurations: Record<string, number>;\n  /** 进行中 Turn 的 id */\n  runningTurnId: string | null;'
  );
  rt = rt.replace(
    '  proposals: {},\n  workMs: 0,\n  runningTurnAt: null,\n};',
    '  proposals: {},\n  workMs: 0,\n  runningTurnAt: null,\n  turnDurations: {},\n  runningTurnId: null,\n};'
  );
  rt = rt.replace(
    'let { items, threads, mode, tokens, phase, terminated, checkpoint, turnChanges, turnUsage, lastInputTokens, proposals, workMs, runningTurnAt } = s;',
    'let { items, threads, mode, tokens, phase, terminated, checkpoint, turnChanges, turnUsage, lastInputTokens, proposals, workMs, runningTurnAt, turnDurations, runningTurnId } = s;'
  );
  rt = rt.replace(
    '          proposals = {};\n          runningTurnAt = ev.ts;',
    '          proposals = {};\n          runningTurnAt = ev.ts;\n          runningTurnId = ev.payload.turnId;'
  );
  rt = rt.replace(
    "          workMs = workMs + Math.max(0, ev.ts - (runningTurnAt ?? ev.ts));\n          runningTurnAt = null;",
    "          workMs = workMs + Math.max(0, ev.ts - (runningTurnAt ?? ev.ts));\n          if (ev.turnId) turnDurations = { ...turnDurations, [ev.turnId]: Math.max(0, ev.ts - (runningTurnAt ?? ev.ts)) };\n          runningTurnAt = null;"
  );
  rt = rt.replace(
    'this.state = { ...s, events, items, threads, mode, tokens, phase, terminated, checkpoint, turnChanges, turnUsage, lastInputTokens, proposals, workMs, runningTurnAt };',
    'this.state = { ...s, events, items, threads, mode, tokens, phase, terminated, checkpoint, turnChanges, turnUsage, lastInputTokens, proposals, workMs, runningTurnAt, turnDurations, runningTurnId };'
  );
  rt = rt.replace(
    "this.set({ activeThreadId: threadId, items, tokens: 0, phase: 'idle', terminated: null, checkpoint: null, turnChanges: null, turnUsage: null, lastInputTokens: 0, proposals: {}, events: [], workMs: 0, runningTurnAt: null });",
    "this.set({ activeThreadId: threadId, items, tokens: 0, phase: 'idle', terminated: null, checkpoint: null, turnChanges: null, turnUsage: null, lastInputTokens: 0, proposals: {}, events: [], workMs: 0, runningTurnAt: null, turnDurations: {}, runningTurnId: null });"
  );
  fs.writeFileSync(rtPath, rt);
  console.log('runtime turnDurations ok');
} else console.log('runtime present');

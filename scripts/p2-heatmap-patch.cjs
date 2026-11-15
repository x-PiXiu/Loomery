// P2 Token 活动重做：一年热力图（一天一格，53 周列×7 行）+ 每日/每周/累计口径切换 + 月份标签对齐列
const fs = require('node:fs');
const p = 'packages/ui/src/views/settings/usage-panel.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) { console.error('MISS: ' + a.slice(0, 80)); process.exit(1); }
  s = s.replace(a, b);
};

// 1) heatMode 状态（必须在早退之前声明——Hooks 规则）
rep(
  `  const [stats, setStats] = useState<UsageStats | null>(null);`,
  `  const [stats, setStats] = useState<UsageStats | null>(null);
  const [heatMode, setHeatMode] = useState<'daily' | 'weekly' | 'cumulative'>('daily');`,
);

// 2) 计算块整体替换（12 周 → 一年 53 周 + 三口径）
rep(
  `  // 热力图：最近 12 周，列=周、行=周一..周日
  const WEEKS = 12;
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - (WEEKS * 7 - 1));
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // 对齐周一
  const maxDay = Math.max(1, ...active.map((d) => d.tokens));
  const cells: { date: string; tokens: number; level: number }[] = [];
  for (let i = 0; i < WEEKS * 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = dayKey(d);
    const tokens = dailyMap.get(key) ?? 0;
    const level = tokens === 0 ? 0 : tokens / maxDay > 0.66 ? 4 : tokens / maxDay > 0.33 ? 3 : tokens / maxDay > 0.1 ? 2 : 1;
    cells.push({ date: key, tokens, level });
  }
  const monthLabels: { x: number; label: string }[] = [];
  for (let w = 0; w < WEEKS; w++) {
    const d = new Date(start);
    d.setDate(start.getDate() + w * 7);
    if (d.getDate() <= 7) monthLabels.push({ x: w, label: d.getMonth() + 1 + '月' });
  }`,
  `  // 热力图：一年（约 53 周），列=周、行=周一..周日——一天一格，越用越蓝（对齐 ZCode）
  const heatToday = new Date();
  const heatStart = new Date(heatToday);
  heatStart.setFullYear(heatStart.getFullYear() - 1);
  heatStart.setDate(heatStart.getDate() - ((heatStart.getDay() + 6) % 7)); // 对齐周一
  const weeks: { date: string; tokens: number }[][] = [];
  const heatCursor = new Date(heatStart);
  while (heatCursor <= heatToday) {
    const week: { date: string; tokens: number }[] = [];
    for (let d = 0; d < 7 && heatCursor <= heatToday; d++) {
      const key = dayKey(heatCursor);
      week.push({ date: key, tokens: dailyMap.get(key) ?? 0 });
      heatCursor.setDate(heatCursor.getDate() + 1);
    }
    weeks.push(week);
  }
  const flat: number[] = [];
  for (const week of weeks) for (const d of week) flat.push(d.tokens);
  const cum: number[] = [];
  let heatAcc = 0;
  for (const v of flat) { heatAcc += v; cum.push(heatAcc); }
  const grid: number[][] = [];
  let flatIdx = 0;
  for (const week of weeks) {
    const weekSum = week.reduce((s, d) => s + d.tokens, 0);
    grid.push(week.map(() => (heatMode === 'weekly' ? weekSum : heatMode === 'cumulative' ? cum[flatIdx++] : flat[flatIdx++])));
  }
  const heatMax = Math.max(1, ...grid.flat());
  const levelOf = (v: number): number => (v <= 0 ? 0 : v / heatMax > 0.66 ? 4 : v / heatMax > 0.33 ? 3 : v / heatMax > 0.1 ? 2 : 1);
  const monthLabels: { x: number; label: string }[] = [];
  let prevMonth = -1;
  weeks.forEach((week, wi) => {
    const first = week[0];
    if (!first) return;
    const m = Number(first.date.slice(5, 7));
    if (m !== prevMonth) { monthLabels.push({ x: wi, label: m + '月' }); prevMonth = m; }
  });`,
);

// 3) JSX 卡整体替换（12 周网格 → 一年网格 + 口径切换）
rep(
  `      <div className="usage-card">
        <div className="usage-card-head"><span>Token 活动</span><span className="usage-hint">近 12 周</span></div>
        <div className="heatmap">
          {Array.from({ length: WEEKS }).map((_, w) => (
            <div key={w} className="heatmap-col">
              {cells.slice(w * 7, w * 7 + 7).map((c) => (
                <span key={c.date} className={\`heat-cell l\${c.level}\`} title={c.date + ' · ' + fmt(c.tokens) + ' tokens'} />
              ))}
            </div>
          ))}
        </div>
        <div className="heatmap-months">
          {monthLabels.map((m) => <span key={m.x + m.label} style={{ left: (String((m.x + 0.5) / 12 * 100)) + '%', transform: 'translateX(-50%)' }}>{m.label}</span>)}
        </div>
        <div className="usage-hint">共 {active.length} 个活跃日 · 当前连续 {current} 天</div>
      </div>`,
  `      <div className="usage-card">
        <div className="usage-card-head">
          <span>Token 活动</span>
          <span className="heat-toggle">
            {(['daily', 'weekly', 'cumulative'] as const).map((m) => (
              <button key={m} className={heatMode === m ? 'active' : ''} onClick={() => setHeatMode(m)}>
                {m === 'daily' ? '每日' : m === 'weekly' ? '每周' : '累计'}
              </button>
            ))}
          </span>
        </div>
        <div className="heatmap">
          {grid.map((col, wi) => (
            <div key={wi} className="heatmap-col">
              {col.map((v, di) => {
                const dateStr = weeks[wi]?.[di]?.date ?? '';
                const suffix = heatMode === 'weekly' ? '（本周合计）' : heatMode === 'cumulative' ? '（累计）' : '';
                return <span key={dateStr + di} className={\`heat-cell l\${levelOf(v)}\`} title={dateStr + ' · ' + fmt(v) + ' tokens' + suffix} />;
              })}
            </div>
          ))}
        </div>
        <div className="heatmap-months">
          {monthLabels.map((m) => <span key={m.x + m.label} style={{ left: (m.x / Math.max(1, grid.length)) * 100 + '%' }}>{m.label}</span>)}
        </div>
        <div className="usage-hint">共 {active.length} 个活跃日 · 当前连续 {current} 天</div>
      </div>`,
);

// 4) CSS：口径切换 + 格子尺寸（列窄格小，铺满一年）
let c = fs.readFileSync('packages/ui/src/theme.css', 'utf8');
if (!c.includes('.heat-toggle')) {
  const css = '\n/* Token 活动一年热力图 */\n.heat-toggle { display: inline-flex; background: var(--bg-hover); border-radius: 8px; padding: 2px; gap: 2px; }\n.heat-toggle button { border: 0; background: transparent; color: var(--text-dim); font-size: 11.5px; padding: 3px 10px; border-radius: 6px; cursor: pointer; }\n.heat-toggle button.active { background: var(--bg-card); color: var(--text); }\n.heatmap { gap: 3px; }\n.heatmap-col { gap: 3px; }\n.heat-cell { border-radius: 3px; }\n';
  c += css;
  fs.writeFileSync('packages/ui/src/theme.css', c);
  console.log('css ok');
}
fs.writeFileSync(p, s);
console.log('year heatmap done');

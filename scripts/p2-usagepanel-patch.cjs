// P2 统计二期：使用统计页模型环形图 + 多模型趋势线（历史无出处数据单线兜底/归"历史"桶）
const fs = require('node:fs');
const p = 'packages/ui/src/views/settings/usage-panel.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) { console.error('MISS: ' + a.slice(0, 70)); process.exit(1); }
  s = s.replace(a, b);
};

// ① 接口扩展
rep(
  `interface UsageStats {
  threads: UsageThreadRow[];
  daily: { date: string; tokens: number }[];
}`,
  `interface UsageStats {
  threads: UsageThreadRow[];
  daily: { date: string; tokens: number; models?: Record<string, number> }[];
  byModel?: Record<string, number>;
}`,
);

// ② 趋势计算改多模型序列
rep(
  `  const trendMax = Math.max(1, ...trend.map((t) => t.tokens));
  const W = 600;
  const H = 120;
  const px = (i: number): number => (i / (TREND_DAYS - 1)) * (W - 10) + 5;
  const py = (v: number): number => H - 8 - (v / trendMax) * (H - 20);
  const points = trend.map((t, i) => \`\${px(i).toFixed(1)},\${py(t.tokens).toFixed(1)}\`).join(' ');`,
  `  const trendMax = Math.max(1, ...trend.map((t) => t.tokens));
  const W = 600;
  const H = 120;
  const px = (i: number): number => (i / (TREND_DAYS - 1)) * (W - 10) + 5;
  const py = (v: number): number => H - 8 - (v / trendMax) * (H - 20);
  // 多模型序列（仅 model 出处存在的数据；历史数据单线兜底）
  const TREND_COLORS = ['#4f8cff', '#22a06b', '#f59e0b', '#a855f7', '#ef4444'];
  const modelNames = useMemo(() => {
    const names = new Set<string>();
    for (const t of trend) for (const m of Object.keys(t.models ?? {})) if (t.tokens > 0) names.add(m);
    return [...names];
  }, [trend]);
  const seriesOf = (m: string): string =>
    trend.map((t, i) => { const v = (t.models ?? {})[m] ?? 0; return px(i).toFixed(1) + ',' + py(v).toFixed(1); }).join(' ');
  const totalPoints = trend.map((t, i) => px(i).toFixed(1) + ',' + py(t.tokens).toFixed(1)).join(' ');`,
);

// ③ SVG 渲染：多线 + 图例；单线兜底
rep(
  `        <svg className="trend-svg" viewBox={\`0 0 \${W} \${H}\`} preserveAspectRatio="none">
          <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="2" />
          {trend.map((t, i) => (t.tokens > 0 ? <circle key={t.date} cx={px(i)} cy={py(t.tokens)} r="2.5" fill="var(--accent)" /> : null))}
        </svg>`,
  `        <svg className="trend-svg" viewBox={\`0 0 \${W} \${H}\`} preserveAspectRatio="none">
          {hasModelSeries
            ? modelNames.map((m, mi) => (
              <polyline key={m} points={seriesOf(m)} fill="none" stroke={TREND_COLORS[mi % TREND_COLORS.length]} strokeWidth="2" />
            ))
            : <polyline points={totalPoints} fill="none" stroke="var(--accent)" strokeWidth="2" />}
        </svg>
        {hasModelSeries ? (
          <div className="trend-legend">
            {modelNames.map((m, mi) => (
              <span key={m} className="trend-legend-item">
                <span className="trend-legend-dot" style={{ background: TREND_COLORS[mi % TREND_COLORS.length] }} />
                {m}
              </span>
            ))}
          </div>
        ) : null}`,
);

// ④ 环形图卡（byModel；历史桶灰色调）插在趋势卡后、任务明细前
rep(
  `      <div className="usage-card">
        <div className="usage-card-head"><span>任务用量明细</span></div>`,
  `      {byModel && Object.keys(byModel).length > 0 ? (
        <div className="usage-card">
          <div className="usage-card-head"><span>模型用量</span></div>
          <div className="donut-wrap">
            <Donut byModel={byModel} />
            <div className="donut-legend">
              {Object.entries(byModel).sort((a, b) => b[1] - a[1]).map(([m, v], i) => (
                <div key={m} className="donut-legend-row">
                  <span className="trend-legend-dot" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
                  <span className="donut-legend-name">{m}</span>
                  <span className="donut-legend-val">{fmt(v)} · {Math.round((v / Math.max(1, total)) * 100)}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      <div className="usage-card">
        <div className="usage-card-head"><span>任务用量明细</span></div>`,
);

// ⑤ Donut 组件 + 常量
s = s.trimEnd() + `

const DONUT_COLORS = ['#4f8cff', '#22a06b', '#f59e0b', '#a855f7', '#ef4444', '#14b8a6'];

/** 模型用量环形图：中心总量，扇区按占比（无图表库，纯 SVG stroke-dasharray） */
function Donut({ byModel }: { byModel: Record<string, number> }): ReactElement {
  const entries = Object.entries(byModel).sort((a, b) => b[1] - a[1]);
  const total = Math.max(1, entries.reduce((s, [, v]) => s + v, 0));
  const R = 52;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <svg className="donut" viewBox="0 0 140 140">
      <circle cx="70" cy="70" r={R} fill="none" stroke="var(--bg-hover)" strokeWidth="18" />
      {entries.map(([m, v], i) => {
        const frac = v / total;
        const dash = frac * C;
        const el = (
          <circle
            key={m}
            cx="70" cy="70" r={R} fill="none"
            stroke={DONUT_COLORS[i % DONUT_COLORS.length]}
            strokeWidth="18"
            strokeDasharray={dash + ' ' + (C - dash)}
            strokeDashoffset={-offset}
            transform="rotate(-90 70 70)"
          />
        );
        offset += dash;
        return el;
      })}
      <text x="70" y="66" textAnchor="middle" className="donut-total">{fmt(total)}</text>
      <text x="70" y="82" textAnchor="middle" className="donut-sub">tokens</text>
    </svg>
  );
}
`;
fs.writeFileSync(p, s);
console.log('donut + multi-series done');

// 使用统计（对齐 ZCode 版式）：统计卡 + Token 活动热力图 + 每日趋势 + 任务明细
// 数据源：usageStats RPC（事件日志 usageDelta 按日折叠）。诚实边界：事件未记录模型出处，模型级拆分待后续批次。
import { useEffect, useState, type ReactElement } from 'react';
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';
import { rpc } from '@loomery/adapter-ipc-bridge/renderer';

interface UsageThreadRow {
  id: string;
  title: string;
  workspaceRoot?: string;
  usageTokens: number;
  createdAt: number;
}
interface UsageStats {
  threads: UsageThreadRow[];
  daily: { date: string; tokens: number; models?: Record<string, number> }[];
  byModel?: Record<string, number>;
}

const fmt = (n: number): string => {
  if (n >= 100_000_000) return (n / 100_000_000).toFixed(1) + ' 亿';
  if (n >= 10_000) return (n / 10_000).toFixed(1) + ' 万';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
};
const dayKey = (d: Date): string => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

/** 连续活跃天数：当前（从今天/昨天回溯）与历史最长 */
function streaks(dates: Set<string>): { current: number; longest: number } {
  if (dates.size === 0) return { current: 0, longest: 0 };
  const sorted = [...dates].sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1]! + 'T00:00:00');
    const cur = new Date(sorted[i]! + 'T00:00:00');
    const diff = (cur.getTime() - prev.getTime()) / 86_400_000;
    if (diff === 1) { run += 1; longest = Math.max(longest, run); } else run = 1;
  }
  // 当前连续：从今天起（今天没用量则从昨天起）回溯
  let current = 0;
  const cursor = new Date();
  if (!dates.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (dates.has(dayKey(cursor))) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { current, longest };
}

export function UsageSettings(): ReactElement {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [heatMode, setHeatMode] = useState<'daily' | 'weekly' | 'cumulative'>('daily');
  useEffect(() => {
    void rpc.call<UsageStats>(RPC.usageStats, {}).then(setStats).catch(() => undefined);
  }, []);

  if (!stats) return <div className="settings-pane"><div className="notice">加载中…</div></div>;

  const total = stats.threads.reduce((s, t) => s + t.usageTokens, 0);
  const peak = Math.max(0, ...stats.threads.map((t) => t.usageTokens));
  const active = stats.daily.filter((d) => d.tokens > 0);
  const dateSet = new Set(active.map((d) => d.date));
  const { current, longest } = streaks(dateSet);
  const dailyMap = new Map(stats.daily.map((d) => [d.date, d.tokens]));

  // 热力图：一年（约 53 周），列=周、行=周一..周日——一天一格，越用越蓝（对齐 ZCode）
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
    grid.push(week.map(() => (heatMode === 'weekly' ? weekSum : heatMode === 'cumulative' ? (cum[flatIdx++] ?? 0) : (flat[flatIdx++] ?? 0))));
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
  });

  // 趋势：最近 30 天（零填充）折线
  const TREND_DAYS = 30;
  const today = new Date();
  const modelsByDate = new Map(stats.daily.map((d) => [d.date, d.models ?? {}]));
  const trend: { date: string; tokens: number; models?: Record<string, number> }[] = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = dayKey(d);
    trend.push({ date: key, tokens: dailyMap.get(key) ?? 0, models: modelsByDate.get(key) });
  }
  const trendMax = Math.max(1, ...trend.map((t) => t.tokens));
  const W = 600;
  const H = 120;
  const px = (i: number): number => (i / (TREND_DAYS - 1)) * (W - 10) + 5;
  const py = (v: number): number => H - 8 - (v / trendMax) * (H - 20);
  // 多模型序列（仅 model 出处存在的数据；历史数据单线兜底）
  const TREND_COLORS = ['#4f8cff', '#22a06b', '#f59e0b', '#a855f7', '#ef4444'];
  // 按模型名去重（此前每天重复 push 同名系列=同名多线）
  const modelNameSet = new Set<string>();
  for (const t of trend) if (t.tokens > 0) for (const m of Object.keys(t.models ?? {})) modelNameSet.add(m);
  const modelNames: string[] = [...modelNameSet];
  const seriesOf = (m: string): string =>
    trend.map((t, i) => { const v = (t.models ?? {})[m] ?? 0; return px(i).toFixed(1) + ',' + py(v).toFixed(1); }).join(' ');
  const totalPoints = trend.map((t, i) => px(i).toFixed(1) + ',' + py(t.tokens).toFixed(1)).join(' ');
  const hasModelSeries = modelNames.length > 0;

  const rows = [...stats.threads].sort((a, b) => b.usageTokens - a.usageTokens);

  return (
    <div className="settings-pane usage-pane">
      <div className="settings-pane-title">使用统计</div>
      <div className="stat-cards">
        <div className="stat-card"><b>{fmt(total)}</b><span>累计 Token</span></div>
        <div className="stat-card"><b>{fmt(peak)}</b><span>峰值任务 Token</span></div>
        <div className="stat-card"><b>{stats.threads.length}</b><span>任务数</span></div>
        <div className="stat-card"><b>{active.length}</b><span>活跃天数</span></div>
        <div className="stat-card"><b>{longest} 天</b><span>最长连续使用</span></div>
      </div>

      <div className="usage-card">
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
                return <span key={dateStr + di} className={`heat-cell l${levelOf(v)}`} title={dateStr + ' · ' + fmt(v) + ' tokens' + suffix} />;
              })}
            </div>
          ))}
        </div>
        <div className="heatmap-months">
          {monthLabels.map((m) => <span key={m.x + m.label} style={{ left: (m.x / Math.max(1, grid.length)) * 100 + '%' }}>{m.label}</span>)}
        </div>
        <div className="usage-hint">共 {active.length} 个活跃日 · 当前连续 {current} 天</div>
      </div>

      <div className="usage-card">
        <div className="usage-card-head"><span>每日 Token 趋势（近 30 天）</span></div>
        <svg className="trend-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
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
        ) : null}
        <div className="trend-axis">
          <span>{trend[0]?.date.slice(5)}</span>
          <span>峰值 {fmt(trendMax)}</span>
          <span>{trend[trend.length - 1]?.date.slice(5)}</span>
        </div>
      </div>

      {stats.byModel && Object.keys(stats.byModel).length > 0 ? (
        <div className="usage-card">
          <div className="usage-card-head"><span>模型用量</span></div>
          <div className="donut-wrap">
            <Donut byModel={stats.byModel} />
            <div className="donut-legend">
              {Object.entries(stats.byModel).sort((a, b) => b[1] - a[1]).map(([m, v], i) => (
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
        <div className="usage-card-head"><span>任务用量明细</span></div>
        <div className="usage-thread-list">
          {rows.map((t) => (
            <div key={t.id} className="usage-thread-row">
              <span className="usage-thread-title" title={t.title}>{t.title}</span>
              <span className="usage-bar"><span style={{ width: `${Math.round((t.usageTokens / Math.max(1, peak)) * 100)}%` }} /></span>
              <span className="usage-val">{fmt(t.usageTokens)}</span>
            </div>
          ))}
          {rows.length === 0 ? <div className="notice">暂无任务。</div> : null}
        </div>
        <div className="usage-hint">模型级拆分需事件记录出处模型（当前事件未记录，后续批次补）。</div>
      </div>
    </div>
  );
}

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

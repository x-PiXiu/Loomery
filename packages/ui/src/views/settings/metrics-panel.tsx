// 运行指标（2026-11-13 可观测性面板）：从已有事件聚合的轮级体检/工具统计/安全面——零新采集
// 数据源：metricsRun RPC（bootstrap 聚合 events 表：turn 生命周期/工具调用 join/护栏/审计裁决）
import { useEffect, useState, type ReactElement } from 'react';
import { RPC } from '@loomery/adapter-ipc-bridge/envelope';
import { rpc } from '@loomery/adapter-ipc-bridge/renderer';

interface TurnRow {
  firstTs: number;
  threadId: string;
  title: string;
  steps: number;
  tokens: number;
  wallMs: number;
  tools: number;
  toolFail: number;
  approvals: number;
  guardrails: number;
  audits: Record<string, number>;
  reason?: string;
  outcome?: string;
}
interface ToolRow {
  name: string;
  calls: number;
  fail: number;
  ms: number;
  avgMs: number;
}
interface MetricsRun {
  totals: {
    turns: number;
    tokens: number;
    avgSteps: number;
    toolCalls: number;
    toolFail: number;
    guardrails: number;
    injection: number;
    dangerous: number;
    memoryRecalls: number;
  };
  turns: TurnRow[];
  tools: ToolRow[];
  guardByRule: Record<string, number>;
}

const fmt = (n: number): string => {
  if (n >= 10_000) return (n / 10_000).toFixed(1) + ' 万';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
};
const dur = (ms: number): string => {
  if (ms >= 60_000) return Math.round(ms / 60_000) + ' 分 ' + Math.round((ms % 60_000) / 1000) + ' 秒';
  if (ms >= 1000) return (ms / 1000).toFixed(1) + ' 秒';
  return ms + ' ms';
};
/** 轮的终局标签：outcome + 终止原因（selfReport/natural=健康，其余显性标出） */
function outcomeLabel(t: TurnRow): { text: string; cls: string } {
  if (t.outcome === 'degraded') return { text: '降级收尾' + (t.reason ? `（${t.reason}）` : ''), cls: 'warn' };
  if (t.reason && t.reason !== 'natural' && t.reason !== 'selfReport') return { text: '已停止（' + t.reason + '）', cls: 'warn' };
  return { text: '完成', cls: 'ok' };
}
const AUDIT_LABELS: Record<string, string> = {
  selfReport: '自报完成',
  'audit-pass': '审计通过',
  'audit-continue': '审计退回',
  'audit-fail-open': '审计放行',
  'evidence-gate': '证据门',
};

export function RunMetrics(): ReactElement {
  const [data, setData] = useState<MetricsRun | null>(null);
  useEffect(() => {
    void rpc.call<MetricsRun>(RPC.metricsRun, {}).then(setData).catch(() => undefined);
  }, []);

  if (!data) return <div className="settings-pane"><div className="notice">加载中…</div></div>;
  const { totals, turns, tools } = data;
  const auditTotals: Record<string, number> = {};
  for (const t of turns) for (const [k, v] of Object.entries(t.audits)) auditTotals[k] = (auditTotals[k] ?? 0) + v;
  const auditTotal = Object.values(auditTotals).reduce((s, v) => s + v, 0);

  return (
    <div className="settings-pane">
      <div className="settings-pane-title">运行指标</div>
      <div className="notice">从事件日志聚合（零额外采集）——回答"这轮跑得健康吗 / 哪个工具常被误用 / 护栏拦了多少"。</div>

      <div className="stat-cards">
        <div className="stat-card"><b>{fmt(totals.turns)}</b><span>任务轮次</span></div>
        <div className="stat-card"><b>{fmt(totals.tokens)}</b><span>累计 token</span></div>
        <div className="stat-card"><b>{totals.avgSteps}</b><span>平均步数 / 轮</span></div>
        <div className="stat-card"><b>{fmt(totals.toolCalls)}<i className="m-fail">{totals.toolFail > 0 ? ` · ${totals.toolFail} 失败` : ''}</i></b><span>工具调用</span></div>
        <div className="stat-card"><b>{totals.guardrails}<i className="m-fail">{totals.injection > 0 ? ` · 注入 ${totals.injection}` : ''}{totals.dangerous > 0 ? ` · 危险命令 ${totals.dangerous}` : ''}</i></b><span>护栏拦截</span></div>
        <div className="stat-card"><b>{fmt(totals.memoryRecalls)}</b><span>记忆召回</span></div>
      </div>

      {auditTotal > 0 ? (
        <div className="usage-card">
          <b>完成协议裁决分布（最近 {turns.length} 轮）</b>
          <div className="m-bars">
            {Object.entries(auditTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
              <div key={k} className="m-bar-row">
                <span className="m-bar-label">{AUDIT_LABELS[k] ?? k}</span>
                <div className="m-bar-track"><div className="m-bar-fill" style={{ width: `${Math.round((v / auditTotal) * 100)}%` }} /></div>
                <span className="m-bar-val">{v}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="usage-card">
        <b>最近任务轮（{turns.length} 轮，按时间倒序）</b>
        <div className="m-table-head m-row">
          <span>任务</span><span>步数</span><span>token</span><span>耗时</span><span>终局</span>
        </div>
        {turns.slice(0, 20).map((t) => {
          const o = outcomeLabel(t);
          return (
            <div className="m-row" key={t.threadId + ':' + t.steps + ':' + t.firstTs}>
              <span className="m-title" title={t.title}>{t.title}</span>
              <span className="m-num">{t.steps}</span>
              <span className="m-num">{fmt(t.tokens)}</span>
              <span className="m-num">{dur(t.wallMs)}</span>
              <span className={`m-outcome ${o.cls}`} title={t.reason ?? ''}>{o.text}</span>
            </div>
          );
        })}
        {turns.length === 0 ? <div className="notice">还没有任务轮记录。</div> : null}
      </div>

      {tools.length > 0 ? (
        <div className="usage-card">
          <b>工具使用统计</b>
          <div className="m-table-head m-row">
            <span>工具</span><span>调用</span><span>失败</span><span>平均耗时</span>
          </div>
          {tools.map((t) => (
            <div className="m-row" key={t.name}>
              <span className="m-title">{t.name}</span>
              <span className="m-num">{t.calls}</span>
              <span className={'m-num' + (t.fail > 0 ? ' m-fail' : '')}>{t.fail}</span>
              <span className="m-num">{t.avgMs >= 1000 ? (t.avgMs / 1000).toFixed(1) + ' 秒' : t.avgMs + ' ms'}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

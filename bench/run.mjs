// Loomery 行为基准集驱动——CDP 直调 RPC，逐任务跑 agent，记录四项指标：
//   完成与否（证据门裁决：loopTerminated.reason ∈ natural/selfReport 且地面真值通过）
//   工具调用次数（toolRequested）/ usageTokens（usageDelta 合计，按模型分档）/ 步数（stepCompleted）
// 用法：node bench/run.mjs <label>   （label：baseline / optimized …，产出 bench/results/<label>.json）
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS } from './tasks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const label = process.argv[2] || 'baseline';
const PORT = 9351;
const TASK_TIMEOUT_MS = 240_000; // 单任务看门狗
const POLL_MS = 1000;
const END_GRACE_MS = 2000; // 轮结束宽限（等 cheap 档提炼/审计尾流落事件）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killElectron() {
  try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }
}

// ---------- 1. 探针 userData（真实模型配置 + 审批全 auto 无人值守） ----------
const benchBase = path.join(os.tmpdir(), 'loomery-bench-ws');
fs.rmSync(benchBase, { recursive: true, force: true });
fs.mkdirSync(benchBase, { recursive: true });

const ud = path.join(os.tmpdir(), `loomery-bench-${label}`);
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
for (const f of ['config.json', 'secrets.enc', 'Local State']) {
  const src = path.join(REPO, '.loomery-data', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(ud, f));
}
const cfgPath = path.join(ud, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.onboardingDone = true;
cfg.approval = { read: 'auto', write: 'auto', execute: 'auto' }; // 无人值守；危险命令仍被内核强制 ask（任务集不含危险命令）
cfg.workspaceRoots = [benchBase];
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
const modelId = cfg.models?.main?.modelId || 'unknown';

// ---------- 2. 启动应用 + CDP ----------
killElectron();
const child = spawn('pnpm', ['exec', 'electron', '.', `--remote-debugging-port=${PORT}`], {
  cwd: path.join(REPO, 'packages', 'shell'),
  env: { ...process.env, LOOMERY_USER_DATA: ud },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});

let ws = null;
let seq = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('CDP 超时 ' + method)); } }, 60000);
  });
}
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval 异常: ' + (r.exceptionDetails.exception?.description || '').slice(0, 300));
  return r.result?.value;
}

// 页面上下文里直调 RPC（preload 暴露 window.loomery.invoke）
const invoke = (channel, payload) => evalJs(`window.loomery.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload ?? null)})`);

function countEnds(events) {
  return events.filter((e) => e.type === 'turnCompleted' || e.type === 'turnCancelled').length;
}

function metrics(events) {
  const steps = events.filter((e) => e.type === 'stepCompleted').length;
  const tools = events.filter((e) => e.type === 'toolRequested').length;
  let inputTokens = 0;
  let outputTokens = 0;
  const tokensByModel = {};
  for (const e of events) {
    if (e.type !== 'usageDelta') continue;
    inputTokens += e.payload.inputTokens || 0;
    outputTokens += e.payload.outputTokens || 0;
    const m = e.payload.model || 'unknown';
    tokensByModel[m] = (tokensByModel[m] || 0) + (e.payload.inputTokens || 0) + (e.payload.outputTokens || 0);
  }
  const term = [...events].reverse().find((e) => e.type === 'loopTerminated');
  return {
    steps,
    tools,
    inputTokens,
    outputTokens,
    tokensByModel,
    reason: term?.payload?.reason ?? null,
    audits: events.filter((e) => e.type === 'completionAudit').map((e) => e.payload.verdict),
    approvals: events.filter((e) => e.type === 'approvalRequired').length,
    guardrails: events.filter((e) => e.type === 'guardrailTriggered').length,
    errors: events.filter((e) => e.type === 'error').map((e) => String(e.payload.message || '').slice(0, 160)),
  };
}

/** 轮询直到 Turn 结束（自动决策挂起审批）；看门狗超时返回 timedOut */
async function waitForTurnEnd(threadId, n0, deadline) {
  const decided = new Set();
  for (;;) {
    const events = await invoke('thread.export', { threadId });
    for (const e of events) {
      const id = e.payload?.approvalId;
      if (e.type === 'approvalRequired' && id && !decided.has(id)) {
        decided.add(id);
        await invoke('approval.decide', { approvalId: id, decision: { kind: 'approved' } }).catch(() => undefined);
      }
    }
    if (countEnds(events) > n0) {
      await sleep(END_GRACE_MS); // 等提炼/审计尾流
      return { timedOut: false, events: await invoke('thread.export', { threadId }) };
    }
    if (Date.now() > deadline) return { timedOut: true, events };
    await sleep(POLL_MS);
  }
}

(async () => {
  // 等 CDP page target
  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = list.find((t) => t.type === 'page' && !/devtools/.test(t.url)) || null;
      if (target) break;
    } catch { /* 未就绪 */ }
    await sleep(500);
  }
  if (!target) throw new Error('CDP page target 未就绪');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连接失败')); });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const { res, rej } = pending.get(d.id);
      pending.delete(d.id);
      d.error ? rej(new Error(d.error.message)) : res(d.result);
    }
  };
  await send('Runtime.enable', {});
  await send('Page.enable', {});

  // 等 runtime 就绪（thread.list 通了 = 组合根 RPC 全挂好）
  let ready = false;
  for (let i = 0; i < 90; i++) {
    try {
      const r = await invoke('thread.list', null);
      if (Array.isArray(r)) { ready = true; break; }
    } catch { /* 启动中 */ }
    await sleep(1000);
  }
  if (!ready) throw new Error('runtime RPC 未就绪');
  // 等渲染层桥就绪：mountEditorBridge 在 React effect 注册——过早 send 会让 editor provider
  // 的 main→渲染消息无人接收（10s 超时防线兜底，此处等待避免首任务吃超时降级）
  for (let i = 0; i < 60; i++) {
    if (await evalJs(`!!(document.querySelector('.composer-card textarea') || document.querySelector('textarea'))`)) break;
    await sleep(500);
  }
  await sleep(1000);
  // 预热轮：验证模型/事件管线 + 预热连接；失败即中止（不让首个正式任务当探雷）
  const warm = await invoke('thread.create', { title: 'warmup', workspaceRoot: benchBase });
  await invoke('thread.send', { threadId: warm.threadId, text: '只回复两个字：就绪', mode: 'edit' });
  let warmOk = false;
  const warmDeadline = Date.now() + 90_000;
  for (;;) {
    const evs = await invoke('thread.export', { threadId: warm.threadId });
    if (evs.some((e) => e.type === 'turnCompleted' || e.type === 'turnCancelled')) { warmOk = true; break; }
    if (Date.now() > warmDeadline) break;
    await sleep(1000);
  }
  if (!warmOk) throw new Error('预热轮失败——模型/管线不可用，中止基准跑批');
  await invoke('thread.delete', { threadId: warm.threadId }).catch(() => undefined);
  console.log('[bench] 预热轮通过');
  console.log(`[bench] label=${label} model=${modelId} tasks=${TASKS.length}`);

  const results = [];
  for (let i = 0; i < TASKS.length; i++) {
    const task = TASKS[i];
    const wsDir = path.join(benchBase, task.id);
    fs.rmSync(wsDir, { recursive: true, force: true });
    fs.mkdirSync(wsDir, { recursive: true });
    for (const [rel, content] of Object.entries(task.seed)) {
      const p = path.join(wsDir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
    }

    let rec;
    try {
      const { threadId } = await invoke('thread.create', { title: task.id, workspaceRoot: wsDir });
      const n0 = countEnds(await invoke('thread.export', { threadId }));
      const t0 = Date.now();
      await invoke('thread.send', { threadId, text: task.prompt, mode: 'edit' });
      const { timedOut, events } = await waitForTurnEnd(threadId, n0, Date.now() + TASK_TIMEOUT_MS);
      if (timedOut) {
        await invoke('thread.cancel', { threadId }).catch(() => undefined);
        await sleep(3000);
      }
      const m = metrics(events);
      if (timedOut) m.reason = 'timeout-harness';
      const wallMs = Date.now() - t0;

      // 地面真值（独立于 agent 自述）
      let verified = false;
      let verifyDetail = '';
      try {
        const v = task.verify(wsDir);
        verified = !!v.ok;
        verifyDetail = String(v.detail || '').slice(0, 200);
      } catch (err) {
        verifyDetail = String(err instanceof Error ? err.message : err).slice(0, 200);
      }
      const claimed = !timedOut && (m.reason === 'natural' || m.reason === 'selfReport');
      const done = claimed && verified;
      rec = {
        id: task.id, category: task.category, title: task.title,
        done, claimed, verified,
        reason: m.reason, steps: m.steps, tools: m.tools,
        inputTokens: m.inputTokens, outputTokens: m.outputTokens,
        tokens: m.inputTokens + m.outputTokens, tokensByModel: m.tokensByModel,
        wallMs, approvals: m.approvals, guardrails: m.guardrails,
        audits: m.audits, errors: m.errors, verifyDetail,
      };
      await invoke('thread.delete', { threadId }).catch(() => undefined); // 顺带实证新 deleteThread 链路
    } catch (err) {
      rec = {
        id: task.id, category: task.category, title: task.title,
        done: false, claimed: false, verified: false,
        reason: 'harness-error', steps: 0, tools: 0, inputTokens: 0, outputTokens: 0, tokens: 0,
        tokensByModel: {}, wallMs: 0, approvals: 0, guardrails: 0, audits: [],
        errors: [String(err instanceof Error ? err.message : err).slice(0, 200)], verifyDetail: '',
      };
    }
    results.push(rec);
    console.log(
      `[${i + 1}/${TASKS.length}] ${rec.id} → done=${rec.done} claimed=${rec.claimed} verified=${rec.verified} ` +
      `reason=${rec.reason} steps=${rec.steps} tools=${rec.tools} tokens=${rec.tokens} wall=${(rec.wallMs / 1000).toFixed(0)}s`,
    );
  }

  // ---------- 汇总 ----------
  const sum = (f) => results.reduce((a, r) => a + (r[f] || 0), 0);
  const byCategory = {};
  for (const r of results) {
    byCategory[r.category] ??= { count: 0, done: 0, steps: 0, tokens: 0 };
    byCategory[r.category].count += 1;
    byCategory[r.category].done += r.done ? 1 : 0;
    byCategory[r.category].steps += r.steps;
    byCategory[r.category].tokens += r.tokens;
  }
  const tokensByModel = {};
  for (const r of results) for (const [m, v] of Object.entries(r.tokensByModel || {})) tokensByModel[m] = (tokensByModel[m] || 0) + v;
  const out = {
    label,
    schemaVersion: 1,
    date: new Date().toISOString(),
    commit: (() => { try { return execSync('git rev-parse --short HEAD', { cwd: REPO, encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })(),
    model: modelId,
    config: { approval: 'all-auto', taskTimeoutMs: TASK_TIMEOUT_MS },
    totals: {
      count: results.length,
      done: results.filter((r) => r.done).length,
      claimed: results.filter((r) => r.claimed).length,
      verified: results.filter((r) => r.verified).length,
      steps: sum('steps'), tools: sum('tools'),
      inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), tokens: sum('tokens'),
      wallMs: sum('wallMs'),
      avgSteps: +(sum('steps') / results.length).toFixed(1),
      avgTokens: Math.round(sum('tokens') / results.length),
      avgWallMs: Math.round(sum('wallMs') / results.length),
      tokensByModel,
      timeouts: results.filter((r) => r.reason === 'timeout-harness').length,
      harnessErrors: results.filter((r) => r.reason === 'harness-error').length,
    },
    byCategory,
    tasks: results,
  };
  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${label}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log('[bench] 完成：', JSON.stringify(out.totals, null, 2));
  console.log('[bench] 结果已写入', outPath);
})()
  .then(() => { killElectron(); process.exit(0); })
  .catch((err) => {
    console.error('[bench] FAILED:', err instanceof Error ? err.stack : err);
    killElectron();
    process.exit(1);
  });

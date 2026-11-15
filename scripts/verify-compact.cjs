// 手动压缩真机探针（合成线程，不碰真实任务数据）：
// ① 探针 userData = 真实 config（cheap 档模型真实可用）+ sessions + 合成 4 轮线程 JSONL
// ② UI：点开探针任务 → 点容量圈 → 断言"立即压缩历史"按钮存在且可用
// ③ RPC：thread.compact → 断言返回 ok/tokensSaved → 断言聊天流出现 🗜 已压缩历史 notice
// ④ 落盘证据：合成线程 JSONL 追加了 memoryCompressed 事件
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

// ---- 探针 userData：config + sessions + 合成线程 ----
const realRoot = path.join(repoRoot, '.loomery-data');
const ud = path.join(os.tmpdir(), 'loomery-probe-compact');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
if (fs.existsSync(path.join(realRoot, 'config.json'))) {
  fs.copyFileSync(path.join(realRoot, 'config.json'), path.join(ud, 'config.json'));
}
// secrets.enc 一并拷贝（safeStorage 机器绑定，同机可解）——否则 cheap 档无密钥→摘要为空
if (fs.existsSync(path.join(realRoot, 'secrets.enc'))) {
  fs.copyFileSync(path.join(realRoot, 'secrets.enc'), path.join(ud, 'secrets.enc'));
}
// Local State 必须同拷：本 Electron 的 os_crypt 密钥按 userData 绑定（Local State 的 os_crypt.encrypted_key），
// 只拷 secrets.enc 不拷 Local State → 解密必败 → 服务端"Invalid API Key"（探针排障大坑）
if (fs.existsSync(path.join(realRoot, 'Local State'))) {
  fs.copyFileSync(path.join(realRoot, 'Local State'), path.join(ud, 'Local State'));
}
const sessDir = path.join(realRoot, 'sessions');
if (fs.existsSync(sessDir)) {
  for (const f of fs.readdirSync(sessDir)) fs.copyFileSync(path.join(sessDir, f), path.join(ud, 'sessions', f));
}

// 合成 4 轮（4 组 > keepRecentGroups 2 → 手动压缩必压最老 2 组）
const tid = 'thread_probe_compact';
const now = Date.now();
const lines = [];
let seq = 0;
const ev = (type, payload, extra = {}) => {
  seq += 1;
  lines.push(JSON.stringify({ seq, id: crypto.randomUUID(), schemaVersion: 1, ts: now + seq * 100, threadId: tid, type, payload, ...extra }));
};
ev('threadCreated', { threadId: tid, title: '探针-手动压缩' });
const turnTexts = [
  '第一轮：讨论项目目录结构设计，src 下按 features 分模块还是按层分模块，列举了两者的优缺点和适用场景。',
  '第二轮：确定了构建工具选型，对比 Vite 与 esbuild 的冷启动速度与插件生态，最终选择 Vite 并记录理由。',
  '第三轮：编写了状态管理草案，讨论 store 拆分粒度、selector 缓存与派生数据的更新时机。',
  '第四轮：评审了错误边界方案，确定渲染崩溃的自愈策略为限三次每分钟自动重载。',
];
for (let i = 1; i <= 4; i++) {
  ev('turnStarted', { turnId: `turn_probe_${i}`, mode: 'edit', model: 'main', userMessageId: `msg_probe_u_${i}`, userText: turnTexts[i - 1] }, { turnId: `turn_probe_${i}` });
  ev('textDelta', { messageId: `msg_probe_a_${i}`, text: `收到。关于「${turnTexts[i - 1]}」我的分析与结论如下：先给出背景与约束，再列出三个候选方案的对比表，最后给出推荐与理由，并标注了两个需要用户确认的开放问题。` }, { turnId: `turn_probe_${i}` });
}
fs.writeFileSync(path.join(ud, 'sessions', `${tid}.jsonl`), lines.join('\n') + '\n', 'utf8');
console.log('[runner] synthetic thread written: ' + tid + ' (' + lines.length + ' events)');

// ---- 渲染层探针 ----
const probe = `(async () => {
  const out = (tag, v) => console.log('[drag-log][compact-probe] ' + tag + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  try {
    for (let i = 0; i < 30 && !window.loomery; i++) await sleep(200);
    for (let i = 0; i < 30 && !q('.task-item'); i++) await sleep(200);
    // ① 打开探针任务
    const item = qa('.task-item').find((el) => el.textContent.includes('探针-手动压缩'));
    if (!item) { out('F', { fail: 'probe task not in sidebar' }); return; }
    item.click();
    await sleep(1200);
    // ② 点容量圈 → 断言手动压缩按钮
    const ring = q('.ctx-ring');
    if (!ring) { out('F', { fail: 'ctx-ring not found' }); return; }
    ring.click();
    await sleep(400);
    const panel = q('.ctx-panel');
    const btn = qa('.ctx-panel button').find((b) => b.textContent.includes('立即压缩历史'));
    out('B', { panelOpen: !!panel, compactBtn: !!btn, disabled: btn ? btn.disabled : null });
    if (!btn) { out('F', { fail: 'compact button missing' }); return; }
    // ③ RPC 手动压缩
    const threads = await window.loomery.invoke('thread.list', {});
    const me = threads.find((t) => t.title === '探针-手动压缩');
    if (!me) { out('F', { fail: 'probe thread not in thread.list' }); return; }
    const r = await window.loomery.invoke('thread.compact', { threadId: me.id });
    out('C', { rpcResult: r });
    // ④ 聊天流出现 🗜 notice
    let noticed = false;
    for (let i = 0; i < 20; i++) { if (qa('.notice').some((n) => n.textContent.includes('已压缩历史'))) { noticed = true; break; } await sleep(400); }
    out('N', { noticeShown: noticed, notices: qa('.notice').map((n) => n.textContent.trim()).slice(0, 5) });
    // ⑤ 落盘证据（引擎中立，ADR-0023 后事件在 SQLite）：thread.export 读回断言 memoryCompressed + GC 直方图
    const events = await window.loomery.invoke('thread.export', { threadId: me.id }).catch(() => []);
    const histogram = {};
    for (const e of events) { const t = e.type; histogram[t] = (histogram[t] ?? 0) + 1; }
    const mc = events.find((e) => e.type === 'memoryCompressed');
    out('D', { totalEvents: events.length, histogram, memoryCompressed: mc ? { seq: mc.seq, saved: mc.payload.tokensSaved, summaryLen: mc.payload.summary.length, compressedIds: mc.payload.compressedMessageIds.length } : null });
    return 'ok';
  } catch (e) { out('F', { fail: String(e) }); }
})()`;

const shellDir = path.join(repoRoot, 'packages', 'shell');
const child = spawn('pnpm', ['exec', 'electron', '.'], {
  cwd: shellDir,
  env: { ...process.env, LOOMERY_USER_DATA: ud, LOOMERY_SELF_SHOT: path.join(ud, 'probe.png'), LOOMERY_SELF_SHOT_PROBE: probe },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
setTimeout(() => {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
  try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }
  const logPath = path.join(ud, 'electron-debug.log');
  const probeLines = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.includes('compact-probe')).join('\n')
    : '';
  console.log('---- 探针结果 ----');
  console.log(probeLines || '(无 compact-probe 记录)');
  process.exit(0);
}, 55000);

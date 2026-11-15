// Viewer 四件套真机探针：hex/csv/html沙箱/pdf + GBK 解码
// fixtures 写入工作区 tmp 子目录（探针结束清理），经 loomeryDev.openInEditor 逐个打开并断言 DOM
const { spawn, execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* 无残留 */ }

const realRoot = path.join(repoRoot, '.loomery-data');
const ud = path.join(os.tmpdir(), 'loomery-probe-viewers');
fs.rmSync(ud, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'sessions'), { recursive: true });
for (const f of ['config.json', 'secrets.enc', 'Local State']) {
  if (fs.existsSync(path.join(realRoot, f))) fs.copyFileSync(path.join(realRoot, f), path.join(ud, f));
}
const cfg = JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'));
const root = (cfg.workspaceRoots ?? [])[0] ?? repoRoot;
const fx = path.join(root, '.viewers-probe-tmp');
fs.rmSync(fx, { recursive: true, force: true });
fs.mkdirSync(fx, { recursive: true });
// GBK「中文」= D6 D0 CE C4
fs.writeFileSync(path.join(fx, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
fs.writeFileSync(path.join(fx, 'data.csv'), '姓名,年龄,城市\n张三,30,北京\n李四,25,上海\n"带,引号",9,广州\n');
fs.writeFileSync(path.join(fx, 'page.html'), '<h1>预览测试</h1><script>window.__scriptRan = true;</script><p>段落</p>');
const bin = Buffer.alloc(96);
bin.write('BINARY-MAGIC', 0);
bin[32] = 0; bin[64] = 0xde; bin[65] = 0xad;
fs.writeFileSync(path.join(fx, 'blob.bin'), bin);
// 大 PDF（~1.2MB）：验证 app-pdf 协议流式供给无大小上限（旧 base64 方案会撞 16MB RPC/512KB cap）
const stream = 'BT /F1 12 Tf 40 700 Td (Loomery PDF streaming probe) Tj ET\n';
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj\n4 0 obj<</Length ' + (stream.length * 9000) + '>>stream\n' + stream.repeat(9000) + 'endstream\nendobj\nxref\n0 5\ntrailer<</Size 5/Root 1 0 R>>\n%%EOF', 'utf8');
fs.writeFileSync(path.join(fx, 'doc.pdf'), pdf);
console.log('[runner] big pdf: ' + (pdf.length / 1e6).toFixed(2) + 'MB');
console.log('[runner] fixtures written to ' + fx);

const open = (p) => `window.loomeryDev.openInEditor(${JSON.stringify(p)})`;

const probe = `(async () => {
  const out = (t, v) => console.log('[drag-log][viewer-probe] ' + t + ' ' + JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const waitTab = async (name) => { for (let i = 0; i < 25; i++) { if (qa('.tab-name').some((t) => t.textContent === name)) return true; await sleep(300); } return false; };
  try {
    for (let i = 0; i < 40 && !window.loomery; i++) await sleep(200);
    await sleep(400);
    // ① GBK 解码：Monaco 模型全文应含「中文」
    ${open(path.join(fx, 'gbk.txt'))};
    if (!(await waitTab('gbk.txt'))) { out('F', { fail: 'gbk tab missing' }); return; }
    await sleep(400);
    const gbkText = window.loomeryDev.getActiveModelText?.() ?? '';
    out('GBK', { decoded: gbkText.includes('中文'), text: JSON.stringify(gbkText.slice(0, 20)) });
    // ② CSV
    ${open(path.join(fx, 'data.csv'))};
    if (!(await waitTab('data.csv'))) {
      out('F', { fail: 'csv tab missing', tabs: qa('.tab-name').map((t) => t.textContent), hosts: { editor: !!q('.editor-host'), viewer: !!q('.viewer-shell'), stage: !!q('.editor-stage') } });
      return;
    }
    await sleep(400);
    const csvRows = qa('.csv-view tbody tr').length;
    const csvHead = qa('.csv-view th').map((t) => t.textContent);
    out('CSV', { rows: csvRows, head: csvHead, bodyHasQuote: qa('.csv-view td').some((t) => t.textContent === '带,引号') });
    // ③ HTML 沙箱
    ${open(path.join(fx, 'page.html'))};
    if (!(await waitTab('page.html'))) { out('F', { fail: 'html tab missing' }); return; }
    await sleep(400);
    const iframe = q('.html-preview');
    out('HTML', { present: !!iframe, sandbox: iframe?.getAttribute('sandbox') === '', srcDocHasH1: (iframe?.getAttribute('srcdoc') ?? '').includes('<h1>') });
    // ④ 二进制 hex
    ${open(path.join(fx, 'blob.bin'))};
    if (!(await waitTab('blob.bin'))) { out('F', { fail: 'bin tab missing' }); return; }
    await sleep(400);
    const hexRows = qa('.hex-row').length;
    const hexAscii = qa('.hex-ascii').map((t) => t.textContent).join('|');
    out('HEX', { rows: hexRows, hasMagic: hexAscii.includes('BINARY-MAGIC'), hasNulDot: qa('.hex-row')[2]?.querySelector('.hex-ascii')?.textContent.includes('.') });
    // ⑤ PDF
    ${open(path.join(fx, 'doc.pdf'))};
    if (!(await waitTab('doc.pdf'))) { out('F', { fail: 'pdf tab missing' }); return; }
    await sleep(600);
    const pdfFrame = q('.pdf-preview');
    const pdfSrc = pdfFrame?.getAttribute('src') ?? '';
    // 强断言：协议 URL 可被渲染层 fetch 到全部字节（流式供给 + CSP 放行的双重验证）
    let fetchedBytes = -1;
    try { const resp = await fetch(pdfSrc); const buf2 = await resp.arrayBuffer(); fetchedBytes = buf2.byteLength; } catch { fetchedBytes = -2; }
    out('PDF', { present: !!pdfFrame, protocolSrc: pdfSrc.startsWith('app-pdf://'), fetchedBytes });
  } catch (e) { out('F', { fail: String(e) }); }
})()`;

const child = spawn('pnpm', ['exec', 'electron', '.'], {
  cwd: path.join(repoRoot, 'packages', 'shell'),
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
  const lines = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.includes('viewer-probe'))
    : [];
  console.log(lines.join('\n') || '(无输出)');
  try { fs.rmSync(fx, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}, 40000);

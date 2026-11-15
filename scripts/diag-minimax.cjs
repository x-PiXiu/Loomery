// MiniMax 诊断：本机解密该供应商密钥（不落明文）→ 拉取该账号可用模型清单
const { app, safeStorage } = require('electron');
app.whenReady().then(async () => {
  app.setPath('userData', 'E:/workspace/Demo/MyDemo/Loomery/.loomery-data');
  await new Promise((r) => setTimeout(r, 300));
  const fs = require('fs');
  const raw = JSON.parse(fs.readFileSync('E:/workspace/Demo/MyDemo/Loomery/.loomery-data/secrets.enc', 'utf8'));
  const enc = raw['key_prov_qxpw6z'];
  try {
    const key = safeStorage.decryptString(Buffer.from(enc, 'base64'));
    const https = require('https');
    const req = https.request({ host: 'api.minimaxi.com', path: '/v1/models', method: 'GET', headers: { Authorization: 'Bearer ' + key } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          const ids = (j.data || j.models || []).map((m) => m.id || m.model);
          console.log('[minimax-diag] HTTP', res.statusCode, '可用模型:', JSON.stringify(ids));
        } catch { console.log('[minimax-diag] HTTP', res.statusCode, '非 JSON:', body.slice(0, 200)); }
      });
    });
    req.on('error', (e) => console.log('[minimax-diag] 网络错误:', e.message));
    req.end();
  } catch (e) { console.log('[minimax-diag] 解密失败:', String(e).slice(0, 80)); }
  setTimeout(() => app.exit(0), 8000);
});

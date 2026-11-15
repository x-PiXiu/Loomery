// 密钥诊断（不打印明文）：对比真实/探针 userData 的 secrets.enc 可解密性
const { app, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ud = process.argv[2];
// os_crypt 密钥按 userData 绑定（Local State）：先切 userData 再 ready，模拟真实应用的解密上下文
if (ud) app.setPath('userData', ud);
app.whenReady().then(() => {
  const file = path.join(ud, 'secrets.enc');
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log('[diag] LOAD-FAIL ' + String(e)); }
  console.log('[diag] ud=' + ud + ' encAvailable=' + safeStorage.isEncryptionAvailable() + ' keys=' + Object.keys(all).length + ' electron=' + process.versions.electron);
  // roundtrip：本进程加密→解密（判断 safeStorage 与自身协调性）
  try {
    const rt = safeStorage.encryptString('probe-roundtrip');
    console.log('[diag] roundtrip=' + (safeStorage.decryptString(rt) === 'probe-roundtrip' ? 'OK' : 'MISMATCH') + ' blobHead=' + JSON.stringify(rt.subarray(0, 6).toString('utf8')));
  } catch (e) { console.log('[diag] roundtrip=FAIL ' + String(e)); }
  for (const [k, raw] of Object.entries(all)) {
    let len = 0;
    try { len = safeStorage.decryptString(Buffer.from(raw, 'base64')).length; console.log('[diag] ' + k + ' decrypt=OK len=' + len); } catch (e) { console.log('[diag] ' + k + ' decrypt=FAIL ' + String(e)); }
  }
  app.exit(0);
});

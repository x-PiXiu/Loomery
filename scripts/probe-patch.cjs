// 一次性补丁：给 self-shot 点击加菜单 DOM 状态探测（诊断用）
const fs = require('fs');
const p = 'packages/shell/src/main/index.ts';
let s = fs.readFileSync(p, 'utf8');
const anchor = ".then((r) => console.log(`[self-shot-click] ${String(r)}`))";
if (s.includes('[menu-state]')) {
  console.log('present');
  process.exit(0);
}
const inject = [
  '.then((r) => {',
  '        console.log(`[self-shot-click] ${String(r)}`);',
  '        return mainWindow?.webContents',
  '          .executeJavaScript("(function(){ const m = document.querySelector(\'.bc-menu\'); if (!m) return \'menu-not-in-dom\'; const rect = m.getBoundingClientRect(); const cs = getComputedStyle(m); return \'rect=\' + JSON.stringify([rect.x, rect.y, rect.width, rect.height]) + \' display=\' + cs.display + \' visibility=\' + cs.visibility + \' z=\' + cs.zIndex + \' items=\' + m.querySelectorAll(\'button\').length; })()")',
  '          .then((r2) => console.log("[menu-state]", String(r2)));',
  '      })',
].join('\n');
if (!s.includes(anchor)) { console.log('anchor miss'); process.exit(1); }
s = s.replace(anchor, inject);
fs.writeFileSync(p, s);
console.log('patched');

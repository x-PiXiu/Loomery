// 修复 drag-log 落文件语句（避开 bash 转义）
const fs = require('fs');
const p = 'packages/shell/src/main/index.ts';
let s = fs.readFileSync(p, 'utf8');
let changed = false;

if (!s.includes('appendFileSync')) {
  s = s.replace("import { writeFileSync } from 'node:fs';", "import { appendFileSync, writeFileSync } from 'node:fs';");
  changed = true;
}
const bad = "        appendFileSync(join(app.getPath('userData'), 'electron-debug.log'), );";
const good = "        appendFileSync(join(app.getPath('userData'), 'electron-debug.log'), new Date().toISOString() + ' ' + String(message) + '\\n');";
if (s.includes(bad)) {
  s = s.replace(bad, good);
  changed = true;
}
fs.writeFileSync(p, s);
console.log(changed ? 'fixed' : 'nothing to fix');

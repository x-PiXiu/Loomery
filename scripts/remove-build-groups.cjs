// 删除废弃的 buildGroups 函数
const fs = require('fs');
const p = 'packages/ui/src/views/chat/Composer.tsx';
const lines = fs.readFileSync(p, 'utf8').split('\n');
const startIdx = lines.findIndex((l) => l.startsWith('function buildGroups('));
if (startIdx === -1) { console.log('absent'); process.exit(0); }
let closeIdx = -1;
for (let i = startIdx; i < lines.length; i++) {
  if (lines[i] === '}') { closeIdx = i; break; }
}
if (closeIdx === -1) { console.log('close miss'); process.exit(1); }
lines.splice(startIdx, closeIdx - startIdx + 1);
// 顺带删掉其后多余空行
while (lines[startIdx] === '' && lines[startIdx + 1] === '') lines.splice(startIdx, 1);
fs.writeFileSync(p, lines.join('\n'));
console.log('buildGroups removed');

// 删除已废弃的 leftStyle/midStyle 定义（bash ${} 转义问题，改脚本）
const fs = require('fs');
const p = 'packages/ui/src/app/App.tsx';
let s = fs.readFileSync(p, 'utf8');
const before = s.split('\n').length;
s = s.split('\n').filter((l) => !l.includes('const leftStyle =') && !l.includes('const midStyle =')).join('\n');
fs.writeFileSync(p, s);
console.log('removed', before - s.split('\n').length, 'lines');

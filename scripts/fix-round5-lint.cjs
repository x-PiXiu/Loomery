// 清理：writeFileSync 未用（shell e2e? 定位）+ Composer workMs 改为读取 turnDurations
const fs = require('fs');

// 1) 定位 writeFileSync 未用文件
for (const f of ['packages/shell/src/main/index.ts', 'packages/shell/src/main/e2e.ts']) {
  let s = fs.readFileSync(f, 'utf8');
  if (s.includes('writeFileSync') && !/writeFileSync\(/.test(s.replace(/import[^;]*writeFileSync[^;]*;/, ''))) {
    // import 行里有但正文没调用——从 import 移除
    s = s.replace('import { appendFileSync, writeFileSync } from \'node:fs\';', "import { appendFileSync } from 'node:fs';")
         .replace("import { writeFileSync } from 'node:fs';\n", '');
    // writeFileSync 可能在单独 import 行
    s = s.replace("import { writeFileSync } from 'node:fs';\n", '');
    fs.writeFileSync(f, s);
    console.log(f, 'cleaned');
  }
}

// 2) Composer workMs：现在不再直接使用（时长走 turnDurations），删 hook
const cpPath = 'packages/ui/src/views/chat/Composer.tsx';
let cp = fs.readFileSync(cpPath, 'utf8');
if (cp.includes('const workMs = useRuntime')) {
  cp = cp.replace('  const workMs = useRuntime((s) => s.workMs);\n', '');
  fs.writeFileSync(cpPath, cp);
  console.log('workMs hook removed');
}
console.log('done');

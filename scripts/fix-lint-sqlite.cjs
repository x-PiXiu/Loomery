// lint 修复（引号风格匹配实际文件）
const fs = require('fs');

const fix = (p, pairs) => {
  let s = fs.readFileSync(p, 'utf8');
  for (const [from, to] of pairs) {
    if (!s.includes(from)) { console.log('MISS in ' + p + ': ' + from.slice(0, 60)); continue; }
    s = s.split(from).join(to);
  }
  fs.writeFileSync(p, s, 'utf8');
};

fix('packages/adapters/memory-store/src/sqlite/sqlite-store.test.ts', [
  ["import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';", "import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';"],
]);
fix('packages/adapters/memory-store/src/task-facts.ts', [
  ["import { mkdir, writeFile, stat } from 'node:fs/promises';", "import { mkdir, writeFile } from 'node:fs/promises';"],
]);
fix('packages/shell/src/main/bootstrap.ts', [
  ["let sqliteDb: import('node:sqlite').DatabaseSync | undefined;", 'let sqliteDb: DatabaseSync | undefined;'],
  ['import { app, BrowserWindow } from \'electron\';', 'import { app, BrowserWindow } from \'electron\';\nimport type { DatabaseSync } from \'node:sqlite\';'],
]);
console.log('done');

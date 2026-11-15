// ADR-0020 接线：domain barrel / fs-tools 转发 / pipeline diffProposed 发射
const fs = require('fs');

// 1) domain barrel
const barrelPath = 'packages/domain/src/rules/index.ts';
let b = fs.readFileSync(barrelPath, 'utf8');
if (!b.includes('./diff')) {
  b = b.replace("export * from './path-normalize';", "export * from './path-normalize';\nexport * from './diff';");
  fs.writeFileSync(barrelPath, b);
  console.log('barrel ok');
} else console.log('barrel present');

// 2) fs-tools diff-engine 转发
fs.writeFileSync(
  'packages/adapters/fs-tools/src/diff-engine.ts',
  '// ADR-0020：纯 diff 规则已下沉 domain（渲染层 DiffPane 与适配器共用），此处转发保持兼容\n' +
    "export { validateHunks, applyHunks, makeHunkProposal, makeFullFileProposal } from '@loomery/domain';\n",
);
console.log('fs-tools forward ok');

// 3) pipeline：approvalRequired 前发射 diffProposed
const pipePath = 'packages/agent-core/src/tools/pipeline.ts';
let p = fs.readFileSync(pipePath, 'utf8');
const anchor = '        const approvalId = randomUUID();';
if (!p.includes("emit('diffProposed'")) {
  if (!p.includes(anchor)) { console.log('pipeline anchor miss'); process.exit(1); }
  p = p.replace(anchor, "        if (proposal) emit('diffProposed', { proposal });\n" + anchor);
  fs.writeFileSync(pipePath, p);
  console.log('diffProposed emit ok');
} else console.log('emit present');

console.log('done');

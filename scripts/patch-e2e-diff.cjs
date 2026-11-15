// E2E 驱动扩展：审批卡出现后先点"查看完整 diff"验证 DiffPane，再接受
const fs = require('fs');
const p = 'packages/shell/src/main/e2e.ts';
let s = fs.readFileSync(p, 'utf8');

const oldBlock = [
  "        log('step2 wait approval card');",
  '        let clicked = false;',
  '        for (let i = 0; i < 60; i++) {',
  '          await sleep(2000);',
  '          const r = await js(',
  "            `(function(){ const b = document.querySelector('.card.approval .actions button.primary'); if (b) { b.click(); return 'clicked'; } return 'waiting'; })()`,",
  '          );',
  "          if (r === 'clicked') { clicked = true; log(`approval clicked at poll ${i}`); break; }",
  '        }',
  "        if (!clicked) { log('FAIL: no approval card within 120s'); return; }",
].join('\n');

const newBlock = [
  "        log('step2 wait approval card');",
  '        let found = false;',
  '        for (let i = 0; i < 60; i++) {',
  '          await sleep(2000);',
  '          const r = await js(',
  "            `(function(){ const c = document.querySelector('.card.approval'); if (c) return 'found'; return 'waiting'; })()`,",
  '          );',
  "          if (r === 'found') { found = true; log(`approval card at poll ${i}`); break; }",
  '        }',
  "        if (!found) { log('FAIL: no approval card within 120s'); return; }",
  '',
  "        // step2b: 点'查看完整 diff'验证 DiffPane",
  "        log('step2b open diff pane');",
  '        await js(',
  "          `(function(){ const b = [...document.querySelectorAll('.card.approval .actions button')].find((x) => x.textContent.includes('diff')); if (b) { b.click(); return 'clicked'; } return 'none'; })()`,",
  '        );',
  '        await sleep(1500);',
  '        const diffHost = await js(',
  "          `(function(){ const d = document.querySelector('.diff-host'); return d && d.querySelector('.monaco-diff-editor, .monaco-editor') ? 'diff-open' : 'no-diff'; })()`,",
  '        );',
  "        log(`diff pane state: ${diffHost}`);",
  "        if (diffHost !== 'diff-open') { log('FAIL: diff pane did not open'); }",
  '',
  "        // step2c: 接受",
  "        log('step2c accept');",
  '        await js(',
  "          `document.querySelector('.card.approval .actions button.primary').click(); 'accepted'`,",
  '        );',
  "        log('approval clicked');",
].join('\n');

if (s.includes(oldBlock)) {
  s = s.replace(oldBlock, newBlock);
  fs.writeFileSync(p, s);
  console.log('e2e diff step ok');
} else {
  console.log('e2e block miss');
  process.exit(1);
}

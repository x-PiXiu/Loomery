// DiffPane 第四步：审批卡/汇总卡跳转按钮 + CSS
const fs = require('fs');
let ok = 0;

// ---- Composer ----
const cpPath = 'packages/ui/src/views/chat/Composer.tsx';
let cp = fs.readFileSync(cpPath, 'utf8');

// 1) imports：applyHunks（domain 纯规则）+ openInDiff/resolveOriginalContent
if (!cp.includes('resolveOriginalContent')) {
  cp = cp.replace(
    "import { openInEditor } from '../../gateway/editorBus';",
    "import { openInEditor, openInDiff, resolveOriginalContent } from '../../gateway/editorBus';\nimport { applyHunks } from '@loomery/domain';\nimport type { DiffProposal } from '@loomery/domain';",
  );
  console.log('imports ok');
} else console.log('imports present');

// 2) 打开 diff 的公共逻辑
if (!cp.includes('function openProposalDiff')) {
  const anchor = 'function copyText(text: string): void {';
  const inject = [
    '/** 从提案打开 DiffPane：原始=快照/当前文件，修改=applyHunks（domain 纯规则） */',
    'async function openProposalDiff(turnId: string | undefined, proposal: DiffProposal): Promise<void> {',
    '  const original = await resolveOriginalContent(turnId, proposal.path);',
    '  if (original === null) return;',
    '  const modified = applyHunks(original, proposal.hunks);',
    '  openInDiff(proposal.path, original, modified);',
    '}',
    '',
    anchor,
  ].join('\n');
  cp = cp.replace(anchor, inject);
  ok++;
  console.log('helper ok');
} else console.log('helper present');

// 3) ApprovalCard：查看完整 diff 按钮
const cardOld = "      {item.resolved === null ? (\n        <div className=\"actions\">\n          <button className=\"primary\" onClick={() => void decide('approved')}>接受 (Ctrl+Enter)</button>\n          <button onClick={() => void decide('rejected')}>拒绝 (Esc)</button>\n        </div>\n      ) : null}";
const cardNew = "      {item.proposal ? (\n        <div className=\"actions\">\n          <button onClick={() => void openProposalDiff(item.turnId, item.proposal!)}>查看完整 diff</button>\n        </div>\n      ) : null}\n      {item.resolved === null ? (\n        <div className=\"actions\">\n          <button className=\"primary\" onClick={() => void decide('approved')}>接受 (Ctrl+Enter)</button>\n          <button onClick={() => void decide('rejected')}>拒绝 (Esc)</button>\n        </div>\n      ) : null}";
if (cp.includes(cardOld)) {
  cp = cp.replace(cardOld, cardNew);
  ok++;
  console.log('approval card ok');
} else console.log('approval card miss');

// 4) 汇总卡：查看变更按钮（读 runtime proposals）
cp = cp.replace(
  '  const turnUsage = useRuntime((s) => s.turnUsage);',
  '  const turnUsage = useRuntime((s) => s.turnUsage);\n  const proposals = useRuntime((s) => s.proposals);',
);
const sumOld = "            <button\n              disabled={checkpoint?.turnId !== turnChanges?.turnId}\n              title={checkpoint?.turnId === turnChanges?.turnId ? '回滚本轮全部改动' : '本轮没有可回滚的 checkpoint'}\n              onClick={undoTurn}\n            >\n              撤销\n            </button>";
const sumNew = "            <span className=\"summary-actions\">\n              <button\n                onClick={() => {\n                  for (const file of turnChanges?.files ?? []) {\n                    const proposal = proposals[file];\n                    if (proposal) void openProposalDiff(turnChanges?.turnId, proposal);\n                  }\n                }}\n              >\n                查看变更\n              </button>\n              <button\n                disabled={checkpoint?.turnId !== turnChanges?.turnId}\n                title={checkpoint?.turnId === turnChanges?.turnId ? '回滚本轮全部改动' : '本轮没有可回滚的 checkpoint'}\n                onClick={undoTurn}\n              >\n                撤销\n              </button>\n            </span>";
if (cp.includes(sumOld)) {
  cp = cp.replace(sumOld, sumNew);
  ok++;
  console.log('summary card ok');
} else console.log('summary card miss');

fs.writeFileSync(cpPath, cp);

// ---- CSS ----
const cssPath = 'packages/ui/src/theme.css';
let css = fs.readFileSync(cssPath, 'utf8');
if (!css.includes('.diff-host')) {
  css += [
    '',
    '/* ================= DiffPane（Monaco DiffEditor 标签页） ================= */',
    '.diff-host { flex: 1; min-height: 0; }',
    '.summary-actions { margin-left: auto; display: inline-flex; gap: 8px; }',
    '.turn-summary .actions button, .turn-summary .summary-actions button { background: var(--bg); border: 1px solid var(--border-strong); color: var(--text); border-radius: 6px; padding: 3px 12px; cursor: pointer; font-size: 12px; }',
  ].join('\n');
  fs.writeFileSync(cssPath, css);
  ok++;
  console.log('css ok');
} else console.log('css present');

console.log('steps done:', ok);

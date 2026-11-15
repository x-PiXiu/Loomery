// openProposalDiff 加失败日志（落到 electron-debug.log 便于 e2e 读取）
const fs = require('fs');
const p = 'packages/ui/src/views/chat/Composer.tsx';
let s = fs.readFileSync(p, 'utf8');
const old = `async function openProposalDiff(turnId: string | undefined, proposal: DiffProposal): Promise<void> {
  const original = await resolveOriginalContent(turnId, proposal.path);
  if (original === null) return;
  const modified = applyHunks(original, proposal.hunks);
  openInDiff(proposal.path, original, modified);
}`;
const now = `async function openProposalDiff(turnId: string | undefined, proposal: DiffProposal): Promise<void> {
  try {
    const original = await resolveOriginalContent(turnId, proposal.path);
    if (original === null) {
      console.error('[drag-log][diff] original resolve failed for ' + proposal.path);
      return;
    }
    const modified = applyHunks(original, proposal.hunks);
    openInDiff(proposal.path, original, modified);
    console.log('[drag-log][diff] opened for ' + proposal.path);
  } catch (err) {
    console.error('[drag-log][diff] failed: ' + String(err));
  }
}`;
if (s.includes(old)) {
  s = s.replace(old, now);
  fs.writeFileSync(p, s);
  console.log('instrumented');
} else {
  console.log('miss');
  process.exit(1);
}

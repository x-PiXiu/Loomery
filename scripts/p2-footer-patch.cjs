// P2 聊天流页脚：每轮问答独立 footer（原因 + 该轮用量），移除底部全局 footer
const fs = require('node:fs');
const p = 'packages/ui/src/views/chat/Composer.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) { console.error('MISS: ' + a.slice(0, 70)); process.exit(1); }
  s = s.replace(a, b);
};

// ① 替换轮级 stopnote 为完整每轮页脚
rep(
  `    // 轮级停止标记：这一轮不是自然结束（手动停止/出错）时，在该轮末尾就地说明——
    // 此前只有"最新一轮"有页脚提示，历史轮被停止只表现为回复戛然而止
    const endReason = work.turnEnds[turnId];
    if (endReason && endReason !== 'natural') {
      out.push(
        <div key={\`stop:\${turnId}:\${i}\`} className="turn-stopnote">
          {endReason === 'userCancelled' ? '⏹ 本轮已手动停止，回复可能不完整' : \`⏹ 本轮已停止（\${endReason}），回复可能不完整\`}
        </div>,
      );
    }`,
  `    // 每轮问答独立页脚：结束原因 + 该轮自己的 ↑↓ 用量（一个问答一个，非任务累计）
    const endReason = work.turnEnds[turnId];
    const u = work.turnUsageByTurn[turnId];
    if (endReason || u) {
      const stopped = endReason && endReason !== 'natural';
      out.push(
        <div key={\`footer:\${turnId}:\${i}\`} className={\`turn-footer \${stopped ? 'warn' : ''}\`}>
          <span className="tf-reason">
            {stopped ? \`⏹ 本轮已停止（\${endReason}），回复可能不完整\` : '本轮完成'}
          </span>
          {u ? (
            <span className="tf-usage" title={\`输入 \${u.inputTokens} tokens · 输出 \${u.outputTokens} tokens\`}>
              ↑{u.inputTokens.toLocaleString()} ↓{u.outputTokens.toLocaleString()} · {u.steps} 步
            </span>
          ) : null}
        </div>,
      );
    }`,
);

// ② 移除底部全局 footer（finalSummary 归属最后一轮，见 ③）
const footerStart = s.indexOf('        {terminated && phase === \'idle\' ? (');
if (footerStart < 0) { console.error('global footer not found'); process.exit(1); }
const footerEnd = s.indexOf(') : null}', footerStart) + ') : null}'.length;
s = s.slice(0, footerStart) + s.slice(footerEnd);
// 清理残留空行
s = s.replace(/\n{3,}/g, '\n\n');

// ③ 最后一轮页脚附加 finalSummary：在 per-turn footer 里判断是否最后一个有 reason 的轮
rep(
  `          <span className="tf-reason">
            {stopped ? \`⏹ 本轮已停止（\${endReason}），回复可能不完整\` : '本轮完成'}
          </span>`,
  `          <span className="tf-reason">
            {stopped ? \`⏹ 本轮已停止（\${endReason}），回复可能不完整\` : '本轮完成'}
          </span>
          {work.terminated?.finalSummary && turnId === lastReasonTurnId ? <span className="tf-summary">{work.terminated.finalSummary}</span> : null}`,
);
// lastReasonTurnId 计算（在 while 循环前求出：最后一个有 turnEnds 记录的 turnId）
rep(
  `  const out: ReactElement[] = [];
  let i = 0;
  while (i < items.length) {`,
  `  // 最后一个有结束记录的轮（finalSummary 归属它）
  const lastReasonTurnId = Object.keys(work.turnEnds).at(-1);
  const out: ReactElement[] = [];
  let i = 0;
  while (i < items.length) {`,
);
fs.writeFileSync(p, s);
console.log('per-turn footer done');

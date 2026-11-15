// balanceFences 回归锁：2026-11-13 真实事故——合法 bash 注释 `# 服务端` 被规则②强拆成
// 空代码块 + 巨字标题 + 内容碎片化（用户截图驱动）。前视修复后必须保持原文结构。
import { describe, expect, it } from 'vitest';
import { balanceFences } from './markdown';

describe('balanceFences（围栏配平 + 标题容缺）', () => {
  const REAL_CASE = [
    '**已全部关闭干净。**',
    '',
    '##关闭结果',
    '',
    '| 项目 | 状态 |',
    '|---|---|',
    '| 服务端 | ✅ 已停止 |',
    '',
    '## 两点说明',
    '',
    '需要重启时：',
    '',
    '```bash',
    '# 服务端',
    'cd testLoomery/portfolio/server && go run ./cmd/api',
    '',
    '# 客户端',
    'cd testLoomery/portfolio/web && node node_modules/vite/bin/vite.js --port 5173',
    '```',
    '',
    '（用 `node ...` 而不是 `npx vite`。）',
  ].join('\n');

  it('真实事故回归：fence 配对平衡 + 内含 # 注释 → 结构原样保留（不插闭合）', () => {
    const out = balanceFences(REAL_CASE);
    // fence 行仍恰好 2 条（开+闭），bash 注释行未被拆出代码块
    const fenceLines = out.split('\n').filter((l) => /^ {0,3}```/.test(l));
    expect(fenceLines).toHaveLength(2);
    expect(out).toContain('```bash\n# 服务端\ncd testLoomery/portfolio/server');
    // 规则③附带修复：##关闭结果（缺空格）→ 合法标题
    expect(out).toContain('## 关闭结果');
  });

  it('真漏闭合：fence 开启后到末尾无围栏 + 出现标题 → 在标题前补闭合', () => {
    const md = ['正文开头：', '', '```bash', 'echo hello', '', '## 这是标题', '正文继续……'].join('\n');
    const outLines = balanceFences(md).split('\n');
    const idx = outLines.findIndex((l) => l === '## 这是标题');
    // 标题行之前的最近一行必须是补上的闭合围栏
    expect(outLines[idx - 1]).toBe('```');
    // 补闭合后标题成为真标题、后续不再被吞
    expect(outLines.slice(idx).join('\n')).toContain('## 这是标题\n正文继续');
  });

  it('fence 后方还有围栏（正常闭合在前方）→ 不中途插闭合', () => {
    const md = ['```python', 'if x:', '    pass', '## 后方有闭合——这只是内容', '```', 'done'].join('\n');
    // python fence 内 `## ...` 行：后方有 ```（fenceAhead=true）→ 不插闭合
    expect(balanceFences(md)).toBe(md);
  });

  it('奇数围栏 → 末尾补闭合（规则①）', () => {
    const md = ['a', '```js', 'code();'].join('\n');
    expect(balanceFences(md).endsWith('```')).toBe(true);
  });

  it('容缺空格：##关闭结果 → ## 关闭结果（非围栏区）', () => {
    const md = '##关闭结果\n正文';
    expect(balanceFences(md)).toContain('## 关闭结果');
  });

  it('围栏区不触发容缺空格（fence 内 # 开头是内容）', () => {
    const md = ['```bash', '##not-a-heading', '```'].join('\n');
    expect(balanceFences(md)).toBe(md);
  });

  it('混合文档结构保持：代码块 + 正文 + 再一个代码块', () => {
    const md = ['前文', '```bash', '# 注释一', 'cmd1', '```', '中段文字', '```', 'data', '```', '尾文'].join('\n');
    expect(balanceFences(md)).toBe(md);
  });
});

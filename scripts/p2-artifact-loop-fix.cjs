// P2 产物捕获修复：指针死循环三根因——①read_artifact/read_skill 结果再捕获（inline 豁免）②阈值 1500 过低（→6000 可配置）③错误提示一闪而过（上批已修）
const fs = require('node:fs');
const R = 'packages/';
const patch = (file, pairs) => {
  let s = fs.readFileSync(R + file, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) { console.error('MISS in ' + file + ': ' + a.slice(0, 70)); process.exit(1); }
    s = s.replace(a, b);
  }
  fs.writeFileSync(R + file, s);
  console.log('ok: ' + file);
};

// 1) ports：ToolResult.inline（结果必须内联，禁止产物捕获）
patch('ports/src/tool-handler.ts', [
  [`  /** read_skill 成功 → skillUsed（记账，ADR-0022） */
  skillUsed?: { name: string; scope: 'user' | 'project' };`, `  /** read_skill 成功 → skillUsed（记账，ADR-0022） */
  skillUsed?: { name: string; scope: 'user' | 'project' };
  /** ADR-0021 修复：结果必须内联返回（read_artifact/read_skill 等"取回内容"类工具）——管道跳过产物捕获，否则模型陷入指针死循环 */
  inline?: boolean;`],
]);

// 2) domain：limits.artifactThresholdTokens 可配置（只增）
patch('domain/src/config.ts', [
  [`  limits: {
    maxSteps: number;`, `  limits: {
    maxSteps: number;
    /** 产物捕获阈值（tokens）：超过才存为产物、观察留指针；缺省 6000（P2 修复：原 1500 过低） */
    artifactThresholdTokens?: number;`],
]);

// 3) pipeline：inline 豁免
patch('agent-core/src/tools/pipeline.ts', [
  [`    const artifacts = this.config.artifacts;
    const cap = this.config.artifactThresholdTokens ?? 0;
    if (artifacts && result.content.length > 0 && decideArtifactCapture(result.content, cap).capture) {`, `    const artifacts = this.config.artifacts;
    const cap = this.config.artifactThresholdTokens ?? 0;
    // inline=true（read_artifact/read_skill 等"取回内容"类结果）永不捕获——否则模型陷入指针死循环（2026-10-28 修复）
    if (artifacts && !result.inline && result.content.length > 0 && decideArtifactCapture(result.content, cap).capture) {`],
]);

// 4) fs-tools：read_artifact / read_skill 结果标 inline
patch('adapters/fs-tools/src/memory-tools.ts', [
  [`      const content = await deps.artifacts.get(hash, offset ?? 0);
      if (content.length === 0) return { ok: false, content: \`产物 \${hash} 不存在或偏移越界。\`, affectedPaths: [] };
      return { ok: true, content, affectedPaths: [] };`, `      const content = await deps.artifacts.get(hash, offset ?? 0);
      if (content.length === 0) return { ok: false, content: \`产物 \${hash} 不存在或偏移越界。\`, affectedPaths: [] };
      // 取回内容必须内联：再捕获会导致同内容同 hash 的指针死循环
      return { ok: true, content, affectedPaths: [], inline: true };`],
  [`        const manifest = (await deps.skills.scan()).find((x) => x.name === name);
        const body = await deps.skills.readBody(name);
        if (deps.confirmed && manifest?.scope === 'project') await deps.confirmed.confirm(name);
        return {
          ok: true,
          content: body,`, `        const manifest = (await deps.skills.scan()).find((x) => x.name === name);
        const body = await deps.skills.readBody(name);
        if (deps.confirmed && manifest?.scope === 'project') await deps.confirmed.confirm(name);
        return {
          ok: true,
          content: body,
          inline: true,`],
]);

// 5) bootstrap：阈值 1500 → config 可配置 + 缺省 6000
patch('shell/src/main/bootstrap.ts', [
  '      artifactThresholdTokens: 1500,', '      artifactThresholdTokens: config.limits.artifactThresholdTokens ?? 6000,',
]);
console.log('done');

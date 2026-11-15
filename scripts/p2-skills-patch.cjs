// P2 技能设置：skillSources（外部来源扫描）/ skillImport（目录复制导入）+ SkillIndexProvider 停用谓词
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

// 1) envelope
patch('adapters/ipc-bridge/src/envelope.ts', [
  ["  skillBody: 'skill.body',", "  skillBody: 'skill.body',\n  skillSources: 'skill.sources',\n  skillImport: 'skill.import',"],
]);

// 2) bootstrap：谓词接线 + 两个 RPC（os.homedir 扫描已知外部来源）
patch('shell/src/main/bootstrap.ts', [
  [`      new BriefProvider(briefs),
      new MemoryRecallProvider(store),
      new SkillIndexProvider(skills),`, `      new BriefProvider(briefs),
      new MemoryRecallProvider(store),
      new SkillIndexProvider(skills, (name) => config.skills?.disabled?.includes(name) ?? false),`],
  [`  // ---- 产物 / 技能面板（谦卑视图数据源，ADR-0021/0022）----`, `  // ---- 技能导入（外部来源：Claude Code / ZCode / Agents 的 skills 目录）----
  rpc.handle(RPC.skillSources, () => {
    const homedir = os.homedir();
    const sources = [
      { id: 'claude-code', label: 'Claude Code', dir: join(homedir, '.claude', 'skills') },
      { id: 'zcode', label: 'ZCode', dir: join(homedir, '.zcode', 'skills') },
      { id: 'agents', label: 'Agents', dir: join(homedir, '.agents', 'skills') },
    ];
    return Promise.all(sources.map(async (s) => {
      const reg = new FsSkillRegistry(s.dir);
      const skills = await reg.scan().catch(() => []);
      return { id: s.id, label: s.label, dir: s.dir, count: skills.length, skills };
    }));
  });
  rpc.handle(RPC.skillImport, (p) => {
    const { sourceDir, names } = p as { sourceDir: string; names: string[] };
    const destRoot = join(userData, 'skills');
    mkdirSync(destRoot, { recursive: true });
    let imported = 0;
    const errors: string[] = [];
    for (const name of names) {
      const src = join(String(sourceDir), name);
      const dest = join(destRoot, name);
      if (!existsSync(join(src, 'SKILL.md'))) { errors.push(name + '：缺少 SKILL.md'); continue; }
      if (existsSync(dest)) { errors.push(name + '：已存在同名技能'); continue; }
      try {
        cpSync(src, dest, { recursive: true, force: false });
        imported += 1;
      } catch (err) {
        errors.push(name + '：' + String(err instanceof Error ? err.message : err));
      }
    }
    return { imported, errors };
  });
  // ---- 产物 / 技能面板（谦卑视图数据源，ADR-0021/0022）----`],
]);
// os import
let s = fs.readFileSync(R + 'shell/src/main/bootstrap.ts', 'utf8');
if (!s.includes("from 'node:os'")) {
  s = s.replace("import { dirname, join } from 'node:path';", "import { dirname, join } from 'node:path';\nimport { homedir } from 'node:os';");
  fs.writeFileSync(R + 'shell/src/main/bootstrap.ts', s);
}
console.log('homedir import:', s.includes("homedir"));
console.log('batch done');

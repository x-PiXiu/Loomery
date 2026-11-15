// P2 技能删除：skill.delete RPC（仅全局可删）+ envelope + 联动清理 disabled 标记
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

patch('adapters/ipc-bridge/src/envelope.ts', [
  ["  skillImport: 'skill.import',", "  skillImport: 'skill.import',\n  skillDelete: 'skill.delete',"],
]);

patch('shell/src/main/bootstrap.ts', [
  [`  rpc.handle(RPC.skillBody, (p) => {
    const { name } = p as { name: string };
    return skills.readBody(String(name));
  });`, `  rpc.handle(RPC.skillBody, (p) => {
    const { name } = p as { name: string };
    return skills.readBody(String(name));
  });
  // 删除技能：仅限全局（userData/skills 是我们管理的副本）；项目级归 git、内置归安装目录，拒绝删除
  rpc.handle(RPC.skillDelete, (p) => {
    const { name } = p as { name: string };
    const target = skills.scan().then(undefined);
    return target as never; // 占位——下方异步实现覆盖
  });`],
]);

// 上面的占位同步实现无法 async scan——替换为异步真实现
let s = fs.readFileSync(R + 'shell/src/main/bootstrap.ts', 'utf8');
s = s.replace(
  `  rpc.handle(RPC.skillDelete, (p) => {
    const { name } = p as { name: string };
    const target = skills.scan().then(undefined);
    return target as never; // 占位——下方异步实现覆盖
  });`,
  `  rpc.handle(RPC.skillDelete, async (p) => {
    const { name } = p as { name: string };
    const all = await skills.scan();
    // 只删用户级（全局）技能；同名校验防止误删项目级
    const m = all.find((x) => x.name === String(name) && x.scope === 'user');
    if (!m) return { ok: false, error: '技能不存在或非全局技能（项目级/内置技能不在此删除）' };
    const dirName = m.dirName ?? m.name;
    if (dirName.includes('..') || dirName.includes('/') || dirName.includes('\\\\')) return { ok: false, error: '非法技能目录名' };
    const dest = join(userData, 'skills', dirName);
    if (!existsSync(dest)) return { ok: false, error: '技能目录不存在' };
    rmSync(dest, { recursive: true, force: true });
    // 联动清理停用标记（技能已不存在，墓碑无意义）
    if (config.skills?.disabled?.includes(String(name))) {
      config.skills = { disabled: config.skills.disabled.filter((n) => n !== String(name)) };
      await configStore.save({ skills: config.skills });
    }
    return { ok: true };
  });`,
);
fs.writeFileSync(R + 'shell/src/main/bootstrap.ts', s);
console.log('done');

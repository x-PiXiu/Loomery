// P2 技能导入修复：勾选/导入按 dirName（frontmatter name 可与目录名不同）+ 单文件形态 + 错误常驻
const fs = require('node:fs');
const p = 'packages/ui/src/views/settings/SkillsSettings.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) { console.error('MISS: ' + a.slice(0, 70)); process.exit(1); }
  s = s.replace(a, b);
};

// 1) togglePick 以 dirName 为键
rep(
  `  const togglePick = (dir: string, name: string): void => {
    setPicked((prev) => {
      const next = new Set(prev);
      const key = dir + '::' + name;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };`,
  `  const togglePick = (dir: string, dirName: string): void => {
    setPicked((prev) => {
      const next = new Set(prev);
      const key = dir + '::' + dirName;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };`,
);
// 2) doImport：按 dirName 组包 + skills 数组载荷 + 错误常驻（只有零错误才自动关）
rep(
  `  const doImport = async (): Promise<void> => {
    const byDir = new Map<string, string[]>();
    for (const key of picked) {
      const idx = key.indexOf('::');
      if (idx < 0) continue;
      const dir = key.slice(0, idx);
      const name = key.slice(idx + 2);
      byDir.set(dir, [...(byDir.get(dir) ?? []), name]);
    }
    let imported = 0;
    const errors: string[] = [];
    for (const [dir, names] of byDir) {
      const r = await rpc.call<{ imported: number; errors: string[] }>(RPC.skillImport, { sourceDir: dir, names }).catch((err: unknown) => ({
        imported: 0,
        errors: [String(err)],
      }));
      imported += r.imported;
      errors.push(...r.errors);
    }
    setNote(\`已导入 \${imported} 个技能\` + (errors.length > 0 ? \`；跳过：\${errors.join('；')}\` : ''));
    setPicked(new Set());
    if (imported > 0) {
      onImported();
      setTimeout(() => { setNote(''); onClose(); }, 1200);
    }
  };`,
  `  const doImport = async (): Promise<void> => {
    const byDir = new Map<string, { dirName: string; singleFile?: boolean }[]>();
    const allSkills = (sources ?? []).flatMap((s) => s.skills.map((k) => ({ dir: s.dir, k })));
    for (const key of picked) {
      const idx = key.indexOf('::');
      if (idx < 0) continue;
      const dir = key.slice(0, idx);
      const dirName = key.slice(idx + 2);
      const sk = allSkills.find((x) => x.dir === dir && x.k.dirName === dirName);
      if (!sk) continue;
      byDir.set(dir, [...(byDir.get(dir) ?? []), { dirName, singleFile: sk.k.singleFile }]);
    }
    let imported = 0;
    const errors: string[] = [];
    for (const [dir, skills] of byDir) {
      const r = await rpc.call<{ imported: number; errors: string[] }>(RPC.skillImport, { sourceDir: dir, skills }).catch((err: unknown) => ({
        imported: 0,
        errors: [String(err)],
      }));
      imported += r.imported;
      errors.push(...r.errors);
    }
    setNote('已导入 ' + imported + ' 个技能' + (errors.length > 0 ? '；跳过 ' + errors.length + ' 个：' + errors.join('；') : ''));
    setPicked(new Set());
    if (imported > 0) onImported();
    // 有跳过项时保持对话框打开让用户看到原因；全部成功才自动关
    if (imported > 0 && errors.length === 0) setTimeout(() => { setNote(''); onClose(); }, 1000);
  };`,
);
// 3) 全选/行勾选/键全改 dirName（k.dirName）
rep(
  `                  <input
                    type="checkbox"
                    checked={s.skills.every((k) => picked.has(s.dir + '::' + k.name))}
                    onChange={(e) => {
                      setPicked((prev) => {
                        const next = new Set(prev);
                        for (const k of s.skills) {
                          const key = s.dir + '::' + k.name;
                          if (existing.has(k.name)) continue; // 已存在的跳过
                          if (e.target.checked) next.add(key);
                          else next.delete(key);
                        }
                        return next;
                      });
                    }}
                  />`,
  `                  <input
                    type="checkbox"
                    checked={s.skills.filter((k) => !existing.has(k.name)).length > 0 && s.skills.filter((k) => !existing.has(k.name)).every((k) => picked.has(s.dir + '::' + k.dirName))}
                    onChange={(e) => {
                      setPicked((prev) => {
                        const next = new Set(prev);
                        for (const k of s.skills) {
                          const key = s.dir + '::' + k.dirName;
                          if (existing.has(k.name)) continue; // 已存在的跳过
                          if (e.target.checked) next.add(key);
                          else next.delete(key);
                        }
                        return next;
                      });
                    }}
                  />`,
);
rep(
  `                    {s.skills.map((k) => {
                      const key = s.dir + '::' + k.name;
                      const dup = existing.has(k.name);
                      return (
                        <label key={key} className={\`import-skill-row \${dup ? 'dup' : ''}\`}>
                          <input type="checkbox" disabled={dup} checked={picked.has(key)} onChange={() => togglePick(s.dir, k.name)} />
                          <span className="skill-name"><b>{k.name}</b>{dup ? <span className="skill-off-tag">已存在</span> : null}</span>
                          <span className="skill-desc">{k.description}</span>
                        </label>
                      );
                    })}`,
  `                    {s.skills.map((k) => {
                      const key = s.dir + '::' + k.dirName;
                      const dup = existing.has(k.name);
                      return (
                        <label key={key} className={\`import-skill-row \${dup ? 'dup' : ''}\`}>
                          <input type="checkbox" disabled={dup} checked={picked.has(key)} onChange={() => togglePick(s.dir, k.dirName)} />
                          <span className="skill-name"><b>{k.name}</b>{k.singleFile ? <span className="skill-off-tag">单文件</span> : null}{dup ? <span className="skill-off-tag">已存在</span> : null}</span>
                          <span className="skill-desc">{stripMarkdown(k.description)}</span>
                        </label>
                      );
                    })}`,
);
fs.writeFileSync(p, s);
console.log('dialog fixed');

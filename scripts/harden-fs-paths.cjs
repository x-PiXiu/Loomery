// fs-tools 五 handler 的路径防御性归一化（纵深防御：绕过管道直调也安全）
const fs = require('fs');
const base = 'packages/adapters/fs-tools/src/';
let touched = 0;

function patch(file, from, to) {
  const p = base + file;
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes(from)) {
    s = s.replace(from, to);
    fs.writeFileSync(p, s);
    touched++;
    console.log(file, 'ok');
  } else console.log(file, 'pattern miss:', from.slice(0, 60));
}

patch('read-file.ts',
  "      const { path } = input as { path: string };",
  "      const path = toAbsolute((input as { path: string }).path, ctx.workspaceRoots);");

patch('list-dir.ts',
  "      const { path } = input as { path: string };",
  "      const path = toAbsolute((input as { path: string }).path, ctx.workspaceRoots);");

patch('search-text.ts',
  "      const { path, pattern, maxResults = 200 } = input as {\n        path: string;\n        pattern: string;\n        maxResults?: number;\n      };",
  "      const raw = input as { path: string; pattern: string; maxResults?: number };\n      const path = toAbsolute(raw.path, ctx.workspaceRoots);\n      const { pattern, maxResults = 200 } = raw;");

patch('write-file.ts',
  "      const { path, content } = input as { path: string; content: string };\n      const old = await readFile(path, 'utf8').catch(() => null);",
  "      const raw = input as { path: string; content: string };\n      const path = toAbsolute(raw.path, ctx.workspaceRoots);\n      const old = await readFile(path, 'utf8').catch(() => null);\n      const content = raw.content;");

// write-file handler 里第二处解构
(function () {
  const p = base + 'write-file.ts';
  let s = fs.readFileSync(p, 'utf8');
  const old = "    handler: async (input, ctx) => {\n      const { path, content } = input as { path: string; content: string };\n      if (ctx.turnId) await checkpoint.snapshot(ctx.turnId, path);\n      await writeFile(path, content, 'utf8');";
  const now = "    handler: async (input, ctx) => {\n      const raw = input as { path: string; content: string };\n      const path = toAbsolute(raw.path, ctx.workspaceRoots);\n      const content = raw.content;\n      if (ctx.turnId) await checkpoint.snapshot(ctx.turnId, path);\n      await writeFile(path, content, 'utf8');";
  if (s.includes(old)) { s = s.replace(old, now); fs.writeFileSync(p, s); console.log('write-file handler ok'); }
  else console.log('write-file handler miss');
})();

// apply-diff prepareApproval + handler
(function () {
  const p = base + 'apply-diff.ts';
  let s = fs.readFileSync(p, 'utf8');
  const a = "      const { path, hunks } = input as { path: string; hunks: Parameters<typeof validateHunks>[1] };\n      const current = await readFile(path, 'utf8').catch(() => null);";
  const b = "      const raw = input as { path: string; hunks: Parameters<typeof validateHunks>[1] };\n      const path = toAbsolute(raw.path, ctx.workspaceRoots);\n      const hunks = raw.hunks;\n      const current = await readFile(path, 'utf8').catch(() => null);";
  if (s.includes(a)) { s = s.replace(a, b); console.log('apply prepare ok'); } else console.log('apply prepare miss');
  const c = "      const { path, hunks } = input as { path: string; hunks: Parameters<typeof applyHunks>[1] };\n      if (ctx.turnId) await checkpoint.snapshot(ctx.turnId, path);";
  const d = "      const rawIn = input as { path: string; hunks: Parameters<typeof applyHunks>[1] };\n      const path = toAbsolute(rawIn.path, ctx.workspaceRoots);\n      const hunks = rawIn.hunks;\n      if (ctx.turnId) await checkpoint.snapshot(ctx.turnId, path);";
  if (s.includes(c)) { s = s.replace(c, d); console.log('apply handler ok'); } else console.log('apply handler miss');
  fs.writeFileSync(p, s);
})();

console.log('touched files:', touched);

#!/usr/bin/env node
// ADR-0006：内核三层（domain/ports/agent-core）框架 import 自检 + 依赖声明合规检查
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CORE_PKGS = ['packages/domain', 'packages/ports', 'packages/agent-core'];
const ALLOWED_DEPS = {
  'packages/domain': [],
  'packages/ports': ['@loomery/domain'],
  'packages/agent-core': ['@loomery/domain', '@loomery/ports'],
};
const FORBIDDEN_IMPORT_RE =
  /\b(?:from|import)\s*['"](electron|electron\/main|electron\/renderer|monaco-editor|@monaco-editor\/react|dockview|dockview-core|ai|@ai-sdk\/[a-z-]+)['"]/g;

const violations = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
    } else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
      const text = readFileSync(full, 'utf8');
      for (const m of text.matchAll(FORBIDDEN_IMPORT_RE)) {
        violations.push(`${full}: 禁止的框架 import "${m[1]}"`);
      }
    }
  }
}

for (const pkg of CORE_PKGS) {
  const srcDir = join(pkg, 'src');
  if (!existsSync(srcDir)) continue;
  walk(srcDir);
  const pkgJson = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  const deps = Object.keys(pkgJson.dependencies ?? {});
  const allowed = ALLOWED_DEPS[pkg] ?? [];
  for (const name of deps) {
    if (!allowed.includes(name)) {
      violations.push(`${pkg}/package.json: 非法依赖 "${name}"（允许: ${allowed.join(', ') || '无'}）`);
    }
  }
}

if (violations.length > 0) {
  console.error('check-imports 失败：');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log('check-imports 通过：内核三层无框架 import，依赖声明合规。');

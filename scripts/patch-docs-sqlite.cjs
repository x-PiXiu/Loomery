// SQLite 迁移 docs 收尾（ADR-0023 已执行）
const fs = require('fs');

// 1) ADR-0023 状态：决策 → 已执行
let adr = fs.readFileSync('docs/10-adr.md', 'utf8');
const anchorA = '## ADR-0023 存储引擎：JSON 先行，SQLite 按触发条件迁移（三迁三留）';
if (!adr.includes(anchorA)) { console.log('ADR anchor missing'); process.exit(1); }
adr = adr.replace(anchorA, anchorA + '\n\n> **状态【已执行，2026-11-01】**：用户决策提前迁移（不等触发条件）。落地：`SqliteMemoryStore`（node:sqlite，WAL；实测 Electron 38 内置可用无需 flag），默认引擎 SQLite，`LOOMERY_STORE=json` 逃生门回退 JSON（旧档归档 `sessions-imported/` 可整体回退）。三迁=events/thread_meta（fold 语义与 JSON 逐字段同构，双路径重放校验测试锁定）/facts/产物索引（`ArtifactIndexBackend` 接缝）；三留=简报 .md/技能 SKILL.md/产物 blob+config/secrets/checkpoints。JSONL→SQLite 导入幂等（uuid 去重+残行跳过+标记防重导）。端口与内核/UI 零改动兑现。');
fs.writeFileSync('docs/10-adr.md', adr, 'utf8');

// 2) docs/11 运行时目录：loomery.db
let ps = fs.readFileSync('docs/11-project-structure.md', 'utf8');
if (!ps.includes('loomery.db')) {
  const anchorP = 'sessions/';
  const idx = ps.indexOf(anchorP);
  if (idx >= 0) {
    ps = ps.slice(0, idx) + 'loomery.db          # SQLite 事件库（ADR-0023：events/thread_meta/facts/artifact_index；WAL）\n  sessions-imported/  # JSONL 迁入 SQLite 后的原始档（保留可回退）\n  ' + ps.slice(idx);
    fs.writeFileSync('docs/11-project-structure.md', ps, 'utf8');
    console.log('docs/11 updated');
  } else {
    console.log('docs/11 anchor missing — skipped');
  }
} else {
  console.log('docs/11 already has loomery.db');
}
console.log('docs done');

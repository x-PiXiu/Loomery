// docs 同步（六项加固批次）
const fs = require('fs');

// 03 常量表：EVENT_SCHEMA_VERSION
let c = fs.readFileSync('docs/03-core-contracts.md', 'utf8');
const anchorC = '| `RESIDENT_THREAD_LIMIT` | 8 |';
if (!c.includes(anchorC)) { console.log('03 anchor missing'); process.exit(1); }
c = c.replace(
  anchorC,
  '| `EVENT_SCHEMA_VERSION` | 1 | 事件信封当前版本（FanoutSink 打戳；解析边界经 migrateEvent 沿链升级，未来版本透传） |\n' + anchorC,
);
fs.writeFileSync('docs/03-core-contracts.md', c, 'utf8');

// 05：ai-sdk-adapter 并发闸 + session 埋点/迁移边界
let m = fs.readFileSync('docs/05-modules.md', 'utf8');
const anchor8 = '## 8. ai-sdk-adapter（模型适配器）';
if (!m.includes(anchor8)) { console.log('05 anchor8 missing'); process.exit(1); }
m = m.replace(
  anchor8,
  anchor8 + '\n\n> **全局并发闸【规范，P2】**：所有模型流（main/cheap、全部任务）经 `Semaphore` 共享名额池（`maxConcurrency`，默认 4）——N 任务并发 busy 不会打爆 API；FIFO 公平排队，排队中被取消以 AbortError 出队。429 治理 = 全局上限 + 单请求退避重试两层。',
);
const anchor7 = '策略落在用例层（`ThreadServiceDeps.residency` 可覆盖），组合根只装配不决策；换存储引擎（ADR-0023）策略不变。';
if (!m.includes(anchor7)) { console.log('05 anchor7 missing'); process.exit(1); }
m = m.replace(
  anchor7,
  anchor7 + '\n  ⑥ **触发器埋点【规范，P2】**：恢复/重放耗时经 `ThreadServiceDeps.metrics.observe` 上报（`metrics.get` RPC 可查：bootMs/seedCount/foldListThreadsMs/hydrate{count,maxMs,slowCount}）；慢恢复（>2s，ADR-0023 触发器②）打 [metrics] 警告——迁移 SQLite 由数据说话，不盲飞。\n  ⑦ **迁移边界【规范，P2】**：JSONL 解析统一经 `migrateEvent`（domain/migrations，追加式步骤表）——旧版本信封沿链升级、未来版本透传；消费方永远只见当前版本。',
);
fs.writeFileSync('docs/05-modules.md', m, 'utf8');
console.log('docs updated');

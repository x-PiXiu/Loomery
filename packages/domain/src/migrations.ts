// 事件信封 schema 迁移框架（#11：schemaVersion 从"有字段"到"有机制"）
// 原则：迁移发生在**解析边界**（JSONL load / 导入包 / RPC 反序列化），消费方永远拿到当前版本；
// 步骤表追加式注册（v1→v2→v3…），up 就地规范化且必须保持 id/seq/threadId 稳定（重放等价性根基）。
import type { LoopEvent } from './event';

/** 当前代码理解的事件信封版本（FanoutSink 打戳 / 迁移链终点都用它） */
export const EVENT_SCHEMA_VERSION = 1;

export interface MigrationStep {
  from: number;
  to: number;
  /** 就地规范化：入参与返回都是裸信封对象（不 throw——坏行由解析层容错兜底） */
  up: (event: Record<string, unknown>) => Record<string, unknown>;
}

const steps: MigrationStep[] = [];

/** 追加一步迁移（v(N)→v(N+1)）；发布新版本时在此登记，旧日志自动升级 */
export function registerMigration(step: MigrationStep): void {
  steps.push(step);
  steps.sort((a, b) => a.from - b.from);
}

/** 已登记的迁移链（测试可注入自定义链） */
export function migrationSteps(): readonly MigrationStep[] {
  return steps;
}

/**
 * 把任意版本的事件信封规范化到 EVENT_SCHEMA_VERSION。
 * - 沿链逐级升级（v1→v2→…）；步骤表只包含当前代码认识的迁移，旧代码不可能"升过头"
 * - 版本缺失按 v1 处理（全部历史日志即 v1）
 * - **未来版本**（旧代码读到新文件）：链上无可匹配步骤 → 保守透传不抛错——消费方按自身能力降级，绝不因版本号丢弃事件
 */
export function migrateEvent(
  raw: Record<string, unknown>,
  chain: readonly MigrationStep[] = steps,
): LoopEvent {
  let version = typeof raw.schemaVersion === 'number' && raw.schemaVersion >= 1 ? raw.schemaVersion : 1;
  let current: Record<string, unknown> = raw;
  let matched = true;
  while (matched) {
    matched = false;
    for (const step of chain) {
      if (step.from === version) {
        current = step.up(current);
        version = step.to;
        matched = true;
        break;
      }
    }
  }
  return current as unknown as LoopEvent;
}

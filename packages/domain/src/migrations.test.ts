// 事件信封迁移框架测试（#11）：沿链升级 / 版本缺失按 v1 / 未来版本透传 / id-seq-threadId 稳定
import { describe, expect, it } from 'vitest';
import { EVENT_SCHEMA_VERSION, migrateEvent, type MigrationStep } from './migrations';

describe('migrateEvent（schema 迁移）', () => {
  const v1to2: MigrationStep = {
    from: 1,
    to: 2,
    up: (e) => ({ ...e, schemaVersion: 2, payload: { ...(e.payload as object), legacy: true } }),
  };
  const v2to3: MigrationStep = {
    from: 2,
    to: 3,
    up: (e) => ({ ...e, schemaVersion: 3 }),
  };

  it('当前版本无链：原样透传', () => {
    const raw = { seq: 1, id: 'a', schemaVersion: 1, ts: 1, threadId: 't', type: 'textDelta', payload: { text: 'x' } };
    expect(migrateEvent(raw, [])).toBe(raw); // 同一引用：零拷贝零变换
  });

  it('沿链逐级升级 v1→v2→v3，id/seq/threadId 保持稳定', () => {
    const raw = { seq: 7, id: 'a', schemaVersion: 1, ts: 1, threadId: 't1', type: 'textDelta', payload: { text: 'x' } };
    const out = migrateEvent(raw, [v1to2, v2to3]);
    expect(out.schemaVersion).toBe(3);
    expect(out.id).toBe('a');
    expect(out.seq).toBe(7);
    expect(out.threadId).toBe('t1');
    expect((out.payload as unknown as { legacy: boolean }).legacy).toBe(true);
  });

  it('版本缺失按 v1 处理（全部历史日志即 v1）', () => {
    const raw = { seq: 1, id: 'a', ts: 1, threadId: 't', type: 'textDelta', payload: {} };
    const out = migrateEvent(raw, [v1to2]);
    expect(out.schemaVersion).toBe(2);
    expect((out.payload as unknown as { legacy: boolean }).legacy).toBe(true);
  });

  it('未来版本（旧代码读新文件）保守透传不抛错', () => {
    const raw = { seq: 1, id: 'a', schemaVersion: 99, ts: 1, threadId: 't', type: 'future', payload: {} };
    const out = migrateEvent(raw, [v1to2]);
    expect(out).toBe(raw);
  });

  it('链中缺口（v2→v3 缺失）停在可达版本', () => {
    const raw = { seq: 1, id: 'a', schemaVersion: 1, ts: 1, threadId: 't', type: 'textDelta', payload: {} };
    const out = migrateEvent(raw, [v1to2, { from: 3, to: 4, up: (e) => e }]);
    expect(out.schemaVersion).toBe(2);
  });

  it('EVENT_SCHEMA_VERSION 与信封当前版本一致', () => {
    expect(EVENT_SCHEMA_VERSION).toBe(1);
  });
});

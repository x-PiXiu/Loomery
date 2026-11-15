// docs/15 完成协议实体层：证据核对/声明解析/审计裁决解析——纯函数表驱动
import { describe, expect, it } from 'vitest';
import {
  checkReportEvidence, checkVerificationBacked, evidenceLedgerDigest, parseAuditVerdict,
  parseCompletionSelfReport, selfReportObservation,
  type EvidenceEntry,
} from './index';

const okCmd: EvidenceEntry = { kind: 'command', ok: true, detail: 'npm run build → exit=0', atStep: 1 };
const failCmd: EvidenceEntry = { kind: 'command', ok: false, detail: 'npm test → exit=1', atStep: 2 };

describe('checkVerificationBacked（证据门机械判定）', () => {
  it('声明验证 + 无成功证据 → 未背书', () => {
    expect(checkVerificationBacked('测试全部通过', [])).toMatchObject({ backed: false });
    expect(checkVerificationBacked('测试通过', [failCmd])).toMatchObject({ backed: false, reason: expect.stringContaining('没有') });
  });
  it('声明验证 + 有成功证据 → 背书', () => {
    expect(checkVerificationBacked('编译成功', [failCmd, okCmd])).toMatchObject({ backed: true });
  });
  it('未做验证声明 → 直接背书（诚实留白不拦）', () => {
    expect(checkVerificationBacked('（本轮为纯讨论，无需验证）', [])).toMatchObject({ backed: true });
  });
  it('checkReportEvidence：verification 留空不拦', () => {
    const r = parseCompletionSelfReport({ summary: 'done', outstanding: [], verification: '', confidence: 'low' })!;
    expect(checkReportEvidence(r, [])).toMatchObject({ backed: true });
  });
});

describe('parseCompletionSelfReport（宽松解析）', () => {
  it('缺 summary → undefined', () => {
    expect(parseCompletionSelfReport({ outstanding: [] })).toBeUndefined();
    expect(parseCompletionSelfReport('not an object')).toBeUndefined();
  });
  it('字段漂移降级取值（outstanding 过滤非字符串/空串、confidence 非法回 high）', () => {
    const r = parseCompletionSelfReport({ summary: '  做完了  ', outstanding: ['a', 42, '', null], verification: 1, confidence: 'extreme' })!;
    expect(r.summary).toBe('做完了');
    expect(r.outstanding).toEqual(['a']);
    expect(r.verification).toBe('');
    expect(r.confidence).toBe('high');
  });
  it('outcome 缺省回 complete / blocked 透传', () => {
    expect(parseCompletionSelfReport({ summary: 'a', outstanding: [], verification: '', confidence: 'high' })!.outcome).toBe('complete');
    expect(parseCompletionSelfReport({ summary: 'a', outstanding: [], verification: '', confidence: 'high', outcome: 'blocked' })!.outcome).toBe('blocked');
    expect(parseCompletionSelfReport({ summary: 'a', outstanding: [], verification: '', confidence: 'high', outcome: 'weird' })!.outcome).toBe('complete');
  });
  it('outstanding 带入观察文本', () => {
    const r = parseCompletionSelfReport({ summary: 'done', outstanding: ['图标未补'], verification: '', confidence: 'medium' })!;
    expect(selfReportObservation(r)).toContain('遗留：图标未补');
    expect(selfReportObservation(r)).toContain('medium');
  });
});

describe('audit 裁决解析', () => {
  it('裸 JSON / 围栏 JSON / 非法输入', () => {
    expect(parseAuditVerdict('{"complete":false,"missing":["a"]}')).toMatchObject({ complete: false, missing: ['a'] });
    expect(parseAuditVerdict('前置说明\n```json\n{"complete":true}\n```\n')).toMatchObject({ complete: true, missing: [] });
    expect(parseAuditVerdict('没有 json')).toBeUndefined();
    expect(parseAuditVerdict('{"complete":"yes"}')).toBeUndefined();
  });
});

describe('evidenceLedgerDigest（审计输入段）', () => {
  it('空账本提示语', () => {
    expect(evidenceLedgerDigest([])).toContain('无命令');
  });
  it('失败优先 + 汇总计数', () => {
    const d = evidenceLedgerDigest([okCmd, failCmd]);
    expect(d.indexOf('失败')!).toBeLessThan(d.indexOf('成功')! + 100);
    expect(d).toContain('成功 1 次、失败 1 次');
    expect(d).toContain('npm test → exit=1');
  });
});

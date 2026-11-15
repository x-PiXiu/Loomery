import { describe, expect, it } from 'vitest';
import { planProgress, validatePlanSteps } from './plan';

describe('validatePlanSteps（ADR-0026 守门员）', () => {
  it('合法快照：补 id、放行全部合法状态', () => {
    const r = validatePlanSteps([
      { title: '读取目录结构', status: 'completed' },
      { title: '写入 index.html', status: 'in_progress' },
      { title: '语法检查', status: 'pending' },
    ]);
    expect(r).not.toBeNull();
    expect(r!.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(r![1]).toMatchObject({ title: '写入 index.html', status: 'in_progress' });
  });

  it('步骤数越界拒（<2 或 >12）', () => {
    expect(validatePlanSteps([{ title: 'only', status: 'pending' }])).toBeNull();
    const many = Array.from({ length: 13 }, (_, i) => ({ title: `t${i}`, status: 'pending' }));
    expect(validatePlanSteps(many)).toBeNull();
  });

  it('空 title / 超长 title / 非法 status / 非对象项拒', () => {
    expect(validatePlanSteps([{ title: '  ', status: 'pending' }, { title: 'b', status: 'pending' }])).toBeNull();
    expect(validatePlanSteps([{ title: 'x'.repeat(61), status: 'pending' }, { title: 'b', status: 'pending' }])).toBeNull();
    expect(validatePlanSteps([{ title: 'a', status: 'doing' }, { title: 'b', status: 'pending' }])).toBeNull();
    expect(validatePlanSteps([null, { title: 'b', status: 'pending' }])).toBeNull();
  });

  it('非数组输入拒', () => {
    expect(validatePlanSteps('plan')).toBeNull();
    expect(validatePlanSteps(null)).toBeNull();
  });

  it('planProgress 计数', () => {
    const p = planProgress([
      { id: 's1', title: 'a', status: 'completed' },
      { id: 's2', title: 'b', status: 'completed' },
      { id: 's3', title: 'c', status: 'in_progress' },
      { id: 's4', title: 'd', status: 'pending' },
    ]);
    expect(p).toEqual({ done: 2, total: 4 });
  });
});

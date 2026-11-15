import { describe, expect, it } from 'vitest';
import { validateJsonSchema } from './json-schema';

const toolSchema = {
  type: 'object',
  required: ['path', 'content'],
  additionalProperties: false,
  properties: {
    path: { type: 'string', minLength: 1 },
    content: { type: 'string' },
    retries: { type: 'number', minimum: 0, maximum: 3 },
    mode: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

describe('validateJsonSchema（05 §4 管道第一步）', () => {
  it('合法输入零错误', () => {
    const errors = validateJsonSchema(
      { path: 'a.txt', content: 'x', retries: 1, mode: 'a', tags: ['t'] },
      toolSchema,
    );
    expect(errors).toEqual([]);
  });

  it('缺少必填字段报告路径', () => {
    const errors = validateJsonSchema({ path: 'a.txt' }, toolSchema);
    expect(errors.some((e) => e.path === 'content' && e.message.includes('必填'))).toBe(true);
  });

  it('类型不符', () => {
    const errors = validateJsonSchema({ path: 1, content: '' }, toolSchema);
    expect(errors.some((e) => e.path === 'path' && e.message.includes('string'))).toBe(true);
  });

  it('additionalProperties:false 拦截多余字段', () => {
    const errors = validateJsonSchema({ path: 'a', content: '', extra: 1 }, toolSchema);
    expect(errors.some((e) => e.path === 'extra' && e.message.includes('多余'))).toBe(true);
  });

  it('enum / 数值范围 / 数组 items / 长度', () => {
    expect(validateJsonSchema({ mode: 'c' }, { properties: { mode: toolSchema.properties.mode } }).length).toBeGreaterThan(0);
    expect(validateJsonSchema({ retries: 5 }, { properties: { retries: toolSchema.properties.retries } }).length).toBeGreaterThan(0);
    expect(validateJsonSchema({ tags: ['a', 1] }, { properties: { tags: toolSchema.properties.tags } }).some((e) => e.path === 'tags[1]')).toBe(true);
    expect(validateJsonSchema({ path: '' }, { properties: { path: toolSchema.properties.path } }).length).toBeGreaterThan(0);
  });

  it('integer 通过 number 声明', () => {
    expect(validateJsonSchema(2, { type: 'number' })).toEqual([]);
    expect(validateJsonSchema(2.5, { type: 'integer' }).length).toBeGreaterThan(0);
  });

  it('类型不符时不再深入嵌套（避免噪声）', () => {
    const errors = validateJsonSchema('not-object', toolSchema);
    expect(errors).toHaveLength(1);
  });
});

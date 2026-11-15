// 05 §4 管道第一步的 JSON Schema 子集校验器（零依赖实现）。
// 支持：type（含 integer/number 互通）、properties、required、additionalProperties:false、
// enum、items、minLength/maxLength、minimum/maximum。完整 ajv 校验留待需要时经适配器引入。
import type { JsonSchema } from '../tool';

export interface SchemaError {
  path: string;
  message: string;
}

function actualType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return t;
}

function typeMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  if (expected === 'number' && actual === 'integer') return true;
  return false;
}

export function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
  path = '',
): SchemaError[] {
  const errors: SchemaError[] = [];
  const push = (p: string, message: string) => errors.push({ path: p || '(root)', message });
  const child = (key: string) => (path ? `${path}.${key}` : key);

  const declared = schema.type as string | string[] | undefined;
  const actual = actualType(value);
  if (declared !== undefined) {
    const ok = Array.isArray(declared)
      ? declared.some((t) => typeMatches(t, actual))
      : typeMatches(declared, actual);
    if (!ok) {
      push(path, `期望类型 ${Array.isArray(declared) ? declared.join('|') : declared}，实际 ${actual}`);
      return errors;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
    push(path, '值不在 enum 中');
  }

  if (actual === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = (schema.required ?? []) as string[];
    for (const key of required) {
      if (!(key in obj)) push(child(key), '缺少必填字段');
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) push(child(key), '多余字段');
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) errors.push(...validateJsonSchema(obj[key], sub, child(key)));
    }
  }

  if (actual === 'array') {
    const items = schema.items as JsonSchema | undefined;
    if (items) {
      (value as unknown[]).forEach((item, i) => {
        errors.push(...validateJsonSchema(item, items, `${path}[${i}]`));
      });
    }
  }

  if (actual === 'string') {
    const s = value as string;
    const min = schema.minLength as number | undefined;
    const max = schema.maxLength as number | undefined;
    if (min !== undefined && s.length < min) push(path, `长度 ${s.length} 小于 minLength ${min}`);
    if (max !== undefined && s.length > max) push(path, `长度 ${s.length} 超过 maxLength ${max}`);
  }

  if (actual === 'integer' || actual === 'number') {
    const n = value as number;
    const min = schema.minimum as number | undefined;
    const max = schema.maximum as number | undefined;
    if (min !== undefined && n < min) push(path, `值 ${n} 小于 minimum ${min}`);
    if (max !== undefined && n > max) push(path, `值 ${n} 超过 maximum ${max}`);
  }

  return errors;
}

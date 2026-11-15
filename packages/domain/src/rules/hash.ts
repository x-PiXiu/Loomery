// 03 §4 死循环哈希规范：hashToolCall(name, input) = sha256(name + '\u0000' + canonicalJson(input))
import { createHash } from 'node:crypto';

/** 递归键排序的确定性序列化；函数/Symbol 等不可序列化值统一视为 null */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number' || t === 'boolean') return String(value);
  if (t === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return 'null';
}

export function hashToolCall(name: string, input: unknown): string {
  return createHash('sha256').update(name + '\u0000' + canonicalJson(input)).digest('hex');
}

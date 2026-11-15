// 路径归一化：工具输入中的路径字段统一解析为绝对路径（ADR-0013）
// 管道在 schema 校验后立即归一化，保证"守卫检查的路径"与"handler 写的路径"是同一个
import { isAbsolute, resolve } from 'node:path';
import type { JsonSchema } from '../tool';

/** 与 pipeline 护栏共享的字段清单（单一来源） */
export const PATH_FIELDS = ['path', 'file', 'file_path', 'directory', 'dir'] as const;

/**
 * schema 元数据声明的路径字段（顶层属性标 "x-path": true）——静态 PATH_FIELDS 之外的扩展源。
 * 新工具不再需要同步维护白名单（散弹式修改反模式的终结）：在 inputSchema 上自声明即可
 * 获得与 PATH_FIELDS 同等的归一化、越界护栏与 scratch 免审判定。
 */
export function pathFieldsOfSchema(schema: JsonSchema | undefined): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const props = (schema as { properties?: Record<string, Record<string, unknown>> }).properties;
  if (!props) return [];
  return Object.entries(props)
    .filter(([, v]) => v?.['x-path'] === true)
    .map(([k]) => k);
}

/** 返回副本：相对路径字段以 roots[0] 为基准解析为绝对路径；其余字段原样保留 */
export function withAbsolutePaths<T extends Record<string, unknown>>(
  input: T,
  roots: string[],
  extraFields: readonly string[] = [],
): T {
  const out: Record<string, unknown> = { ...input };
  const base = roots[0];
  if (!base) return input;
  for (const field of [...PATH_FIELDS, ...extraFields]) {
    const v = out[field];
    if (typeof v === 'string' && v.length > 0 && !isAbsolute(v)) {
      out[field] = resolve(base, v);
    }
  }
  return out as T;
}

import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './registry';
import type { RegisteredTool } from '@loomery/ports';

const readTool: RegisteredTool = {
  name: 'stub_read',
  description: '读',
  inputSchema: { type: 'object' },
  sideEffect: 'read',
  source: 'builtin',
};
const writeTool: RegisteredTool = {
  name: 'stub_write',
  description: '写',
  inputSchema: { type: 'object' },
  sideEffect: 'write',
  source: 'builtin',
};

describe('ToolRegistry（唯一扩展点）', () => {
  it('重名注册抛错', () => {
    const r = new ToolRegistry();
    r.register(readTool);
    expect(() => r.register(readTool)).toThrow('工具重名');
  });

  it('unregister 移除并返回是否成功', () => {
    const r = new ToolRegistry();
    r.register(readTool);
    expect(r.unregister('stub_read')).toBe(true);
    expect(r.unregister('stub_read')).toBe(false);
  });

  it('listSpecs 按模式过滤（plan 隐藏写工具）', () => {
    const r = new ToolRegistry();
    r.register(readTool);
    r.register(writeTool);
    expect(r.listSpecs('plan').map((t) => t.name)).toEqual(['stub_read']);
    expect(r.listSpecs('edit').map((t) => t.name)).toEqual(['stub_read', 'stub_write']);
    expect(r.listSpecs()).toHaveLength(2);
  });

  it('listSpecs 只含可序列化规格（ADR-0011：无 handler）', () => {
    const r = new ToolRegistry();
    r.register({ ...writeTool, handler: async () => ({ ok: true, content: '' }) });
    const specs = r.listSpecs();
    expect(() => JSON.stringify(specs)).not.toThrow();
    expect(specs[0]).not.toHaveProperty('handler');
  });
});

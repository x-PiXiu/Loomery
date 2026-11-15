// 05 §4 ToolRegistry：唯一扩展点——P1 只有内置贡献者；P2 插件、P3 任务系统从同一入口注册
import { modeAllows } from '@loomery/domain';
import type { AgentMode, ToolSpec } from '@loomery/domain';
import type { RegisteredTool } from '@loomery/ports';

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) throw new Error(`工具重名: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** 对外只暴露可序列化规格（ADR-0011）；按模式过滤后供 ModelRequest 使用 */
  listSpecs(mode?: AgentMode): ToolSpec[] {
    const specs = [...this.tools.values()].map((t) => this.specOf(t));
    return mode ? specs.filter((s) => modeAllows(mode, s)) : specs;
  }

  count(): number {
    return this.tools.size;
  }

  private specOf(tool: RegisteredTool): ToolSpec {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      sideEffect: tool.sideEffect,
      source: tool.source,
    };
  }
}

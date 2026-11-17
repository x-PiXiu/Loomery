// 2026-11-13 taskkill /IM 群杀自杀事件（模型 taskkill /F /IM node.exe 连坐自己宿主 console）的对症工具：
// 给模型"精确打击"手段——本会话 agent 启动过的后台进程清单（含 pid），配合 taskkill /PID 精准杀。
// read 类免审；只列 agent 条目（用户终端面板属于用户领土，不外露）。
import type { RegisteredTool } from '@loomery/ports';

export interface ProcessListDeps {
  /** main 单例登记处（agent/terminal 两类）——取 list() 后过滤 kind==='agent' */
  listAgentEntries: () => { pid: number | null; cwd: string; command: string; startedAt: number; state: string }[];
}

export function createProcessListTool(deps: ProcessListDeps): RegisteredTool {
  return {
    name: 'process_list',
    description:
      // 11-17 上下文瘦身：群杀禁令的"原因长文"与 SYSTEM_BASE 去重，保留点位可执行的停止姿势
      '列出本会话中 agent 通过 run_command 启动过的后台/长驻进程（含 pid、命令、工作目录、状态）。' +
      '停止姿势：先拿 pid 再 taskkill /PID <pid> /F 精确杀——禁令与原因见系统提示（勿按映像名群杀）。',
    inputSchema: { type: 'object', required: [], additionalProperties: false, properties: {} },
    sideEffect: 'read',
    source: 'builtin',
    handler: async () => {
      const entries = deps.listAgentEntries().filter((e) => e.state === 'running');
      if (entries.length === 0) {
        return {
          ok: true,
          content: '（本会话没有正在运行的 agent 后台进程。跨会话遗留的孤儿进程请用 tasklist /FI "IMAGENAME eq xxx" 定位后 taskkill /PID 精确杀，不要 /IM 群杀。）',
          affectedPaths: [],
          evidence: { kind: 'command', ok: true, detail: 'process_list：0 个运行中条目' },
        };
      }
      const lines = entries
        .slice(0, 30)
        .map((e) => `- pid=${e.pid ?? '?'} [${e.state}] ${e.command.slice(0, 120)}（cwd: ${e.cwd}）`);
      return {
        ok: true,
        content: `本会话 agent 后台进程（${entries.length} 个运行中）：\n${lines.join('\n')}\n停掉它们：taskkill /PID <pid> /F（精确击杀，绝不 /IM 群杀）。`,
        affectedPaths: [],
        evidence: { kind: 'command', ok: true, detail: `process_list：${entries.length} 个运行中` },
      };
    },
  };
}

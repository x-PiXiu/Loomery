// 12 §F1.2 run_command：agent 侧一次性命令执行（验证闭环的另一半）
// 安全三道闸：execute 永不 auto 的分级信任策略（ADR-0025）+ 危险命令正则 + 审批卡人审
import type { RegisteredTool, ProcessPort } from '@loomery/ports';

export interface RunCommandOptions {
  /** 命令结束后回调（组合根注入 watcher suppressSink：agent 进程写盘不算外部变更） */
  afterRun?: () => void;
}

export function createRunCommand(processPort: ProcessPort, opts: RunCommandOptions = {}): RegisteredTool {
  return {
    name: 'run_command',
    description:
      '在工作区执行 shell 命令（如构建、测试、语法检查、git 操作），返回 stdout/stderr 合并输出与退出码。' +
      '命令未在超时内结束会被强制终止。适合一次性命令；长驻服务（dev server）请提示用户在终端面板运行。' +
      'cwd 必须位于工作区内。',
    inputSchema: {
      type: 'object',
      required: ['command'],
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: '完整 shell 命令串（如 "npm run build"）' },
        // x-path 元数据：cwd 进入与 path 字段同等的归一化 + 越界护栏 + scratch 判定（F1.2）
        cwd: { type: 'string', description: '工作目录（缺省为工作区第一个根），必须位于工作区内', 'x-path': true },
        timeoutMs: { type: 'number', description: '超时毫秒数，默认 60000，上限 300000（background=true 时忽略）' },
        background: { type: 'boolean', description: '后台启动（dev server/长驻服务专用）：立即返回 pid，不等待退出。停它：先 process_list 查 pid，再 taskkill /PID <pid> /F。严禁 start /B 玩命玩法' },
      },
    },
    sideEffect: 'execute',
    source: 'builtin',
    handler: async (input, ctx) => {
      const raw = input as { command: string; cwd?: string; timeoutMs?: number; background?: boolean };
      const cwd = raw.cwd ?? ctx.workspaceRoots[0] ?? process.cwd();
      try {
        const result = await processPort.spawn({
          command: raw.command,
          cwd,
          ...(raw.timeoutMs !== undefined ? { timeoutMs: raw.timeoutMs } : {}),
          signal: ctx.signal,
          ...(raw.background === true ? { detached: true } : {}),
          ...(ctx.onChunk ? { onChunk: ctx.onChunk } : {}),
        });
        if (raw.background === true) {
          // 后台语义：立即返回 pid——输出拿不到（stdio ignore），验证靠后续 curl/读日志文件
          return {
            ok: true,
            content: `已在后台启动（pid=${result.pid}）。注意：后台进程的输出不回传——需要验证时用 curl 请求其端口或读取其日志文件。停止它：process_list 查 pid 后 taskkill /PID ${result.pid ?? '<pid>'} /F。`,
            affectedPaths: [],
            evidence: { kind: 'command', ok: true, detail: `${raw.command.slice(0, 60)} → 后台启动 pid=${result.pid}` },
          };
        }
        opts.afterRun?.();
        const lines: string[] = [];
        if (result.timedOut) lines.push('[命令超时，已被强制终止。请拆小命令或增大 timeoutMs。]');
        if (result.exitCode !== null && result.exitCode !== 0) lines.push(`命令失败（exit=${result.exitCode}）：`);
        if (result.exitCode === null && !result.timedOut) lines.push('命令被中止：');
        if (result.truncated) lines.push('[输出过长，已截去头部，仅保留尾部。]');
        lines.push(result.output.length > 0 ? result.output : '（无输出）');
        // docs/15 升级 B：机器证据——完成审计与 task_complete.verification 交叉核对的 ground truth
        const commandBrief = raw.command.length > 60 ? raw.command.slice(0, 60) + '…' : raw.command;
        return {
          ok: result.exitCode === 0 && !result.timedOut,
          content: lines.join('\n'),
          affectedPaths: [],
          evidence: {
            kind: 'command',
            ok: result.exitCode === 0 && !result.timedOut,
            detail: `${commandBrief} → exit=${result.timedOut ? 'timeout' : result.exitCode ?? 'aborted'}`,
          },
        };
      } catch (err) {
        return {
          ok: false,
          content: `命令无法启动：${String(err instanceof Error ? err.message : err)}`,
          affectedPaths: [],
          evidence: { kind: 'command', ok: false, detail: `${raw.command.slice(0, 60)} → 启动失败` },
        };
      }
    },
  };
}

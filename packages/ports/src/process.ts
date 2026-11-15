// 12 §F1.1 进程端口：agent 侧子进程执行（run_command 工具消费）
// 接口归内核侧所有，实现归 adapters/process（依赖倒置，可替换可测试）
export interface ProcessSpawnRequest {
  /** 完整 shell 命令串（安全性由审批门 + 危险命令正则 + 分级信任策略承担，见 ADR-0025） */
  command: string;
  /** 工作目录（必须位于任务路径域内，由工具层护栏校验） */
  cwd: string;
  /** 超时（ms）；超时树杀并返回已捕获输出。缺省由 adapter 决定 */
  timeoutMs?: number;
  /** abort 联动：turn 停止 → 进程树杀 */
  signal?: AbortSignal;
  /** 额外注入的环境变量（合并进继承环境） */
  env?: Record<string, string>;
  /** 2026-11-13 后台语义：detached 启动（stdio ignore + 立即返回 pid，不占并发闸、不受超时/abort 影响）——dev server/长驻服务正规通道，取代 start /B 玩命玩法 */
  detached?: boolean;
}

export interface ProcessResult {
  /** null = 被信号杀死（超时/abort/树杀）；detached 启动时恒为 null（进程仍在运行） */
  exitCode: number | null;
  timedOut: boolean;
  /** stdout+stderr 合并输出（环形缓冲封顶，尾部优先保留——错误通常在尾部）；detached 时为空 */
  output: string;
  /** output 因缓冲封顶被截去头部 */
  truncated: boolean;
  /** detached 启动时的进程 pid（已登记 ProcessRegistry，可 taskkill /PID /F 或经 process_list 查询） */
  pid?: number;
}

export interface ProcessPort {
  /**
   * 执行命令直到退出/超时/abort。onChunk 为流式增量（UTF-8 近似解码，仅观测用；
   * 最终 output 以 adapter 的全量编码探测解码为准）。
   * 超出 agent 并发闸时拒绝（throw），由调用方转成工具失败观察。
   */
  spawn(req: ProcessSpawnRequest, onChunk?: (chunk: string) => void): Promise<ProcessResult>;
}

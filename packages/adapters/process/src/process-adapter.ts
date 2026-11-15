// 12 §F1.1 NodeProcessAdapter：child_process 实现 ProcessPort
// 树杀（win32 taskkill /T /F）、超时、abort 联动、输出环形缓冲 256KB、编码探测解码、agent 并发闸
import { spawn as nodeSpawn } from 'node:child_process';
import { decodeText } from '@loomery/domain';
import type { ProcessPort, ProcessResult, ProcessSpawnRequest } from '@loomery/ports';
import type { ProcessRegistry } from './registry';

export const MAX_OUTPUT_BYTES = 256 * 1024;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 300_000;
/** exit 后等 close 的宽限（孤儿握管道场景的强制结算点）*/
export const EXIT_SETTLE_GRACE_MS = 5_000;
/** 超时/中止树杀后等 close 的宽限 */
export const KILL_SETTLE_GRACE_MS = 3_000;

/** 剥离 Loomery 自身控制变量（E2E/存储引擎指路等），不泄漏给子进程——继承环境与显式注入一视同仁 */
function sanitizeEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of Object.keys(merged)) {
    if (k.startsWith('LOOMERY_')) delete merged[k];
  }
  return merged;
}

/** 递归树杀（win32）：taskkill /T 对 `start /B` 后台化的树会漏杀（2026-11-13 实证：外层先自然退出 → 超时杀已死 pid 扑空 exit=128，
 * 孤儿 cmd/go/api 握着继承的 stdio 管道 → Node 'close' 永不触发 → 工具永久"执行中"19 分钟）。
 * 改用 PowerShell 按 ParentProcessId 链枚举后代逐个杀——父已死时孩子 ParentPID 记录不变，孤儿照样能抓到。 */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    const script =
      `$root=${pid}; $all=@($root); $frontier=@($root);` +
      `for($i=0;$i -lt 8 -and $frontier.Count -gt 0;$i++){ $f=$frontier[0]; $frontier=$frontier[1..($frontier.Count-1)];` +
      `$kids=Get-CimInstance Win32_Process -Filter "ParentProcessId=$f" | Select-Object -ExpandProperty ProcessId -ErrorAction SilentlyContinue;` +
      `foreach($k in $kids){ if($all -notcontains $k){ $all+=$k; $frontier+=$k } } };` +
      `$all | ForEach-Object { taskkill /pid $_ /F 2>$null }`;
    nodeSpawn('powershell', ['-NoProfile', '-Command', script], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已退出
    }
  }
}

export interface NodeProcessAdapterOptions {
  /** 缺省不登记（单测轻用）；生产传入 main 单例以支持 before-quit 清场 */
  registry?: ProcessRegistry;
  /** agent 侧并发闸（F1.1 铁律 3）：超限拒绝 */
  maxConcurrentAgent?: number;
}

export class NodeProcessAdapter implements ProcessPort {
  private readonly registry?: ProcessRegistry;
  private readonly maxConcurrent: number;
  private running = 0;

  constructor(opts: NodeProcessAdapterOptions = {}) {
    this.registry = opts.registry;
    this.maxConcurrent = opts.maxConcurrentAgent ?? 4;
  }

  get runningCount(): number {
    return this.running;
  }

  spawn(req: ProcessSpawnRequest, onChunk?: (chunk: string) => void): Promise<ProcessResult> {
    // 2026-11-13 后台语义：detached 立即返回 pid（登记 registry 可查/可杀）；不占并发闸、无超时、不受 abort 树杀
    if (req.detached === true) {
      // win32 不用 detached:true——Node 文档：Windows detached=子进程自有 console（DETACHED_PROCESS→cmd 无 console
      // →孙进程 go.exe 自建可见 console=黑框）。改 windowsHide(CREATE_NO_WINDOW)+stdio ignore+unref：
      // 子孙继承隐藏 console 不会自建可见框；unref 照样不拖住宿主事件循环。非 win32 保留 detached。
      const child = nodeSpawn(req.command, {
        shell: true,
        cwd: req.cwd,
        env: sanitizeEnv(req.env),
        windowsHide: true,
        stdio: 'ignore',
        ...(process.platform !== 'win32' ? { detached: true } : {}),
      });
      const pid: number | undefined = child.pid;
      const entryId = this.registry?.register({
        kind: 'agent',
        pid: pid ?? null,
        cwd: req.cwd,
        command: req.command,
        startedAt: Date.now(),
        kill: async () => {
          if (pid !== undefined) killTree(pid);
        },
      });
      // detached 下 exit 事件仍会触达（父不等待）——登记退场即可；kill 回调持有 pid 树杀
      child.on('exit', () => { if (entryId !== undefined) this.registry?.markExit(entryId, false); });
      child.unref();
      if (pid === undefined) return Promise.reject(new Error('后台进程启动失败（未获得 pid）'));
      return Promise.resolve({ exitCode: null, timedOut: false, output: '', truncated: false, pid });
    }

    const timeoutMs = Math.min(Math.max(req.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
    if (this.running >= this.maxConcurrent) {
      return Promise.reject(new Error(`并发进程已达上限（${this.maxConcurrent}）。请等待现有进程结束，或用更长超时一次完成。`));
    }
    this.running++;

    return new Promise<ProcessResult>((resolve, reject) => {
      const child = nodeSpawn(req.command, {
        shell: true,
        cwd: req.cwd,
        env: sanitizeEnv(req.env),
        windowsHide: true,
      });

      // 输出环形缓冲：按 chunk 粒度丢头部（保留尾部——错误通常在尾部），多字节序列随整块丢弃不会截半
      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      let timedOut = false;
      let aborted = false;
      let settled = false;
      const push = (buf: Buffer): void => {
        if (buf.length === 0) return;
        chunks.push(buf);
        total += buf.length;
        while (total > MAX_OUTPUT_BYTES && chunks.length > 1) {
          const head = chunks.shift()!;
          total -= head.length;
          truncated = true;
        }
        if (onChunk) onChunk(decodeText(buf).text);
      };
      child.stdout?.on('data', push);
      child.stderr?.on('data', push);

      const pid: number | undefined = child.pid;
      const entryId = this.registry?.register({
        kind: 'agent',
        pid: pid ?? null,
        cwd: req.cwd,
        command: req.command,
        startedAt: Date.now(),
        kill: async () => {
          if (child.pid !== undefined) killTree(child.pid);
        },
      });

      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) killTree(child.pid);
        // 超时兜底：树杀后 close 可能仍被漏网孤儿（start /B detached）的 stdio 管道卡住——3s 后强制结算
        setTimeout(() => settle({ exitCode: null, timedOut: true, output: decodeText(Buffer.concat(chunks)).text, truncated }), KILL_SETTLE_GRACE_MS);
      }, timeoutMs);
      const abortKill = (): void => {
        aborted = true;
        if (child.pid !== undefined) killTree(child.pid);
        setTimeout(() => settle({ exitCode: null, timedOut: false, output: decodeText(Buffer.concat(chunks)).text, truncated }), KILL_SETTLE_GRACE_MS);
      };
      req.signal?.addEventListener('abort', abortKill, { once: true });

      const settle = (result: ProcessResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(exitGraceTimer);
        req.signal?.removeEventListener('abort', abortKill);
        this.running--;
        if (entryId) this.registry?.markExit(entryId, timedOut || aborted);
        resolve(result);
      };

      let exitCodeSeen: number | null = null;
      let exitGraceTimer: ReturnType<typeof setTimeout> | undefined;
      child.on('error', (err) => {
        reject(err);
        settle({ exitCode: null, timedOut, output: '', truncated });
      });
      // 2026-11-13 卡死修复：外层 shell（shell:true 的 cmd）可能在 & 链尾部自然退出，而 start /B 后台化的孤儿
      // 握着继承的 stdio 管道 → 'close' 永不触发。exit 事件先到——启动 bounded close-wait，5s 无 close 强制结算
      //（exitCode 用 exit 的 code；孤儿不杀——后台化是模型的合法意图，进程交给 registry/killAll 清场）。
      child.on('exit', (code) => {
        exitCodeSeen = code;
        exitGraceTimer = setTimeout(() => {
          const output = decodeText(Buffer.concat(chunks)).text;
          settle({ exitCode: timedOut || aborted ? null : exitCodeSeen, timedOut, output, truncated });
        }, EXIT_SETTLE_GRACE_MS);
      });
      child.on('close', (code) => {
        const output = decodeText(Buffer.concat(chunks)).text;
        // Windows 被杀进程的 close code 是 1 而非 null：timedOut/aborted 显式归 null（模型侧判"未正常退出"）
        settle({ exitCode: timedOut || aborted ? null : code, timedOut, output, truncated });
      });
    });
  }
}

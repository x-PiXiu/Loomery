// 12 §F1.3 GitAdapter：git CLI 实现 GitPort
// 关键安全点：全部走 spawn('git', args) 数组参数，message/files 绝不进 shell（防注入）
// 13 git 套件（ADR-0027）：reviewList/fileDiff/branches/checkout/push/add——输出统一 decodeText（GBK/中文路径不乱码）
import { spawn as nodeSpawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { decodeText } from '@loomery/domain';
import { join } from 'node:path';
import type { GraphCommit, GitBranches, GitChangedFile, GitOverview, GitPort, ReviewFile, ReviewMode } from '@loomery/ports';

interface GitRunResult {
  code: number;
  output: string;
}

const DIFF_CAP_BYTES = 512 * 1024;

function runGit(root: string, args: string[], timeoutMs = 30_000): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn('git', args, { cwd: root, windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (b: Buffer) => chunks.push(b));
    child.stderr?.on('data', (b: Buffer) => chunks.push(b));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`git 命令超时: git ${args.join(' ')}`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // L1：decodeText（BOM→UTF8→GBK→Big5）——中文 Windows 的 GBK 文件 diff/路径不再乱码
      resolve({ code: code ?? 1, output: decodeText(Buffer.concat(chunks)).text });
    });
  });
}

function fail(root: string, action: string, r: GitRunResult): never {
  throw new Error(`git ${action} 失败（${r.code}）：${r.output.trim() || '（无输出）'} [root=${root}]`);
}

/** untracked 新文件的"新增行数"：git numstat 不含 untracked（胶囊 +0 -0 的根因）——读文件数行；目录/不可读/超大=0 */
async function countUntrackedLines(root: string, p: string): Promise<number> {
  try {
    const buf = await readFile(join(root, p));
    if (buf.length > 2 * 1024 * 1024) return 0; // 超大文件（多为产物/二进制）不数行
    const { text } = decodeText(buf);
    return Math.max(0, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
  } catch {
    return 0;
  }
}

export class GitAdapter implements GitPort {
  async available(): Promise<boolean> {
    try {
      const r = await runGit(process.cwd(), ['--version'], 5_000);
      return r.code === 0;
    } catch {
      return false;
    }
  }

  async status(root: string): Promise<string> {
    const r = await runGit(root, ['-c', 'core.quotepath=false', 'status', '--porcelain=v2', '--branch', '--untracked-files=all']);
    if (r.code !== 0) fail(root, 'status', r);
    return r.output;
  }

  async diff(root: string, staged?: boolean): Promise<string> {
    const args = staged ? ['diff', '--cached'] : ['diff'];
    const r = await runGit(root, args);
    if (r.code !== 0) fail(root, 'diff', r);
    return r.output.length > 0 ? r.output : '（无差异）';
  }

  async log(root: string, limit: number): Promise<string> {
    const n = Math.min(Math.max(Math.floor(limit) || 10, 1), 100);
    const r = await runGit(root, ['log', `--oneline`, `-n`, String(n)]);
    if (r.code !== 0) fail(root, 'log', r);
    return r.output;
  }

  /** 胶囊读模型（12 UI）：porcelain v2 + numstat 一次聚合；非 git 仓库 repo:false */
  async overview(root: string): Promise<GitOverview> {
    const st = await runGit(root, ['-c', 'core.quotepath=false', 'status', '--porcelain=v2', '--branch', '--untracked-files=all']);
    if (st.code !== 0) {
      if (!/not a git repository/i.test(st.output)) fail(root, 'status', st);
      return { repo: false, branch: '', changed: [], totalAdded: 0, totalRemoved: 0 };
    }
    let branch = '';
    const changed: GitChangedFile[] = [];
    let counted = 0; // 软上限：超大未跟踪工作区（如上万临时文件）不逐文件数行，超限置 0 保读模型响应
    for (const line of st.output.replace(/\r/g, '').split('\n')) {
      if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim();
      // v2 记录：'1 XY sub mH mI path'（重命名带多列）——取首二字段与末列路径
      if (line.startsWith('1 ') || line.startsWith('2 ')) {
        const rest = line.slice(2);
        const xy = rest.slice(0, 2);
        const path = rest.slice(2).trim().split(/\s+/).pop() ?? '';
        const status = xy.split('').filter((c) => c !== '.').join('') || xy;
        changed.push({ path, status, added: 0, removed: 0, staged: xy[0] !== '.' });
        continue;
      }
      // untracked 目录以 '/' 结尾（git 折叠整个目录）——去尾斜杠，UI 显示目录名而非空串
      if (line.startsWith('? ')) {
        const p = line.slice(2).trim().replace(/\/$/, '');
        // 新文件 ± 行数：numstat 不含 untracked——读文件数行（否则胶囊永远 +0 -0）
        const added = counted < 300 ? await countUntrackedLines(root, p) : 0;
        counted++;
        changed.push({ path: p, status: '?', added, removed: 0, staged: false });
        continue;
      }
    }
    // ±行数：工作区 numstat（不含 untracked——untracked 已在上方逐文件计数）
    const num = await runGit(root, ['-c', 'core.quotepath=false', 'diff', '--numstat']);
    if (num.code === 0) {
      const byPath = new Map(changed.map((c) => [c.path, c]));
      for (const line of num.output.replace(/\r/g, '').split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const c = byPath.get(parts.slice(2).join(' '));
        if (!c) continue;
        c.added = parts[0] === '-' ? 0 : Number(parts[0]);
        c.removed = parts[1] === '-' ? 0 : Number(parts[1]);
      }
    }
    return {
      repo: true,
      branch,
      changed,
      totalAdded: changed.reduce((s, c) => s + c.added, 0),
      totalRemoved: changed.reduce((s, c) => s + c.removed, 0),
    };
  }

  async commit(root: string, message: string, files?: string[]): Promise<string> {
    // files 非空 = 显式暂存指定文件；空 = 信任当前暂存区（绝不用 add -A，避免误吞）
    if (files && files.length > 0) {
      const add = await runGit(root, ['add', '--', ...files]);
      if (add.code !== 0) fail(root, 'add', add);
    }
    const commit = await runGit(root, ['commit', '-m', message]);
    if (commit.code !== 0) fail(root, 'commit', commit);
    const head = await runGit(root, ['log', '-1', '--oneline']);
    return head.code === 0 ? head.output.trim() : '已提交';
  }

  /** 13：审查页文件清单——worktree/staged/all 走 git；lastTurn 走 checkpoint（L3 双数据源，适配器内统一为 ReviewFile） */
  async reviewList(root: string, mode: ReviewMode): Promise<ReviewFile[]> {
    if (mode === 'lastTurn') return this.lastTurnList(root);
    const st = await runGit(root, ['-c', 'core.quotepath=false', 'status', '--porcelain=v2', '--untracked-files=all']);
    if (st.code !== 0) fail(root, 'status', st);
    const num = await runGit(root, ['-c', 'core.quotepath=false', 'diff', '--numstat']);
    const numByPath = new Map<string, { added: number; removed: number }>();
    if (num.code === 0) {
      for (const line of num.output.replace(/\r/g, '').split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;
        numByPath.set(parts.slice(2).join(' '), { added: parts[0] === '-' ? 0 : Number(parts[0]), removed: parts[1] === '-' ? 0 : Number(parts[1]) });
      }
    }
    const numCached = await runGit(root, ['-c', 'core.quotepath=false', 'diff', '--cached', '--numstat']);
    if (numCached.code === 0) {
      for (const line of numCached.output.replace(/\r/g, '').split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const key = parts.slice(2).join(' ');
        const prev = numByPath.get(key);
        if (!prev) numByPath.set(key, { added: parts[0] === '-' ? 0 : Number(parts[0]), removed: parts[1] === '-' ? 0 : Number(parts[1]) });
      }
    }
    const out: ReviewFile[] = [];
    for (const line of st.output.replace(/\r/g, '').split('\n')) {
      if (line.startsWith('1 ') || line.startsWith('2 ')) {
        const rest = line.slice(2);
        const xy = rest.slice(0, 2);
        const path = rest.slice(2).trim().split(/\s+/).pop() ?? '';
        const stagedBit = xy[0] !== '.';
        const workBit = xy[1] !== '.';
        // 筛选：staged=有暂存位；worktree=有工作区位；all=并集
        if (mode === 'staged' && !stagedBit) continue;
        if (mode === 'worktree' && !workBit && !(path.endsWith('/') === false && line.startsWith('? '))) continue;
        const n = numByPath.get(path) ?? { added: 0, removed: 0 };
        out.push({ path, status: xy.split('').filter((c) => c !== '.').join('') || xy, added: n.added, removed: n.removed });
        continue;
      }
      if (line.startsWith('? ')) {
        if (mode === 'staged') continue; // untracked 永不属于"已暂存"
        const p = line.slice(2).trim().replace(/\/$/, '');
        // 新文件 ± 行数：numstat 不含 untracked——读文件数行（目录显示 0 由 UI 标"新文件"）
        const added = await countUntrackedLines(root, p);
        out.push({ path: p, status: '?', added, removed: 0 });
      }
    }
    return out;
  }

  /** lastTurn：checkpoint 快照 vs 磁盘（deleted/added/modified 显式；± 用 makeFullFileProposal hunks 统计） */
  private async lastTurnList(root: string): Promise<ReviewFile[]> {
    // 快照文件清单由调用方经 RPC 传入更贴合（checkpoint 服务在 shell）——此处仅支持 git 兜底：
    // 实际实现见 bootstrap 的 handler（组合根持有 checkpoint 服务）。适配器侧此分支返回空由 handler 覆写。
    void root;
    return [];
  }

  async fileDiff(root: string, path: string, mode: ReviewMode): Promise<{ text: string; truncated: boolean }> {
    if (mode === 'lastTurn') {
      // lastTurn 的 diff 文本由 bootstrap handler 组装（checkpoint 服务在 shell 层）——适配器不持快照
      return { text: '', truncated: false };
    }
    const diffArgs = mode === 'staged' ? ['diff', '--cached', '--', path] : ['diff', '--', path];
    const r = await runGit(root, ['-c', 'core.quotepath=false', ...diffArgs]);
    if (r.code !== 0) fail(root, 'diff', r);
    // untracked：git diff 无输出——展示整文件为新增
    if (r.output.trim().length === 0) {
      try {
        const buf = await readFile(path.includes(':') && /^[a-zA-Z]:/.test(path) ? path : `${root}/${path}`);
        const { text } = decodeText(buf);
        const body = text.split('\n').map((l) => `+${l}`).join('\n');
        const capped = body.length > DIFF_CAP_BYTES ? body.slice(0, DIFF_CAP_BYTES) : body;
        return { text: `--- a/${path}\n+++ b/${path}\n${capped}`, truncated: body.length > DIFF_CAP_BYTES };
      } catch {
        return { text: `（无法读取文件内容：${path}）`, truncated: false };
      }
    }
    const truncated = r.output.length > DIFF_CAP_BYTES;
    return { text: truncated ? r.output.slice(0, DIFF_CAP_BYTES) : r.output, truncated };
  }

  async branches(root: string): Promise<GitBranches> {
    const r = await runGit(root, ['-c', 'core.quotepath=false', 'for-each-ref', '--format=%(refname:short)|%(upstream:short)', 'refs/heads/', 'refs/remotes/']);
    if (r.code !== 0) fail(root, 'for-each-ref', r);
    const head = await runGit(root, ['symbolic-ref', '--short', 'HEAD']);
    const detached = head.code !== 0;
    const current = detached ? '(detached)' : head.output.trim();
    const local: string[] = [];
    const remote: string[] = [];
    for (const line of r.output.split('\n')) {
      const [ref] = line.split('|');
      if (!ref || ref.trim().length === 0) continue;
      if (ref.startsWith('remotes/')) remote.push(ref.replace(/^remotes\//, ''));
      else local.push(ref);
    }
    return { current, detached, local, remote };
  }

  async checkout(root: string, branch: string, create?: boolean): Promise<void> {
    const r = await runGit(root, create ? ['checkout', '-b', branch] : ['checkout', branch]);
    if (r.code !== 0) {
      // 冲突：git 输出会列出本地修改的冲突文件——原样抛出供 UI 展示
      throw new Error(r.output.trim() || `git checkout 失败（${r.code}）`);
    }
  }

  async push(root: string, remote?: string, branch?: string): Promise<string> {
    const args = remote && branch ? ['push', remote, branch] : ['push'];
    const r = await runGit(root, args, 120_000);
    if (r.code !== 0) {
      if (/no upstream/i.test(r.output) || /has no upstream/i.test(r.output)) {
        const branch = await runGit(root, ['symbolic-ref', '--short', 'HEAD']);
        throw new Error(`当前分支没有上游——先执行：git push -u origin ${branch.code === 0 ? branch.output.trim() : '<分支名>'}`);
      }
      throw new Error(r.output.trim() || `git push 失败（${r.code}）`);
    }
    return r.output.trim() || '已推送';
  }

  async graph(root: string): Promise<string> {
    const r = await runGit(root, ['-c', 'core.quotepath=false', 'log', '--graph', '--all', '--oneline', '--decorate', '-n', '30']);
    if (r.code !== 0) fail(root, 'log --graph', r);
    return r.output;
  }

  async add(root: string, files: string[]): Promise<void> {
    const r = await runGit(root, ['add', '--', ...files]);
    if (r.code !== 0) fail(root, 'add', r);
  }

  async unstage(root: string, files: string[]): Promise<void> {
    const r = await runGit(root, ['restore', '--staged', '--', ...files]);
    if (r.code !== 0) fail(root, 'unstage', r);
  }

  async merge(root: string, branch: string): Promise<string> {
    const r = await runGit(root, ['merge', '--no-edit', branch], 120_000);
    if (r.code !== 0) throw new Error(r.output.trim() || `git merge 失败（${r.code}）`);
    return r.output.trim();
  }

  async rebase(root: string, branch: string): Promise<string> {
    const r = await runGit(root, ['rebase', branch], 120_000);
    if (r.code !== 0) throw new Error(r.output.trim() || `git rebase 失败（${r.code}）`);
    return r.output.trim() || '变基完成';
  }

  async graphData(root: string, limit: number): Promise<GraphCommit[]> {
    const n = Math.min(Math.max(limit || 200, 1), 500);
    const r = await runGit(root, ['-c', 'core.quotepath=false', 'log', '--all', `--max-count=${n}`, '--format=%H|%P|%s|%D']);
    if (r.code !== 0) fail(root, 'log', r);
    const out: GraphCommit[] = [];
    for (const line of r.output.split('\n')) {
      const parts = line.split('|');
      if (parts.length < 4 || (parts[0] ?? '').trim().length === 0) continue;
      out.push({ sha: parts[0] ?? '', parents: parts[1] ? parts[1].split(' ').filter((p) => p.length > 0) : [], subject: parts[2] ?? '', refs: parts[3] ?? '' });
    }
    return out;
  }
}

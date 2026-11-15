// 12 §F1.3 git 端口：薄工具族消费（git_status/diff/log/commit），实现调 git CLI
// 危险面在工具 schema 层根除（git_commit 只暴露 message+files），端口不透传 flags
// root 按调用传入：多项目场景每线程路径域不同（组合根不绑定单一根）
// 13 git 工具套件（ADR-0027）：审查/分支/推送——读操作免审，写操作由用户主动点击=授权
export type ReviewMode = 'worktree' | 'staged' | 'all' | 'lastTurn';

export interface GitPort {
  /** git CLI 可用（PATH 探测）；不可用时上层不注册工具 */
  available(): Promise<boolean>;

  /** 工作区状态（porcelain v2） */
  status(root: string): Promise<string>;

  /** 差异；staged=true 时查暂存区 */
  diff(root: string, staged?: boolean): Promise<string>;

  /** 最近提交（oneline） */
  log(root: string, limit: number): Promise<string>;

  /** 提交：files 为空 = 提交全部已暂存变更。返回提交摘要 */
  commit(root: string, message: string, files?: string[]): Promise<string>;

  /** 胶囊读模型（12 UI）：非 git 仓库返回 repo:false；一次调用聚合分支+变更+±行数 */
  overview(root: string): Promise<GitOverview>;

  /** 审查页文件清单（13）：lastTurn 走 checkpoint 快照 vs 磁盘（Loomery 数据源，非 git） */
  reviewList(root: string, mode: ReviewMode): Promise<ReviewFile[]>;

  /** 单文件 diff 文本（unified；cap 截断打标）；deleted 文件返回旧内容全 − */
  fileDiff(root: string, path: string, mode: ReviewMode): Promise<{ text: string; truncated: boolean }>;

  /** 分支清单（当前/本地/远端；detached 标记） */
  branches(root: string): Promise<GitBranches>;

  /** 检出分支（create=true 时 checkout -b）；冲突/失败抛可行动错误（含冲突文件） */
  checkout(root: string, branch: string, create?: boolean): Promise<void>;

  /** 推送当前分支到 upstream；失败抛可行动错误（无 upstream/无 remote/身份） */
  push(root: string): Promise<string>;

  /** 暂存指定文件（提交弹窗"包含未暂存"/审查页单文件暂存用） */
  add(root: string, files: string[]): Promise<void>;

  /** 取消暂存（审查页单文件 unstage 用；工作区内容不动） */
  unstage(root: string, files: string[]): Promise<void>;

  /** 合并 branch 到当前分支（--no-edit；冲突抛输出） */
  merge(root: string, branch: string): Promise<string>;

  /** 变基：当前分支 rebase 到 branch（= git rebase branch） */
  rebase(root: string, branch: string): Promise<string>;

  /** 图形化图谱数据（时间序；泳道布局在 UI 层） */
  graphData(root: string, limit: number): Promise<GraphCommit[]>;

  /** 推送：remote/branch 缺省 = git push（upstream）；指定 = push remote branch */
  push(root: string, remote?: string, branch?: string): Promise<string>;
}

export interface GraphCommit {
  sha: string;
  parents: string[];
  subject: string;
  /** refs 装饰（HEAD -> main, origin/main…） */
  refs: string;
}

export interface GitChangedFile {
  path: string;
  /** porcelain 状态字母（M/A/D/?/R…；'?'=untracked，目录以 '/' 结尾） */
  status: string;
  added: number;
  removed: number;
  /** 首字母（staged 位）非 '.' —— 胶囊据此决定显示/隐藏提交入口 */
  staged?: boolean;
}

export interface GitOverview {
  repo: boolean;
  branch: string;
  changed: GitChangedFile[];
  totalAdded: number;
  totalRemoved: number;
}

export interface ReviewFile {
  path: string;
  /** worktree/staged：porcelain 字母；lastTurn：modified/added/deleted */
  status: string;
  added: number;
  removed: number;
  binary?: boolean;
}

export interface GitBranches {
  current: string;
  /** porcelain branch.head 为 (detached) 时 true */
  detached: boolean;
  local: string[];
  remote: string[];
}

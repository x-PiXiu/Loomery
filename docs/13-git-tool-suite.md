# 13 Git 工具套件：审查 / 提交 / 分支（胶囊升级）

> 性质：【规范】。对照 ZCode 的 git 工具体验，基于既有 GitAdapter/胶囊/diff 渲染基建的扩展计划。
> 关联：ADR-0027（git 用户操作套件——用户主动点击即授权原则的扩展）；ADR-0024（GitPort 底座）。

## 0. 背景与差距（对照 ZCode 四图）

| 能力 | 现状 | 差距 |
|---|---|---|
| 审查标签页（筛选+文件列表+行内 diff） | 无（只有汇总卡单文件 diff） | 整个 tab 类型缺失，diff 渲染可复用 |
| 筛选：未暂存/已暂存/全部/上一轮 | 无 | 数据源双轨（git/checkpoint） |
| 分支弹窗（列表/创建/检出/图谱） | 分支名纯显示 | 全缺；切换有工作区风险 |
| 提交弹窗（AI 信息/包含未暂存/计数/推送） | inline 简易输入（仅暂存） | UI 升级+AI+push |

**语义决策**（用户确认）：①"全部分支更改" = 已暂存+未暂存并集（vs HEAD）；②push = 当前分支直推 upstream（无 upstream 报错带 `-u` 指引）；③"上一轮更改" = 最近 checkpoint 快照 vs 磁盘当前（不走 git——Loomery 自己的数据源）。

## 1. 数据层（GitAdapter 扩展，阶段 0）

### 1.1 新契约（ports/git.ts）

```ts
type ReviewMode = 'worktree' | 'staged' | 'all' | 'lastTurn';
interface ReviewFile { path: string; status: string; added: number; removed: number; binary?: boolean; deleted?: boolean; }
interface GitPort {
  reviewList(root: string, mode: ReviewMode): Promise<ReviewFile[]>;   // ±统计+状态
  fileDiff(root: string, path: string, mode: ReviewMode): Promise<{ text: string; truncated: boolean }>;
  branches(root: string): Promise<{ current: string; local: string[]; remote: string[]; detached: boolean }>;
  checkout(root: string, branch: string, create?: boolean): Promise<void>;  // 失败抛错（含冲突文件列表）
  push(root: string): Promise<string>;                                  // 当前分支→upstream；失败抛可行动错误
  add(root: string, files: string[]): Promise<void>;
  suggestMessage(root: string): Promise<string>;                        // AI 生成提交信息（cheap 档）
}
```

### 1.2 实现要点（遗漏增补 L1/L2/L3）

- **L1 编码**：runGit 输出统一走 `decodeText`（GBK 文件 diff/中文文件名不再乱码）；`-c core.quotepath=false` 延伸到全部 git 调用。
- **L2 截断**：fileDiff cap 512KB + `truncated` 标记（复用 fsReadFile cap 惯例）。
- **L3 双数据源**：worktree/staged/all 走 git（numstat+unified diff）；**lastTurn 走 checkpoint**（readSnapshot vs 磁盘逐文件比较，±与 diff 文本用 domain diff-engine 纯规则生成；删除/新增语义显式）。
- **rename 修正**：porcelain '2' 行路径取 TAB 前段（新名）——此前 pop() 取到的是 origPath。
- **suggestMessage**：main 侧组装 prompt（文件列表+numstat+diff 头部 cap 8KB+最近 5 条提交风格）→ cheap 档流式；无密钥/失败抛错（UI 降级为禁用 ✨）。
- **测试**：真机临时仓库惯例（13 绿模式扩展）：reviewList 四模式/fileDiff 截断/branches/checkout 冲突/push 无 upstream/add+commit。

### 1.3 RPC（envelope + bootstrap）

```
git.reviewList / git.fileDiff / git.branches / git.suggestMessage   ← 读，免审
git.checkout / git.push / git.addCommit                             ← 用户主动点击=授权（ADR-0027），直接执行
```

错误翻译三件套（L7）：身份未配置→"设置中配置 git 身份"；无 upstream→带 `-u` 指引；空提交→按钮禁用（前端）。

## 2. 审查标签页（阶段 1）

- **入口**：胶囊"更改"行点击 → `loomery:open-review` 事件 → EditorArea `kind:'review'`（path=`review:<root>`，已存在则更新筛选态）。编辑区隐藏时走 show-editor 自动唤起（既有机制）。
- **布局**：顶栏（筛选下拉 ▾ + 刷新）+ 文件列表（状态图标/文件名/目录尾段/±N −M/∨ 行内展开）。
- **行内 diff**：unified 文本行级着色（+ 绿 / − 红 / @@ dim），cap 提示"已截断"；**对照打开**按钮 → `openInDiff` 双栏（复用既有渲染）。
- **新鲜度（L8）**：toolExecuted/checkpointCreated/watcher 变更 → 顶部"有新变更，点击刷新"提示条（不自动刷——保护正在阅读的 diff）。
- **汇总卡整合（L5）**：轮级汇总卡"审查"按钮 → 打开审查 tab 并预设 `lastTurn` 筛选。
- **二进制文件**：显示"[二进制文件，差异不可显示]"占位。

## 3. 提交/推送弹窗（阶段 2）

- **形态**：胶囊提交入口 → Overlay 弹窗（settings/help 同款组件）：当前分支显示 / 提交信息 textarea（✨ 留空自动生成）/ "包含未暂存的更改"勾选（勾选=add 全部后提交；**用户主动勾选即授权**，ADR-0027）/ 文件计数 / 提交（Ctrl+↵，空信息且生成失败时禁用）/ 提交并推送 / 推送。
- **级联刷新（L4 部分）**：commit/push 成功 → 胶囊 refresh + 审查 tab 提示刷新。
- **错误翻译（L7）**：身份未配置/无 upstream/空提交——全部可行动文案。

## 4. 分支弹窗（阶段 3）

- **形态**：胶囊分支行点击 → 浮层：搜索框 / 分支列表（当前 ✓ 标记；本地/remote 分节）/ "创建并检出新分支…"（输入名，checkout -b）/ "Git 图谱"（v1 = `log --graph --all --oneline --decorate` 等宽 pre 渲染；图形化另立项）。
- **切换保护（L14）**：checkout 失败（冲突）→ 显示 git 输出中的冲突文件列表，不静默。
- **detached HEAD（L15）**：分支名显示 `(detached)` + oid 短码。
- **watcher 宽限（L4）**：checkout/addCommit 成功 → `lastGitWriteAt` → watcher 抑制窗口（防 300 文件横幅风暴）。
- **打开文件提示**：切分支后 toast"已切换分支，打开中的文件如显示旧内容请重新打开"（编辑器模型不自动 reload 的诚实告知）。

## 5. 测试与验收

- **数据层**：真机临时仓库——reviewList 四模式（含删除/新增/二进制/rename）/fileDiff 截断+编码/branches/checkout 冲突/push 无 upstream/addCommit。
- **E2E（LOOMERY_E2E=git-review）**：胶囊点更改 → 审查 tab 出现 → 筛选切换 → 行内展开断言。
- **验收**：胶囊"更改"一点即达审查页；四筛选可用；不碰终端完成"生成信息→提交→推送"；分支创建/切换/图谱。

## 6. 明确不做（v1）

远端选择 UI / 图形化 commit 图谱 / stage 单文件的交互式暂存 / rebase-merge 类操作。

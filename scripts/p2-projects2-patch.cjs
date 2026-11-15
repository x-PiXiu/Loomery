// P2 多项目第二批：任务跨项目移动（threadMoved 事件）+ 项目显示名（projectNames）+ restore 折叠
const fs = require('node:fs');
const R = 'packages/';
const patch = (file, pairs) => {
  let s = fs.readFileSync(R + file, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) { console.error('MISS in ' + file + ': ' + a.slice(0, 70)); process.exit(1); }
    s = s.replace(a, b);
  }
  fs.writeFileSync(R + file, s);
  console.log('ok: ' + file);
};

// 1) domain：threadMoved 事件 + ThreadService 重放折叠（restore.ts）
patch('domain/src/event.ts', [
  ["  threadTitleChanged: { threadId: string; title: string };", "  threadTitleChanged: { threadId: string; title: string };\n  /** 多项目：任务移动到另一项目（workspaceRoot 变更；后到为准） */\n  threadMoved: { threadId: string; workspaceRoot: string };"],
]);
patch('agent-core/src/session/restore.ts', [
  [`export interface RebuiltThread {
  threadId: string;
  title: string;`, `export interface RebuiltThread {
  threadId: string;
  title: string;
  /** 所属项目根（threadCreated/threadMoved 折叠，后到为准） */
  workspaceRoot?: string;`],
  [`      case 'threadTitleChanged':
        // 自动/手动重命名的标题以后到的为准；漏掉这条会导致重启后标题全部回退"新会话"
        title = e.payload.title;
        break;`, `      case 'threadTitleChanged':
        // 自动/手动重命名的标题以后到的为准；漏掉这条会导致重启后标题全部回退"新会话"
        title = e.payload.title;
        break;
      case 'threadMoved':
        workspaceRoot = e.payload.workspaceRoot;
        break;`],
  [`  let title = '';`, `  let title = '';
  let workspaceRoot: string | undefined = undefined;`],
]);

// 2) thread-service：moveThread + restore 回填 workspaceRoot
patch('agent-core/src/session/thread-service.ts', [
  [`  /** 用户删除任务：中止进行中的 Turn 并移出内存（日志删除由调用方经 MemoryStore 完成） */`, `  /** 多项目：任务移动到另一项目（事件承载，重启折叠仍生效） */
  moveThread(threadId: string, workspaceRoot: string): void {
    const t = this.threads.get(threadId);
    if (!t) throw new Error(\`任务 \${threadId} 不存在\`);
    t.workspaceRoot = workspaceRoot;
    this.emit(threadId, 'threadMoved', { threadId, workspaceRoot });
  }

  /** 用户删除任务：中止进行中的 Turn 并移出内存（日志删除由调用方经 MemoryStore 完成） */`],
  [`    this.threads.set(threadId, {
      title: rebuilt.title,
      messages: rebuilt.messages,
      turnIds: rebuilt.turnIds,
      createdAt: events[0]?.ts ?? 0,
    });`, `    this.threads.set(threadId, {
      title: rebuilt.title,
      messages: rebuilt.messages,
      turnIds: rebuilt.turnIds,
      createdAt: events[0]?.ts ?? 0,
      ...(rebuilt.workspaceRoot ? { workspaceRoot: rebuilt.workspaceRoot } : {}),
    });`],
]);

// 3) memory-store listThreads：threadMoved 折叠
patch('adapters/memory-store/src/index.ts', [
  [`      for (const e of events) {
        if (e.type === 'threadTitleChanged' && typeof e.payload.title === 'string' && e.payload.title.length > 0) {
          title = e.payload.title;
        }
      }`, `      for (const e of events) {
        if (e.type === 'threadTitleChanged' && typeof e.payload.title === 'string' && e.payload.title.length > 0) {
          title = e.payload.title;
        }
        if (e.type === 'threadMoved' && typeof e.payload.workspaceRoot === 'string') {
          workspaceRoot = e.payload.workspaceRoot;
        }
      }`],
]);

// 4) ui reducer：threadMoved 更新列表
patch('ui/src/stores/runtime.ts', [
  [`      case 'threadTitleChanged':
        threads = threads.map((t) => (t.id === ev.payload.threadId ? { ...t, title: ev.payload.title } : t));
        break;`, `      case 'threadTitleChanged':
        threads = threads.map((t) => (t.id === ev.payload.threadId ? { ...t, title: ev.payload.title } : t));
        break;
      case 'threadMoved':
        threads = threads.map((t) => (t.id === ev.payload.threadId ? { ...t, workspaceRoot: ev.payload.workspaceRoot } : t));
        break;`],
]);

// 5) envelope + bootstrap：thread.move / project.rename（projectNames 显示名映射）
patch('adapters/ipc-bridge/src/envelope.ts', [
  ["  projectRemove: 'project.remove',", "  projectRemove: 'project.remove',\n  projectRename: 'project.rename',\n  threadMove: 'thread.move',"],
]);
patch('shell/src/main/bootstrap.ts', [
  [`  rpc.handle(RPC.projectRemove, async (p) => {`, `  // 项目显示名（不改文件夹路径；config.projectNames 持久化）
  rpc.handle(RPC.projectRename, (p) => {
    const { path, name } = p as { path: string; name: string };
    const names = { ...(config.projectNames ?? {}), [String(path)]: String(name).trim().slice(0, 40) };
    if (!names[String(path)]) delete names[String(path)];
    config.projectNames = names;
    void configStore.save({ projectNames: names });
    return true;
  });
  // 任务跨项目移动：目标必须已在项目列表（kernel moveThread 落 threadMoved 事件）
  rpc.handle(RPC.threadMove, (p) => {
    const { threadId, workspaceRoot } = p as { threadId: string; workspaceRoot: string };
    if (!config.workspaceRoots.includes(String(workspaceRoot))) return { ok: false, error: '目标项目不在列表' };
    threads.moveThread(String(threadId), String(workspaceRoot));
    return { ok: true };
  });
  rpc.handle(RPC.projectRemove, async (p) => {`],
]);
console.log('batch done');

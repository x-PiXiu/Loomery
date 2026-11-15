// P2 多项目：线程绑定工作区根（kernel 四件 + envelope + bootstrap + ui reducer）
const fs = require('node:fs');
const R = 'packages/';
const patch = (file, pairs) => {
  let s = fs.readFileSync(R + file, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) { console.error('MISS in ' + file + ': ' + a.slice(0, 60)); process.exit(1); }
    s = s.replace(a, b);
  }
  fs.writeFileSync(R + file, s);
  console.log('ok: ' + file);
};

// 1) domain Thread + 事件载荷
patch('domain/src/session.ts', [
  [`export interface Thread {
  id: string;
  title: string;
  turnIds: string[];
  createdAt: number;
}`, `export interface Thread {
  id: string;
  title: string;
  turnIds: string[];
  createdAt: number;
  /** 所属项目（工作区根）；P2 多项目，路径护栏/文件工具按线程归域 */
  workspaceRoot?: string;
}`],
]);
patch('domain/src/event.ts', [
  ['threadCreated: { threadId: string; title: string };', 'threadCreated: { threadId: string; title: string; /** 所属项目根（多项目，缺省首根） */ workspaceRoot?: string };'],
]);

// 2) thread-service：ThreadState + createThread 带根 + runTurn 逐线程路径域
patch('agent-core/src/session/thread-service.ts', [
  [`  async createThread(title = '新会话'): Promise<string> {
    const threadId = newId('thread');
    this.threads.set(threadId, { title, messages: [], turnIds: [], createdAt: this.deps.clock.now() });
    this.emit(threadId, 'threadCreated', { threadId, title });
    return threadId;
  }`, `  async createThread(title = '新会话', workspaceRoot?: string): Promise<string> {
    const threadId = newId('thread');
    this.threads.set(threadId, { title, messages: [], turnIds: [], createdAt: this.deps.clock.now(), ...(workspaceRoot ? { workspaceRoot } : {}) });
    this.emit(threadId, 'threadCreated', { threadId, title, ...(workspaceRoot ? { workspaceRoot } : {}) });
    return threadId;
  }`],
  [`          history: [...thread.messages],
          abortController: controller,
        },`, `          history: [...thread.messages],
          // 多项目：路径域按线程归属（缺省回退全局首根）
          workspaceRoots: thread.workspaceRoot ? [thread.workspaceRoot] : undefined,
          abortController: controller,
        },`],
]);

// 3) agent-loop：TurnInput 接收逐线程路径域
patch('agent-core/src/loop/agent-loop.ts', [
  [`  /** 展示名（turnStarted 载荷） */
  model: string;`, `  /** 展示名（turnStarted 载荷） */
  model: string;
  /** ADR 多项目：本线程的路径域（缺省回退 deps.workspaceRoots） */
  workspaceRoots?: string[];`],
  [`    mode: input.mode,
    workspaceRoots: deps.workspaceRoots,`, `    mode: input.mode,
    workspaceRoots: input.workspaceRoots ?? deps.workspaceRoots,`],
]);

// 4) memory-store listThreads 折叠 workspaceRoot
patch('adapters/memory-store/src/index.ts', [
  [`      let title = created && created.type === 'threadCreated' ? created.payload.title : threadId;`, `      let title = created && created.type === 'threadCreated' ? created.payload.title : threadId;
      let workspaceRoot: string | undefined;
      if (created && created.type === 'threadCreated' && created.payload.workspaceRoot) workspaceRoot = created.payload.workspaceRoot;`],
]);
let s = fs.readFileSync(R + 'adapters/memory-store/src/index.ts', 'utf8');
const thrPush = s.match(/threads\.push\(\{[^}]*}\);/);
if (!thrPush) { console.error('threads.push not found'); process.exit(1); }
s = s.replace(thrPush[0], thrPush[0].replace(/\}\);$/, ', ...(workspaceRoot ? { workspaceRoot } : {}) });'));
fs.writeFileSync(R + 'adapters/memory-store/src/index.ts', s);
console.log('ok: memory-store push');

// 5) envelope + bootstrap threadCreate 透传 + projectAdd/Remove
patch('adapters/ipc-bridge/src/envelope.ts', [
  ["  memoryUnpin: 'memory.unpin',", "  memoryUnpin: 'memory.unpin',\n  projectAdd: 'project.add',\n  projectRemove: 'project.remove',"],
]);
patch('shell/src/main/bootstrap.ts', [
  [`  rpc.handle(RPC.threadCreate, (p) => {
    const { title } = (p ?? {}) as { title?: string };
    return threads.createThread(title && title.length > 0 ? title : '新会话').then((threadId) => ({ threadId }));
  });`, `  rpc.handle(RPC.threadCreate, (p) => {
    const { title, workspaceRoot } = (p ?? {}) as { title?: string; workspaceRoot?: string };
    return threads.createThread(title && title.length > 0 ? title : '新会话', workspaceRoot ? String(workspaceRoot) : undefined).then((threadId) => ({ threadId }));
  });
  // 多项目：添加/移除项目（添加支持 path 直传——探针用；不传走系统目录选择框）
  rpc.handle(RPC.projectAdd, async (p) => {
    let dir = (p as { path?: string })?.path;
    if (!dir) {
      const { dialog } = await import('electron');
      const r = await dialog.showOpenDialog(BrowserWindow.getAllWindows()[0]!, {
        title: '选择项目文件夹',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths[0]) return { canceled: true };
      dir = r.filePaths[0];
    }
    dir = String(dir);
    if (config.workspaceRoots.includes(dir)) return { canceled: false, added: false, workspaceRoots: config.workspaceRoots };
    const next = [...config.workspaceRoots, dir];
    config.workspaceRoots = next;
    await configStore.save({ workspaceRoots: next });
    return { canceled: false, added: true, workspaceRoots: next };
  });
  rpc.handle(RPC.projectRemove, async (p) => {
    const { path } = p as { path: string };
    const next = config.workspaceRoots.filter((r) => r !== String(path));
    if (next.length === 0) return { ok: false, workspaceRoots: config.workspaceRoots };
    config.workspaceRoots = next;
    await configStore.save({ workspaceRoots: next });
    return { ok: true, workspaceRoots: next };
  });`],
]);

// 6) ui reducer：threadCreated 带根
patch('ui/src/stores/runtime.ts', [
  ["        threads = [...threads, { id: ev.payload.threadId, title: ev.payload.title, busy: false, createdAt: ev.ts }];", "        threads = [...threads, { id: ev.payload.threadId, title: ev.payload.title, busy: false, createdAt: ev.ts, ...(ev.payload.workspaceRoot ? { workspaceRoot: ev.payload.workspaceRoot } : {}) }];"],
]);

// 7) ui TaskRow 类型 + workspaceRoot
patch('ui/src/views/sidebar/Sidebar.tsx', [
  [`interface TaskRow {
  id: string;
  title: string;
  busy: boolean;
  createdAt: number;
}`, `interface TaskRow {
  id: string;
  title: string;
  busy: boolean;
  createdAt: number;
  workspaceRoot?: string;
}`],
]);
console.log('kernel patch done');

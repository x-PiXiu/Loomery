// 05 §11 统一 RPC 信封与频道名（P2 插件进程、P3 sidecar 复用同一协议）
export const CHANNELS = {
  /** 渲染层 → 主进程（ipcRenderer.invoke） */
  rpc: 'loomery:rpc',
  /** 主进程 → 渲染层（EditorGateway 实现 RPC） */
  rpcMain: 'loomery:rpc:main',
  rpcMainReply: 'loomery:rpc:main:reply',
  /** LoopEvent：main → renderer */
  loopEvent: 'loomery:event:loop',
  /** EnvironmentEvent：renderer → main */
  envEvent: 'loomery:event:env',
  /** 配置变更广播：main → 全部窗口（双窗口一致性，2026-11-14） */
  configChanged: 'loomery:event:configChanged',
  /** WorkspaceEvent：main → renderer（外部文件变更通知，#7） */
  workspaceEvent: 'loomery:event:workspace',
  /** 终端数据流：main → renderer（12 §F2.2，高频；渲染层节流合帧） */
  terminalData: 'loomery:event:terminalData',
  /** 终端会话退出：main → renderer */
  terminalExit: 'loomery:event:terminalExit',
} as const;

export interface RpcEnvelope {
  v: 1;
  id: string;
  channel: string;
  payload?: unknown;
}

/** 07 §8：单消息 > 16MB 拒绝 */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export function isRpcEnvelope(v: unknown): v is RpcEnvelope {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { v?: unknown }).v === 1 &&
    typeof (v as { id?: unknown }).id === 'string' &&
    typeof (v as { channel?: unknown }).channel === 'string'
  );
}

/** 全部 RPC 频道名（请求/响应唯一通道，ADR-0005） */
export const RPC = {
  configGet: 'config.get',
  configSave: 'config.save',
  secretsSet: 'secrets.set',
  secretsHas: 'secrets.has',
  modelTest: 'model.test',
  modelsList: 'models.list',
  usageStats: 'usage.stats',
  metricsGet: 'metrics.get',
  metricsRun: 'metrics.run',
  threadCreate: 'thread.create',
  threadList: 'thread.list',
  threadSend: 'thread.send',
  threadCancel: 'thread.cancel',
  threadRestore: 'thread.restore',
  threadMessages: 'thread.messages',
  threadDelete: 'thread.delete',
  threadExport: 'thread.export',
  threadRename: 'thread.rename',
  threadCompact: 'thread.compact',
  windowPopout: 'window.popout',
  windowControl: 'window.control',
  checkpointRollback: 'checkpoint.rollback',
  checkpointRead: 'checkpoint.read',
  approvalDecide: 'approval.decide',
  // 12 §F1.6/F2：终端（阶段 1 仅外部终端兜底；阶段 2 增加内嵌面板的 create/write/resize/kill）
  terminalOpenExternal: 'terminal.openExternal',
  gitOverview: 'git.overview',
  gitCommitDirect: 'git.commitDirect',
  gitReviewList: 'git.reviewList',
  gitFileDiff: 'git.fileDiff',
  gitBranches: 'git.branches',
  gitCheckout: 'git.checkout',
  gitPush: 'git.push',
  gitAddCommit: 'git.addCommit',
  gitSuggestMessage: 'git.suggestMessage',
  gitGraph: 'git.graph',
  gitUnstage: 'git.unstage',
  gitAdd: 'git.add',
  gitMerge: 'git.merge',
  gitRebase: 'git.rebase',
  gitGraphData: 'git.graphData',
  gitLastTurnList: 'git.lastTurnList', // 胶囊用户提交（用户是审批者，不经 agent 审批管线）
  previewReload: 'preview.reload',
  previewNavigate: 'preview.navigate',
  previewBrowser: 'preview.browser', // payload { url, tab?: 'new' | 'active' }
  previewContent: 'preview.content', // payload { url?: string; path?: string } → { text: string | null }
  previewCapture: 'preview.capture', // payload { url, rect? } → { mime, base64, width, height } | null（docs/16 P2 截图）
  previewRunJs: 'preview.runjs', // payload { url, code } → unknown（docs/16 P2 页面交互）
  previewHover: 'preview.hover', // payload { url, x, y }（docs/16 P2 批次 E：真实鼠标移动→CSS :hover）
  editorOpenImageTab: 'editor.open-image-tab', // payload { name, mime, base64 }（截图落编辑区图片标签）
  browserClose: 'browser.close', // payload { url }
  browserList: 'browser.list', // → string[]
  terminalCreate: 'terminal.create',
  terminalWrite: 'terminal.write',
  terminalResize: 'terminal.resize',
  terminalKill: 'terminal.kill',
  terminalList: 'terminal.list',
  layoutGet: 'layout.get',
  layoutSet: 'layout.set',
  workspaceTree: 'workspace.tree',
  userDataGet: 'userData.get',
  userDataSet: 'userData.set',
  userDataChoose: 'userData.choose',
  briefGet: 'brief.get',
  briefSet: 'brief.set',
  memoryList: 'memory.list',
  memoryUnpin: 'memory.unpin',
  memoryGlobalList: 'memory.globalList',
  memoryGlobalDelete: 'memory.globalDelete',
  projectAdd: 'project.add',
  projectRemove: 'project.remove',
  projectRename: 'project.rename',
  threadMove: 'thread.move',
  artifactList: 'artifact.list',
  artifactGet: 'artifact.get',
  skillList: 'skill.list',
  skillBody: 'skill.body',
  skillSources: 'skill.sources',
  skillImport: 'skill.import',
  skillDelete: 'skill.delete',
  exportBundle: 'task.exportBundle',
  fsReadFile: 'fs.readFile',
  fsWriteFile: 'fs.writeFile',
  // EditorGateway（渲染层实现，主进程调用）
  editorOpenFile: 'editor.openFile',
  editorApplyEdit: 'editor.applyEdit',
  editorReveal: 'editor.revealLine',
  editorGetActive: 'editor.getActive',
  editorGetSelection: 'editor.getSelection',
  editorGetTabs: 'editor.tabs',
  editorGetDiagnostics: 'editor.getDiagnostics',
} as const;

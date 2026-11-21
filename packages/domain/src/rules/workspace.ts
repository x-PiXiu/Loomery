// 11-21 工作区默认规则：安装器/开始菜单启动时 cwd=C:\Windows\System32——系统目录绝不能
// 成为默认工作区（领土护栏会把系统目录圈进 agent 可写范围、侧栏出现"system32"项目）。
// 纯函数放 domain（rules），fs/homedir 副作用留在调用方（bootstrap）——依赖方向与可测性。
/** 判定目录是否位于 Windows 系统目录之下（C:\Windows\...，含 System32） */
export function isSystemDir(dir: string, systemRoot = 'C:\\Windows'): boolean {
  const norm = dir.replace(/\//g, '\\').toLowerCase();
  const root = systemRoot.replace(/\//g, '\\').toLowerCase().replace(/\\$/, '');
  return norm.startsWith(root);
}

/** 清洗历史遗留的系统目录工作区（旧安装版首启把 System32 存成了项目）——返回过滤后的新数组 */
export function sanitizeSystemRoots(roots: string[], systemRoot?: string): string[] {
  return roots.filter((r) => !isSystemDir(r, systemRoot));
}

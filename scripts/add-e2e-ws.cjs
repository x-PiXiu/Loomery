// bootstrap 加 E2E 测试工作区覆盖
const fs = require('fs');
const p = 'packages/shell/src/main/bootstrap.ts';
let s = fs.readFileSync(p, 'utf8');
if (s.includes('LOOMERY_E2E_WORKSPACE')) { console.log('present'); process.exit(0); }
const anchor = "    config.workspaceRoots = [process.env.LOOMERY_WORKSPACE ?? resolveDefaultWorkspace(process.cwd())];\n  }";
if (!s.includes(anchor)) { console.log('anchor miss'); process.exit(1); }
const inject = anchor +
  "\n  // E2E 模式：强制使用测试工作区（即使配置里已有其他根）" +
  "\n  if (process.env.LOOMERY_E2E_WORKSPACE) {" +
  "\n    config.workspaceRoots = [process.env.LOOMERY_E2E_WORKSPACE];" +
  "\n  }";
s = s.replace(anchor, inject);
fs.writeFileSync(p, s);
console.log('e2e workspace override ok');

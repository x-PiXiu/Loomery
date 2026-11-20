// 打包 staging：把 bundle 产物组装成 electron-builder 可消费的应用目录（release/stage）。
// 目录深度镜像 monorepo 相对结构（main.js 在 shell/dist → ../../ui/dist 加载渲染层），
// node-pty（native）从 pnpm store 原样拷贝——保留已按 Electron ABI 构建好的产物，不在打包机重编译。
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const repo = path.join(__dirname, '..');
const stage = path.join(repo, 'release', 'stage');
const pnpmDir = path.join(repo, 'node_modules', '.pnpm');

function copy(src, dest) {
  fs.cpSync(src, dest, { recursive: true, force: true });
}

// 1) 构建（幂等：每次打包前重跑）
execSync('pnpm --filter @loomery/shell run build', { cwd: repo, stdio: 'inherit' });
execSync('pnpm --filter @loomery/ui run build', { cwd: repo, stdio: 'inherit' });

// 2) 清理 + 组装
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'shell', 'dist'), { recursive: true });
fs.mkdirSync(path.join(stage, 'shell', 'resources'), { recursive: true });
fs.mkdirSync(path.join(stage, 'ui'), { recursive: true });

copy(path.join(repo, 'packages/shell/dist'), path.join(stage, 'shell/dist'));
copy(path.join(repo, 'packages/shell/resources'), path.join(stage, 'shell/resources'));
copy(path.join(repo, 'packages/ui/dist'), path.join(stage, 'ui/dist'));

// 3) node-pty（native）：从 .pnpm store 拷贝已构建产物
const ptyEntry = fs.readdirSync(pnpmDir).find((d) => /^node-pty@/.test(d));
if (!ptyEntry) throw new Error('node_modules/.pnpm 下未找到 node-pty');
copy(path.join(pnpmDir, ptyEntry, 'node_modules/node-pty'), path.join(stage, 'shell/dist/node_modules/node-pty'));

// 4) 应用 package.json（electron-builder 的入口）
const rootPkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify({ name: 'loomery', productName: 'Loomery', version: rootPkg.version, author: rootPkg.author, type: 'module', main: 'shell/dist/main.js', private: true }, null, 2),
);

console.log(`staging 完成：${stage}`);

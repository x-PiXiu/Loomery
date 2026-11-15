// ADR-0016：main/preload 用 esbuild 直出（渲染层由 ui 包的 vite 构建），不引入 electron-vite
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/main/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['electron', 'node-pty'], // native 模块不可 bundle（12 §F2.1 ADR-0024）
  outfile: 'dist/main.js',
  sourcemap: 'inline',
});

await build({
  entryPoints: ['src/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  outfile: 'dist/preload.cjs',
});

console.log('[shell] build 完成：dist/main.js + dist/preload.cjs');

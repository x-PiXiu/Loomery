// 文件类型图标：文件名/扩展名 → Simple Icons 语言标（官方品牌色，CC0）→ 语义化 lucide 带色回退 → 通用文件
// 数据由 scripts/make-file-icons.cjs 生成（源：scripts/file-icons/*.svg，勿手改 file-icons.ts）
import { type ReactElement } from 'react';
import { Braces, File as FileIcon, FileText, Image as ImageIcon, Lock, Settings2, TerminalSquare, type LucideIcon } from 'lucide-react';
import { FILE_ICON_DATA, type FileMark } from './file-icons';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']);

// 约定文件名（无扩展名语义或扩展名不达意的）
const NAME_TO_ICON: Record<string, string> = {
  dockerfile: 'docker',
  '.dockerignore': 'docker',
  'go.mod': 'go',
  'go.sum': 'go',
  'cargo.toml': 'rust',
  'cargo.lock': 'rust',
  'package.json': 'npm',
  'package-lock.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
};

// 扩展名 → file-icons.ts 的 slug 键
const EXT_TO_ICON: Record<string, string> = {
  go: 'go',
  py: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  rs: 'rust',
  c: 'c', h: 'c',
  cpp: 'cplusplus', cc: 'cplusplus', cxx: 'cplusplus', hpp: 'cplusplus', hh: 'cplusplus',
  cs: 'dotnet', // Simple Icons 已下架 C# 官方标，.NET 标替代
  java: 'openjdk', // 同上，OpenJDK 标替代
  rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
  html: 'html5', htm: 'html5',
  css: 'css', scss: 'sass', sass: 'sass',
  md: 'markdown', markdown: 'markdown',
  dart: 'dart', lua: 'lua', ex: 'elixir', exs: 'elixir', scala: 'scala',
  sh: 'gnubash', bash: 'gnubash', zsh: 'gnubash',
  vue: 'vuedotjs', svelte: 'svelte',
};

// 无品牌标的类型：语义化 lucide + 该类型生态惯用色
const EXT_FALLBACK: Record<string, [LucideIcon, string]> = {
  json: [Braces, '#CBCB41'],
  yml: [Settings2, '#8A919F'], yaml: [Settings2, '#8A919F'],
  toml: [Settings2, '#8A919F'], ini: [Settings2, '#8A919F'], conf: [Settings2, '#8A919F'], env: [Settings2, '#8A919F'],
  ps1: [TerminalSquare, '#5391FE'],
  pdf: [FileText, '#E5534B'],
  lock: [Lock, '#8A919F'],
  txt: [FileText, '#8A919F'], log: [FileText, '#8A919F'],
};

function extOf(name: string): string {
  const lower = name.toLowerCase();
  return lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
}

function markOf(name: string): FileMark | null {
  const slug = NAME_TO_ICON[name.toLowerCase()] ?? EXT_TO_ICON[extOf(name)];
  return slug ? (FILE_ICON_DATA[slug] ?? null) : null;
}

export function FileTypeIcon({ name, size = 14 }: { name: string; size?: number }): ReactElement {
  const m = markOf(name);
  if (m) {
    return <svg viewBox={m.viewBox} width={size} height={size} fill={m.color} dangerouslySetInnerHTML={{ __html: m.body }} />;
  }
  const ext = extOf(name);
  const fb = EXT_FALLBACK[ext];
  if (fb) {
    const [Icon, color] = fb;
    return <Icon size={size} style={{ color }} />;
  }
  if (IMAGE_EXTS.has(ext)) return <ImageIcon size={size} />;
  return <FileIcon size={size} />;
}

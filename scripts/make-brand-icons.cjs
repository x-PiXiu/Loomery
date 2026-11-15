// 官方品牌图标生成器：从 scripts/brand-svg/*.svg（Simple Icons 官方 SVG + Wikimedia 官方品牌文件）
// 生成 packages/ui/src/views/settings/brand-data.ts——**生成文件勿手改**；重跑 node scripts/make-brand-icons.cjs
// 来源与授权：Simple Icons（simpleicons.org，CC0，官方商标图形）；Wikimedia Commons 官方品牌文件（OpenAI 2025 symbol / XAI Logo）
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'brand-svg');
// preset iconId → { file, color }；color = 官方品牌色；纯黑标在深色主题不可见 → currentColor（渲染层按主题取 --text）
const SOURCES = {
  deepseek: { file: 'deepseek.svg' },
  kimi: { file: 'moonshotai.svg' },
  minimax: { file: 'minimax.svg' },
  dashscope: { file: 'qwen.svg' },
  mimo: { file: 'xiaomi.svg' },
  openai: { file: 'openai.svg' },
  anthropic: { file: 'anthropic.svg' },
  xai: { file: 'xai.svg' },
  openrouter: { file: 'openrouter.svg' },
  ollama: { file: 'ollama.svg' },
};

function convert(raw) {
  const viewBox = (/viewBox="([^"]+)"/.exec(raw) || [])[1] ?? '0 0 24 24';
  const fill = (/fill="([^"]+)"/.exec(raw) || [])[1] ?? '';
  // body：剥掉 svg 壳与 title/metadata/comment，保留全部绘图元素
  const inner = raw
    .replace(/<\?xml[\s\S]*?\?>/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/<metadata[\s\S]*?<\/metadata>/g, '')
    .replace(/<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .trim();
  const isBlack = !fill || fill === '#000000' || fill.toLowerCase() === '#000';
  return { viewBox, body: inner, color: isBlack ? 'currentColor' : fill };
}

const entries = [];
for (const [id, { file }] of Object.entries(SOURCES)) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) { console.warn('缺少源文件，跳过:', file); continue; }
  const { viewBox, body, color } = convert(fs.readFileSync(p, 'utf8'));
  entries.push(`  '${id}': { viewBox: '${viewBox}', color: '${color}', body: ${JSON.stringify(body)} },`);
}

const out = `// 官方品牌图标数据（**生成文件，勿手改**）——node scripts/make-brand-icons.cjs 重新生成
// 来源：Simple Icons（simpleicons.org，官方商标图形，CC0）+ Wikimedia Commons 官方品牌文件（OpenAI 2025 symbol / XAI Logo）
// 纯黑标 color=currentColor：渲染层按主题取 --text（深浅两用，深底白标/浅底黑标 = 各品牌官方深浅用法）
export interface BrandMark {
  viewBox: string;
  color: string;
  body: string;
}

export const BRAND_DATA: Record<string, BrandMark> = {
${entries.join('\n')}
};
`;
fs.writeFileSync(path.join(__dirname, '..', 'packages', 'ui', 'src', 'views', 'settings', 'brand-data.ts'), out, 'utf8');
console.log('brand-data.ts 生成完成：', entries.length, '个品牌标');

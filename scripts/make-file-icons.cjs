// 文件类型图标生成器：从 scripts/file-icons/*.svg（Simple Icons 官方语言标，CC0）
// 生成 packages/ui/src/views/sidebar/file-icons.ts——**生成文件勿手改**；重跑 node scripts/make-file-icons.cjs
// 来源与授权：Simple Icons（simpleicons.org，CC0，官方商标图形）；Java/C#/PowerShell 官方标已下架，
// 分别以 openjdk / dotnet 替代（.java/.cs），PowerShell 走渲染层语义回退（lucide 带色图标）
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'file-icons');
const OUT = path.join(__dirname, '..', 'packages', 'ui', 'src', 'views', 'sidebar', 'file-icons.ts');

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
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.svg')).sort()) {
  const id = f.slice(0, -4);
  const { viewBox, body, color } = convert(fs.readFileSync(path.join(DIR, f), 'utf8'));
  entries.push(`  '${id}': { viewBox: '${viewBox}', color: '${color}', body: ${JSON.stringify(body)} },`);
}

const out = `// 文件类型图标数据（**生成文件，勿手改**）——node scripts/make-file-icons.cjs 重新生成
// 来源：Simple Icons（simpleicons.org，官方语言/品牌标，CC0），color=官方品牌色
export interface FileMark {
  viewBox: string;
  color: string;
  body: string;
}

export const FILE_ICON_DATA: Record<string, FileMark> = {
${entries.join('\n')}
};
`;
fs.writeFileSync(OUT, out, 'utf8');
console.log('file-icons.ts 生成完成：', entries.length, '个语言标');

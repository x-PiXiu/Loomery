// ADR-0022：技能注册表——user（userData/skills/<name>/SKILL.md）+ project（<ws>/.loomery/skills）双作用域
// SKILL.md frontmatter：--- 包裹的 name/description 两行（解析容错：缺 name 用目录名）
// 兼容外部形态（P2 技能导入）：源目录下的单文件 <name>.md 也是合法技能（Claude Code 形态），dirName/singleFile 标记
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { SkillManifest } from '@loomery/domain';
import type { SkillRegistry } from '@loomery/ports';

function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { body: raw };
  const meta: { name?: string; description?: string } = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(\w+)\s*:\s*(.+)$/.exec(line.trim());
    if (!kv) continue;
    if (kv[1] === 'name') meta.name = kv[2]!.trim();
    if (kv[1] === 'description') meta.description = kv[2]!.trim();
  }
  return { ...meta, body: raw.slice(m[0]!.length) };
}

export class FsSkillRegistry implements SkillRegistry {
  constructor(
    private readonly userSkillsDir: string,
    private readonly projectSkillsDir?: string,
  ) {}

  async scan(): Promise<SkillManifest[]> {
    const out: SkillManifest[] = [];
    const scanDir = async (dir: string, scope: 'user' | 'project'): Promise<void> => {
      if (!existsSync(dir)) return;
      let names: string[] = [];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      for (const dirName of names) {
        if (dirName.startsWith('.')) continue;
        // 目录形态：<dirName>/SKILL.md
        const entry = join(dir, dirName, 'SKILL.md');
        if (existsSync(entry)) {
          try {
            const raw = await readFile(entry, 'utf8');
            const { name: fmName, description } = parseFrontmatter(raw);
            out.push({
              name: fmName ?? dirName,
              description: description ?? '',
              scope,
              entry,
              dirName,
            });
          } catch {
            /* 单个技能损坏不影响扫描 */
          }
          continue;
        }
        // 单文件形态：<dirName>.md（Claude Code 等 外部工具的单文件技能）
        if (dirName.toLowerCase().endsWith('.md')) {
          const entry = join(dir, dirName);
          try {
            const raw = await readFile(entry, 'utf8');
            const { name: fmName, description } = parseFrontmatter(raw);
            out.push({
              name: fmName ?? dirName.replace(/\.md$/i, ''),
              description: description ?? '',
              scope,
              entry,
              dirName: dirName.replace(/\.md$/i, ''),
              singleFile: true,
            });
          } catch {
            /* 损坏跳过 */
          }
        }
      }
    };
    await scanDir(this.userSkillsDir, 'user');
    await scanDir(this.projectSkillsDir ?? join(this.userSkillsDir, '__none__'), 'project');
    return out;
  }

  async readBody(name: string): Promise<string> {
    for (const m of await this.scan()) {
      if (m.name === name) return readFile(m.entry, 'utf8');
    }
    throw new Error(`技能 "${name}" 不存在。可用技能见 system 提示的技能索引。`);
  }

  /** 技能根目录（SKILL.md 所在目录；单文件形态为其所在目录） */
  private async skillRoot(name: string): Promise<string> {
    for (const m of await this.scan()) {
      if (m.name === name) return dirname(m.entry);
    }
    throw new Error(`技能 "${name}" 不存在。可用技能见 system 提示的技能索引。`);
  }

  /** 技能附件清单：skill 目录下全部文件（相对路径，SKILL.md 除外）——read_skill 索引附带，agent 不再盲猜 */
  async listFiles(name: string): Promise<string[]> {
    const root = await this.skillRoot(name);
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(relative(root, p).split(sep).join('/'));
      }
    };
    walk(root);
    return out.filter((f) => f !== 'SKILL.md').sort();
  }

  /** 读技能附件（相对路径；域校验防逃逸——附件必须位于技能目录内） */
  async readAttachment(name: string, relPath: string): Promise<string> {
    const root = await this.skillRoot(name);
    const target = resolve(root, relPath);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`路径越界：附件必须位于技能 "${name}" 目录内`);
    }
    let st;
    try { st = await stat(target); } catch { throw new Error(`附件 "${relPath}" 不存在。可用附件见 read_skill(name) 返回的清单。`); }
    if (!st.isFile()) throw new Error(`附件 "${relPath}" 不是文件`);
    return readFile(target, 'utf8');
  }
}

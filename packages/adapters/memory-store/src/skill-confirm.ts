// ADR-0022：项目级技能首用确认记录（userData/skills-confirmed.json；用户批准过 = agent 可读）
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class SkillConfirmStore {
  constructor(private readonly filePath: string) {}

  private async load(): Promise<string[]> {
    if (!existsSync(this.filePath)) return [];
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as string[];
    } catch {
      return [];
    }
  }

  async isConfirmed(name: string): Promise<boolean> {
    return (await this.load()).includes(name);
  }

  async confirm(name: string): Promise<void> {
    const all = await this.load();
    if (!all.includes(name)) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      all.push(name);
      await writeFile(this.filePath, JSON.stringify(all, null, 2), 'utf8');
    }
  }
}

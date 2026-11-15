// 03 §11 ConfigStore JSON 实现：默认值来自 domain 常量；save 为浅层合并（密钥引用不落明文）
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { copyFileSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  MAX_STEPS, MAX_TURN_TOKENS, MAX_TURN_WALL_MS, TOOL_RESULT_CHAR_CAP,
  type AppConfig,
} from '@loomery/domain';
import type { ConfigStore } from '@loomery/ports';

export function createDefaultConfig(workspaceRoots: string[] = []): AppConfig {
  return {
    models: {
      main: { provider: 'openai-compatible', modelId: '' },
      cheap: { provider: 'openai-compatible', modelId: '' },
    },
    approval: { read: 'auto', write: 'ask', execute: 'deny' },
    restorePolicy: 'reject',
    limits: {
      maxSteps: MAX_STEPS,
      maxTurnTokens: MAX_TURN_TOKENS,
      maxWallMs: MAX_TURN_WALL_MS,
      toolResultCharCap: TOOL_RESULT_CHAR_CAP,
    },
    guardrails: { dangerousCommandPatterns: [], injectionPatterns: [] },
    workspaceRoots,
  };
}

/** 损坏抢救：从「新文档+旧尾」形态里截出可解析的最长前缀（渐进回退到上一个换行） */
export function salvageConfig(raw: string): Partial<AppConfig> | null {
  for (let end = raw.length; end > 2; end--) {
    const slice = raw.slice(0, end);
    try {
      const parsed = JSON.parse(slice) as Partial<AppConfig>;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 缩短重试 */ }
  }
  return null;
}

function mergeSection<T extends object>(base: T, patch: Partial<T> | undefined): T {
  if (!patch) return base;
  return { ...base, ...patch } as T;
}

export class JsonConfigStore implements ConfigStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<AppConfig> {
    const base = createDefaultConfig();
    if (!existsSync(this.filePath)) return base;
    // 损坏容错（实证：并发写导致的「新文档+旧尾」截断失败会让启动直接死）：备份坏档→尽量抢救前段→回退默认
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return base;
    }
    let stored: Partial<AppConfig>;
    try {
      stored = JSON.parse(raw) as Partial<AppConfig>;
    } catch {
      const backup = this.filePath + '.corrupt-' + Date.now();
      try { renameSync(this.filePath, backup); } catch { /* 占用则副本 */ copyFileSync(this.filePath, backup); }
      console.warn('[config] 配置文件损坏已备份：' + backup + '（使用默认配置启动）');
      stored = salvageConfig(raw) ?? {};
    }
    return {
      models: mergeSection(base.models, stored.models),
      approval: mergeSection(base.approval, stored.approval),
      restorePolicy: stored.restorePolicy ?? base.restorePolicy,
      limits: mergeSection(base.limits, stored.limits),
      guardrails: mergeSection(base.guardrails, stored.guardrails),
      workspaceRoots: stored.workspaceRoots ?? base.workspaceRoots,
    };
  }

  /** 读当前配置（容错）：文件损坏时抢救前段而非抛错——否则保存链路整体静默失败（实证：新增模型丢失） */
  private async readCurrent(): Promise<Partial<AppConfig>> {
    if (!existsSync(this.filePath)) return {};
    const raw = await readFile(this.filePath, 'utf8');
    try {
      return JSON.parse(raw) as Partial<AppConfig>;
    } catch {
      const salvaged = salvageConfig(raw);
      console.warn('[config] 保存时发现配置损坏，已按抢救前段合并（写回即修复）');
      return salvaged ?? {};
    }
  }

  /** 写队列：串行化 read-merge-write，防并发保存交错（config.json 撕裂损坏的成因） */
  private writeQueue: Promise<void> = Promise.resolve();

  async save(patch: Partial<AppConfig>): Promise<void> {
    const run = this.writeQueue.then(() => this.saveNow(patch));
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async saveNow(patch: Partial<AppConfig>): Promise<void> {
    const current = await this.readCurrent();
    const merged: Partial<AppConfig> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      const k = key as keyof AppConfig;
      const prev = current[k];
      // 对象段落做一层合并，标量直接覆盖
      merged[k] = (
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? mergeSection(prev as object, value as never)
          : value
      ) as never;
    }
    // 原子写（tmp+rename）：杜绝「新文档+旧尾」撕裂——并发写/中断写的损坏即本次 config.json 损坏形态
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    await writeFile(tmp, JSON.stringify(merged, null, 2), 'utf8');
    const { renameSync } = await import('node:fs');
    renameSync(tmp, this.filePath);
  }
}

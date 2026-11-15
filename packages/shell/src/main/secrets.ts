// 07 §3 密钥管理：safeStorage 加密存 userData/secrets.enc；配置文件只存 apiKeyRef
import { safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export class SecretVault {
  constructor(private readonly file: string) {}

  private load(): Record<string, string> {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>) : {};
  }

  set(key: string, value: string): void {
    const all = this.load();
    const encrypted =
      safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(value).toString('base64')
        : Buffer.from(value, 'utf8').toString('base64');
    all[key] = encrypted;
    const sorted: Record<string, string> = {};
    for (const k of Object.keys(all).sort()) {
      const v = all[k];
      if (v !== undefined) sorted[k] = v;
    }
    writeFileSync(this.file, JSON.stringify(sorted));
  }

  get(key: string): string | undefined {
    const raw = this.load()[key];
    if (!raw) return undefined;
    try {
      return safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
        : Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }
  /** 密钥是否已配置（设置页状态点用；不回读明文） */
  has(key: string): boolean {
    return !!this.load()[key];
  }
}
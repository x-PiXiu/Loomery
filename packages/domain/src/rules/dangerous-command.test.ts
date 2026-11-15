import { describe, expect, it } from 'vitest';
import { isDangerousCommand } from './dangerous-command';

describe('isDangerousCommand（07 §4 dangerousCommand 规则）', () => {
  it('命中危险命令', () => {
    expect(isDangerousCommand('rm -rf /')).toBe(true);
    expect(isDangerousCommand('format C:')).toBe(true);
    expect(isDangerousCommand('dd if=/dev/zero of=/dev/sda')).toBe(true);
    expect(isDangerousCommand('del /f /s /q C:\\*')).toBe(true);
    expect(isDangerousCommand('shutdown /s')).toBe(true);
  });

  it('普通命令不误报', () => {
    expect(isDangerousCommand('ls -la')).toBe(false);
    expect(isDangerousCommand('npm test')).toBe(false);
    expect(isDangerousCommand('git status')).toBe(false);
    expect(isDangerousCommand('rm old-file.txt')).toBe(false);
  });

  it('支持自定义模式表（策略即数据）', () => {
    expect(isDangerousCommand('npm publish', [/npm\s+publish/i])).toBe(true);
  });
});

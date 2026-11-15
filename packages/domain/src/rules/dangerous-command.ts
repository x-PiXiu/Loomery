// 07 §4 危险命令护栏（P1 预留，P3 run_command 生效）；模式表为配置数据，可被企业策略追加
export const DEFAULT_DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(-{1,2}[a-z-]+\s+)*-[a-z]*r[a-z]*f/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs/i,
  /\bdd\s+if=/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bdel\s+\/[fsq]/i,
  /\brd\s+\/s/i,
  /\breg\s+delete/i,
  /\btaskkill\s+\/f/i,
  /:\s*\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
  />\s*\/dev\/(sd|nvme|hd)/i,
  /\bdiskpart\b/i,
  /\bcipher\s+\/w/i,
];

export function isDangerousCommand(
  command: string,
  patterns: RegExp[] = DEFAULT_DANGEROUS_COMMAND_PATTERNS,
): boolean {
  return patterns.some((re) => re.test(command));
}

// 07 §4.1 提示词注入检测：命中 → injectionWarning 事件 + 本 Turn 内写/执行工具强制升级 ask
export const DEFAULT_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /reveal\s+(your\s+)?(system\s+)?(prompt|instructions)/i,
  /(you\s+must|you\s+should)\s+(now\s+)?(execute|run)\s+(the\s+)?(following|above)/i,
  /(print|output|show)\s+(your\s+)?(system\s+)?(prompt|instructions)/i,
  /忽略(之前|以上|上面)(的)?(所有)?(指令|提示|规则)/,
  /无视(之前|以上|上面)(的)?(所有)?(指令|提示|规则)/,
  /泄露(你的)?(系统)?(提示词|指令)/,
];

/** 返回命中的模式文本；未命中返回 null */
export function findInjectionMatch(
  text: string,
  patterns: RegExp[] = DEFAULT_INJECTION_PATTERNS,
): string | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

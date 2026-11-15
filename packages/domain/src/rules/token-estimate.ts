// 上下文预算用启发式 token 估算：CJK 字符 ≈ 1 token，其余 ≈ 4 字符/token。
// 精确计数属于适配器细节；内核只依赖此纯函数保证可测性。
const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af]/g;

export function estimateTokens(text: string): number {
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const other = text.length - cjk;
  return cjk + Math.ceil(other / 4);
}

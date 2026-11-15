// 预算墙钟判断注入 Clock（而非直接取系统时间），保证可测性
export interface Clock {
  now(): number;
}

// 设置页/模型面板品牌图标：**官方品牌标**——数据来自 brand-data.ts（生成文件，
// 源 = Simple Icons 官方 SVG + Wikimedia 官方品牌文件），勿手绘近似标
import type { ReactElement } from 'react';
import { BRAND_DATA } from './brand-data';

export function BrandIcon({ id, size = 22 }: { id: string; size?: number }): ReactElement {
  const s = { width: size, height: size, flexShrink: 0 } as const;
  const mark = BRAND_DATA[id];
  if (mark) {
    return (
      <svg
        {...s}
        viewBox={mark.viewBox}
        fill={mark.color}
        style={mark.color === 'currentColor' ? { color: 'var(--text)' } : undefined}
        dangerouslySetInnerHTML={{ __html: mark.body }}
      />
    );
  }
  // 自定义/无品牌可指：中性圆点标
  return (
    <svg {...s} viewBox="0 0 24 24">
      <rect x="2" y="2" width="20" height="20" rx="5" fill="var(--bg-hover)" />
      <circle cx="12" cy="12" r="4" fill="var(--text-dim)" />
    </svg>
  );
}

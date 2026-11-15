// 窗口尺寸/位置记忆（#9）：userData/window-state.json，关窗时保存，越界矫正后恢复
import { screen } from 'electron';
import type { BrowserWindow } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

const FALLBACK: WindowState = { width: 1440, height: 900, maximized: false };

function clamp(n: unknown, min: number, max: number, dft: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dft;
}

/** 读档：缺档/坏档回退默认；坐标越界（显示器变更/拔坞）矫正回可视区域 */
export function loadWindowState(file: string): WindowState {
  try {
    if (!existsSync(file)) return { ...FALLBACK };
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<WindowState>;
    const state: WindowState = {
      width: clamp(raw.width, 960, 12000, FALLBACK.width),
      height: clamp(raw.height, 600, 8000, FALLBACK.height),
      maximized: raw.maximized === true,
    };
    if (typeof raw.x === 'number' && typeof raw.y === 'number') {
      state.x = Math.round(raw.x);
      state.y = Math.round(raw.y);
    }
    if (state.x !== undefined && state.y !== undefined) {
      const display = screen.getDisplayMatching({ x: state.x, y: state.y, width: state.width, height: state.height });
      const wa = display.workArea;
      state.x = Math.min(Math.max(state.x, wa.x - state.width + 160), wa.x + wa.width - 160);
      state.y = Math.min(Math.max(state.y, wa.y), wa.y + wa.height - 80);
    }
    return state;
  } catch {
    return { ...FALLBACK };
  }
}

/** 写档（关闭/退出时收尾；resize/move 期间防抖暂存内存） */
export function trackWindowState(win: BrowserWindow, file: string): void {
  let pending: WindowState | null = null;
  let timer: NodeJS.Timeout | undefined;
  const save = (): void => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) return;
    const maximized = win.isMaximized();
    const b = maximized ? pending : win.getBounds();
    if (maximized && !pending) return; // 最大化且无暂存的常规边界：只记标记
    const state: WindowState = {
      width: b?.width ?? FALLBACK.width,
      height: b?.height ?? FALLBACK.height,
      ...(b && typeof b.x === 'number' && typeof b.y === 'number' ? { x: b.x, y: b.y } : {}),
      maximized,
    };
    try {
      writeFileSync(file, JSON.stringify(state), 'utf8');
    } catch { /* 写档失败不影响运行 */ }
  };
  const debounce = (): void => {
    if (win.isMaximized()) return; // 最大化期间不覆盖已暂存的常规边界
    pending = { ...win.getBounds(), maximized: false };
    clearTimeout(timer);
    timer = setTimeout(save, 800);
  };
  win.on('resize', debounce);
  win.on('move', debounce);
  win.on('close', () => {
    clearTimeout(timer);
    save();
  });
}

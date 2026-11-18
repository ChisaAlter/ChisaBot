/**
 * 悬浮输入框（ComposerDock）的矩形拖拽几何：边 / 角跟随指针，对侧固定，最小尺寸与面板边界夹住。
 * 纯函数，app/tests/composer-dock.test.ts 直接测。
 */

export type DockRect = {
  /** 左边缘距面板左边（px）。 */
  x: number;
  /** 下边缘距面板底边（px）。 */
  b: number;
  /** 外框宽（px）。 */
  w: number;
  /** 外框高（px）；null = 内容自然高（还没竖向拖过，或收起的横条）。 */
  h: number | null;
};

export type DockDir = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";

export const DOCK_MIN_W = 320;
export const DOCK_MIN_H = 120;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/**
 * @param contentH 框当前内容高（h 为 null 的自然高框用它定「搬」的边界）。
 */
export function applyDockDrag(
  rect: DockRect,
  dir: DockDir,
  dx: number,
  dy: number,
  pane: { w: number; h: number },
  contentH: number,
): DockRect {
  let { x, b, w, h } = rect;
  if (dir.includes("w")) {
    const nx = clamp(x + dx, 0, x + w - DOCK_MIN_W);
    w += x - nx;
    x = nx;
  }
  if (dir.includes("e")) {
    w = clamp(w + dx, DOCK_MIN_W, Math.max(DOCK_MIN_W, pane.w - x));
  }
  if (h !== null && dir.includes("n")) {
    // 顶边跟随指针，底边不动：只动 h。
    h = clamp(h - dy, DOCK_MIN_H, Math.max(DOCK_MIN_H, pane.h - b));
  }
  if (dir.includes("s")) {
    if (h === null) {
      // 自然高的框下边条是「搬」：底边跟着指针，内容高不变（横条上下挪位置）。
      b = clamp(b - dy, 0, Math.max(0, pane.h - contentH));
    } else {
      // 定高框下边条是「缩」：顶边不动，h + b 不变。
      const top = h + b;
      h = clamp(h + dy, DOCK_MIN_H, Math.max(DOCK_MIN_H, top));
      b = top - h;
    }
  }
  return { x, b, w, h };
}

/** 窗口 / 面板改大小后把悬浮框夹回可见范围；h 为 null 时保持内容自然高。 */
export function clampDockRect(
  rect: DockRect,
  pane: { w: number; h: number },
): DockRect {
  const w = clamp(rect.w, DOCK_MIN_W, Math.max(DOCK_MIN_W, pane.w));
  const x = clamp(rect.x, 0, Math.max(0, pane.w - w));
  const b = clamp(rect.b, 0, Math.max(0, pane.h - DOCK_MIN_H));
  const h =
    rect.h === null
      ? null
      : clamp(rect.h, DOCK_MIN_H, Math.max(DOCK_MIN_H, pane.h - b));
  return { x, b, w, h };
}

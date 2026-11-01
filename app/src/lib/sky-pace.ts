/*
 * 天空节流器（components/sky-background.tsx）的出帧节奏，抽出来方便单元测试。
 *  1. 慢机（或没有 GPU、软件渲染 WebGL）一帧引擎要上百毫秒：按 66ms 一拍出帧，主线程会被天空帧排满，
 *     这时点一下配色要先等正在画的那帧画完（4× 降速下 INP 240–300ms）。一帧超过 SKY_SLOW_FRAME_MS 时，
 *     两帧之间至少空出 SKY_SLOW_GAP_FACTOR 倍的帧耗时，把主线程让给输入；渐变照样按时间走完，只是帧少一些。
 *  2. 按下鼠标 / 触摸 / 按键后 SKY_INPUT_HOLD_MS 内不出天空帧：天空帧跑在 rAF 里，
 *     和这次点击要上屏的那一帧是同一个渲染步骤，不让它挤进点击的 INP。
 * 引擎本身（app/public/wallpaper_core.html）不改。
 */
import { SKY_FRAME_MS } from "@/lib/sky-fade";

export const SKY_INPUT_HOLD_MS = 300;
export const SKY_SLOW_FRAME_MS = 40;
export const SKY_SLOW_GAP_FACTOR = 4;

export interface SkyPaceClock {
  /** 上一帧开始的时间（performance.now()）。 */
  last: number;
  /** 最近几帧引擎耗时的平滑值（ms）。 */
  cost: number;
  /** 最近一次按下鼠标 / 触摸 / 按键的时间；没有过 = -Infinity。 */
  inputAt: number;
}

/** 记一帧引擎的耗时（指数平滑，新帧占一半：变慢马上反应，偶尔一帧快不至于立刻回到 15fps）。 */
export function noteSkyFrameCost(clock: SkyPaceClock, ms: number): void {
  clock.cost = clock.cost > 0 ? (clock.cost + ms) / 2 : ms;
}

/** 两帧之间的最小间隔。 */
export function skyFrameGap(cost: number): number {
  return cost > SKY_SLOW_FRAME_MS
    ? Math.max(SKY_FRAME_MS, cost * SKY_SLOW_GAP_FACTOR)
    : SKY_FRAME_MS;
}

/** 还在输入保护期里（这时不出天空帧）。 */
export function skyInputHolding(clock: SkyPaceClock, now: number): boolean {
  return now < clock.inputAt + SKY_INPUT_HOLD_MS;
}

/** 下一帧最早什么时候排（setTimeout 的等待毫秒数，留 4ms 给 rAF 对齐）。 */
export function skyFrameDelay(clock: SkyPaceClock, now: number): number {
  const next = Math.max(
    clock.last + skyFrameGap(clock.cost),
    clock.inputAt + SKY_INPUT_HOLD_MS,
  );
  return Math.max(0, next - now - 4);
}

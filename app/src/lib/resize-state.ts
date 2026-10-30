/*
 * 改窗口大小期间的全局状态（P2-3，见 jank-analysis FIX-PLAN）。
 *  - 第一次 resize 事件后，在下一个 rAF 里给 <html> 挂 `data-resizing=""`；
 *  - 最后一次 resize 事件后约 150ms 拿掉；
 *  - 订阅者（WebGL 天空）在挂上时暂停逐帧重绘、拿掉时恢复。
 * CSS（html[data-resizing] 下去掉 backdrop-filter / box-shadow）由前端负责，这里只管属性和 JS 暂停。
 */

export const RESIZE_SETTLE_MS = 150;
export const RESIZING_ATTR = "data-resizing";

type Listener = (resizing: boolean) => void;

const listeners = new Set<Listener>();
let resizing = false;
let raf = 0;
let settleTimer = 0;
let teardown: (() => void) | null = null;

function setResizing(next: boolean) {
  if (resizing === next) return;
  resizing = next;
  const root = document.documentElement;
  if (next) root.setAttribute(RESIZING_ATTR, "");
  else root.removeAttribute(RESIZING_ATTR);
  for (const fn of [...listeners]) fn(next);
}

function onResize() {
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    settleTimer = 0;
    if (raf) {
      window.cancelAnimationFrame(raf);
      raf = 0;
    }
    setResizing(false);
  }, RESIZE_SETTLE_MS);
  if (resizing || raf) return;
  raf = window.requestAnimationFrame(() => {
    raf = 0;
    setResizing(true);
  });
}

/** 应用入口调用一次；重复调用无副作用。返回值用于测试里拆掉。 */
export function initResizeState(): () => void {
  if (typeof window === "undefined") return () => {};
  if (teardown) return teardown;
  window.addEventListener("resize", onResize, { passive: true });
  teardown = () => {
    window.removeEventListener("resize", onResize);
    window.clearTimeout(settleTimer);
    if (raf) window.cancelAnimationFrame(raf);
    settleTimer = 0;
    raf = 0;
    setResizing(false);
    teardown = null;
  };
  return teardown;
}

export function isResizing(): boolean {
  return resizing;
}

/**
 * 拖动是否还没停：从第一次 resize 事件起（属性还没挂上的那一帧也算）到 settle 为止。
 * 给要在同一个 resize 事件里决定「这次跳过」的代码用（天空引擎改画布尺寸）。
 */
export function resizeInProgress(): boolean {
  return resizing || settleTimer !== 0;
}

/** 订阅开始 / 结束；返回取消订阅函数。 */
export function subscribeResizing(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

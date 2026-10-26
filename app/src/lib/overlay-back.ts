import { useEffect, useRef } from "react";
import { isPhone, isStandalone } from "@/lib/device";

/**
 * 「返回」先关抽屉（CB-098）。
 *
 * 打开着的抽屉（左栏 Sheet、右侧面板 Sheet）在这里登记成一个栈，后开的在上面：
 *  - `window.__chisabotBack()`：关掉最上面那个就返回 true，没有打开的返回 false。安卓客户端的
 *    WebScreen 在返回键时先问它，true 就到此为止，false / 不存在 / 出错才走 WebView 的 goBack。
 *  - 手机网页 / 安装后的 PWA：抽屉打开时压一条同地址的历史记录（state 带 `__cbOverlay`），浏览器
 *    或手势「返回」触发 popstate 时只关抽屉、不离开页面。用别的方式关掉（按钮、遮罩、Esc）时，如果
 *    那条记录还在最上面就自己 `history.back()` 把它收回（并吞掉随之而来的那次 popstate），历史里不留
 *    多余的一格，也不会多退一步。抽屉开着时发生了导航（点了会话），那条记录已经不在顶上，就不去动它。
 *  - 桌面浏览器 / PC 客户端不写历史：只有 Esc 和 `__chisabotBack`。
 */

/** 抽屉为什么关：`back` = 浏览器 / 手势 / 安卓返回键（popstate 或 `__chisabotBack`），`user` = 按钮、遮罩、Esc。 */
export type OverlayCloseReason = "back" | "user";

type Entry = { id: number; close: (reason: OverlayCloseReason) => void; pushed: boolean };

const stack: Entry[] = [];
let seq = 0;
let swallowPops = 0;
/** 装在哪个文档上（测试里会换一套 DOM；同一页面只装一次）。 */
let installedOn: Document | null = null;
/**
 * 历史事件的先后顺序（CB-098 QA 第二轮）：不靠时间窗口，只比较「最近一次是浏览器后退 / 前进，
 * 还是用户在页面里的操作」。
 */
let eventSeq = 0;
let lastPopSeq = 0;
let lastUserSeq = 0;

declare global {
  interface Window {
    __chisabotBack?: () => boolean;
  }
}

/** 关掉最上面那个打开的抽屉；有可关的就返回 true。 */
export function closeTopOverlay(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close("back");
  return true;
}

/** 现在有没有登记着的打开抽屉（测试 / 调试用）。 */
export function openOverlayCount(): number {
  return stack.length;
}

function historyWanted(): boolean {
  return isPhone() || isStandalone();
}

function markerOf(state: unknown): number | undefined {
  if (state && typeof state === "object" && "__cbOverlay" in state) {
    const value = (state as { __cbOverlay?: unknown }).__cbOverlay;
    return typeof value === "number" ? value : undefined;
  }
  return undefined;
}

export function installOverlayBack(): void {
  if (typeof window === "undefined" || installedOn === window.document) return;
  installedOn = window.document;
  // 换了 window（只在测试里）：上一个 window 上还没等到的 popstate 不会再来了。
  swallowPops = 0;
  window.__chisabotBack = closeTopOverlay;
  window.addEventListener("popstate", () => {
    if (swallowPops > 0) {
      swallowPops -= 1;
      if (swallowPops === 0) flushSettled();
      return;
    }
    eventSeq += 1;
    lastPopSeq = eventSeq;
    const top = stack[stack.length - 1];
    if (!top?.pushed) return;
    // 浏览器已经退掉了那条记录：别在关闭时再退一次。
    top.pushed = false;
    top.close("back");
  });
  // 用户在页面里的真实操作（点、按键）：之后的打开 / 改地址算用户意图，不算「恢复」。
  // 捕获阶段、被动监听，不影响任何业务处理。
  const intent = () => noteUserIntent();
  window.addEventListener("pointerdown", intent, { capture: true, passive: true });
  window.addEventListener("keydown", intent, { capture: true, passive: true });
}

/** 这台设备上抽屉用历史记录承载「返回」（手机网页 / PWA）。桌面浏览器、PC 客户端不是。 */
export function overlayHistoryMode(): boolean {
  return typeof window !== "undefined" && historyWanted();
}

const settledQueue: Array<() => void> = [];
function flushSettled(): void {
  while (settledQueue.length > 0 && swallowPops === 0) settledQueue.shift()?.();
}

/**
 * 等抽屉自己收回的那条记录退完（被吞掉的 popstate 到了）再执行 `fn`：用户用按钮关抽屉后要改地址
 * （例如去掉 `watch`），得改在抽屉下面那条记录上，不能改在正要被退掉的标记记录上。
 */
export function whenOverlayHistorySettled(fn: () => void): void {
  settledQueue.push(fn);
  if (typeof window === "undefined") {
    flushSettled();
    return;
  }
  // 抽屉的 cleanup（history.back）在这次提交里才发生：下一拍再看要不要等。
  window.setTimeout(flushSettled, 0);
}

/** 记下一次用户在页面里的操作（例如切「面板 | 计算机」），之后的地址变化算用户的意图。 */
export function noteUserIntent(): void {
  eventSeq += 1;
  lastUserSeq = eventSeq;
}

/**
 * 最近一次历史相关事件是浏览器后退 / 前进（而不是用户操作）：此时地址回到旧值（如 `watch=true`）
 * 属于「恢复」，调用方不要因此重新拉出抽屉。
 */
export function lastHistoryEventWasPop(): boolean {
  return lastPopSeq > lastUserSeq;
}

export type OverlayOpenSource = "user" | "restore";

/** 有抽屉压着历史记录：此时页面内的地址更新（例如右栏切标签写 `watch`）应当 replace，不能 push。 */
export function overlayHistoryActive(): boolean {
  return stack.some((entry) => entry.pushed);
}

/**
 * 抽屉开着时用 replace 改了地址（路由会换掉 history.state）：把最上面抽屉的标记补回去，
 * 关抽屉时才认得出这条记录还是自己的。
 */
export function restampOverlayMarker(): void {
  if (typeof window === "undefined") return;
  const top = [...stack].reverse().find((entry) => entry.pushed);
  if (!top || markerOf(window.history.state) === top.id) return;
  window.history.replaceState(
    { ...(window.history.state ?? {}), __cbOverlay: top.id },
    "",
  );
}

/** 抽屉 `open` 时登记，关上 / 卸载时注销。`close` 由调用方负责真正把抽屉关上。 */
export function useBackDismiss(
  open: boolean,
  close: (reason: OverlayCloseReason) => void,
  /**
   * 谁打开的：`user`（点击、快捷键等，默认）永远压一条历史记录；`restore`（浏览器后退 / 前进、地址里的
   * `watch` 恢复）不压，否则前进历史被截断、后退永远退不出这一页。
   */
  source: OverlayOpenSource = "user",
): void {
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (typeof window === "undefined") return;
    // 挂上就开始区分「返回」和「用户操作」，不等第一次打开。
    installOverlayBack();
    if (!open) return;
    seq += 1;
    const entry: Entry = {
      id: seq,
      close: (reason) => closeRef.current(reason),
      pushed: false,
    };
    stack.push(entry);
    // 推迟一拍再压历史：StrictMode 的「挂载 → 卸载 → 挂载」不会留下一条多余记录。
    const timer = historyWanted()
      ? window.setTimeout(() => {
          if (!stack.includes(entry)) return;
          if (sourceRef.current === "restore") return;
          window.history.pushState(
            { ...(window.history.state ?? {}), __cbOverlay: entry.id },
            "",
          );
          entry.pushed = true;
        }, 0)
      : undefined;
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      const index = stack.indexOf(entry);
      if (index >= 0) stack.splice(index, 1);
      if (entry.pushed && markerOf(window.history.state) === entry.id) {
        entry.pushed = false;
        swallowPops += 1;
        window.history.back();
      }
    };
  }, [open]);
}

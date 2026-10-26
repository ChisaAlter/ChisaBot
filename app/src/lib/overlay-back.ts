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

type Entry = { id: number; close: () => void; pushed: boolean };

const stack: Entry[] = [];
let seq = 0;
let swallowPops = 0;
let installed = false;

declare global {
  interface Window {
    __chisabotBack?: () => boolean;
  }
}

/** 关掉最上面那个打开的抽屉；有可关的就返回 true。 */
export function closeTopOverlay(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
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
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.__chisabotBack = closeTopOverlay;
  window.addEventListener("popstate", () => {
    if (swallowPops > 0) {
      swallowPops -= 1;
      return;
    }
    const top = stack[stack.length - 1];
    if (!top?.pushed) return;
    // 浏览器已经退掉了那条记录：别在关闭时再退一次。
    top.pushed = false;
    top.close();
  });
}

/** 抽屉 `open` 时登记，关上 / 卸载时注销。`close` 由调用方负责真正把抽屉关上。 */
export function useBackDismiss(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    installOverlayBack();
    seq += 1;
    const entry: Entry = {
      id: seq,
      close: () => closeRef.current(),
      pushed: false,
    };
    stack.push(entry);
    // 推迟一拍再压历史：StrictMode 的「挂载 → 卸载 → 挂载」不会留下一条多余记录。
    const timer = historyWanted()
      ? window.setTimeout(() => {
          if (!stack.includes(entry)) return;
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

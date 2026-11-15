import { useCallback, useSyncExternalStore } from "react";
import { isPhone, NARROW_QUERY } from "@/lib/device";

function matchQuery(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(query).matches;
}

/** 订阅浏览器媒体查询状态，SSR 或缺失 matchMedia 时返回 false。 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (
        typeof window === "undefined" ||
        typeof window.matchMedia !== "function"
      ) {
        return () => {};
      }
      const mql = window.matchMedia(query);
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", onStoreChange);
        return () => mql.removeEventListener("change", onStoreChange);
      }
      return () => {};
    },
    [query],
  );
  const getSnapshot = useCallback(() => matchQuery(query), [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * 窄（竖屏）布局：手机永远是（横过来也是，DESIGN.md §40），其它设备看窗口是否 < 768px。
 * 首帧即同步得出结果，避免左栏先按桌面宽度渲染再收进抽屉。
 */
export function useIsMobile(): boolean {
  const narrow = useMediaQuery(NARROW_QUERY);
  return (typeof window !== "undefined" && isPhone()) || narrow;
}

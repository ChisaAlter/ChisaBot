import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useTimeout } from "@/hooks";

/**
 * 全站统一动效词汇表（与 `app/src/styles.css` 令牌 1:1 镜像）。
 *
 * 曲线与时长统一在此导出，避免各组件手写魔数导致全站体感分裂。
 */

/** 主进场 / 展开 / 滑动曲线（对齐 CSS `--ease-out`）。 */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** 退场 / 收起曲线（对齐 CSS `--ease-in`）。 */
export const EASE_IN = [0.4, 0, 1, 1] as const;

/** 原地色彩 / 状态切换曲线（对齐 CSS `--ease-std`）。 */
export const EASE_STD = [0.4, 0, 0.2, 1] as const;

/** 小徽标 / 勾选弹性曲线（对齐 CSS `--ease-spring`，严禁用于大卡片）。 */
export const EASE_SPRING = [0.34, 1.4, 0.64, 1] as const;

/** 时长阶梯（毫秒，与 CSS `--dur-*` 一一对应）。 */
export const DURATION_MS = {
  instant: 100,
  fast: 150,
  normal: 200,
  slow: 260,
  exit: 150,
  collapse: 260,
} as const;

/** 时长阶梯（秒，供 `motion/react` 使用）。 */
export const DURATION_SECONDS = {
  instant: 0.1,
  fast: 0.15,
  normal: 0.2,
  slow: 0.26,
  exit: 0.15,
  collapse: 0.26,
} as const;

/** 标准进场时长（秒）。 */
export const ENTRANCE_SECONDS = DURATION_SECONDS.normal;

/** 标准退场时长（秒，退出快于进入）。 */
export const EXIT_SECONDS = DURATION_SECONDS.exit;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

let sharedReducedMotionSource: {
  from: typeof window.matchMedia;
  mql: MediaQueryList;
} | null = null;
const reducedMotionListeners = new Set<() => void>();
let activeReducedMotionMql: MediaQueryList | null = null;

const notifyReducedMotion = () => {
  for (const listener of reducedMotionListeners) listener();
};

function attachReducedMotionListener(mql: MediaQueryList) {
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", notifyReducedMotion);
    return;
  }
  mql.addListener?.(notifyReducedMotion);
}

function detachReducedMotionListener(mql: MediaQueryList) {
  if (typeof mql.removeEventListener === "function") {
    mql.removeEventListener("change", notifyReducedMotion);
    return;
  }
  mql.removeListener?.(notifyReducedMotion);
}

function getReducedMotionMql(): MediaQueryList | null {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return null;
  }
  if (sharedReducedMotionSource?.from !== window.matchMedia) {
    sharedReducedMotionSource = {
      from: window.matchMedia,
      mql: window.matchMedia(REDUCED_MOTION_QUERY),
    };
  }
  return sharedReducedMotionSource.mql;
}

function subscribeReducedMotion(listener: () => void): () => void {
  const mql = getReducedMotionMql();
  if (mql && activeReducedMotionMql !== mql) {
    if (activeReducedMotionMql) {
      detachReducedMotionListener(activeReducedMotionMql);
    }
    activeReducedMotionMql = mql;
    if (reducedMotionListeners.size > 0) {
      attachReducedMotionListener(activeReducedMotionMql);
    }
  }
  const wasEmpty = reducedMotionListeners.size === 0;
  reducedMotionListeners.add(listener);
  if (wasEmpty && activeReducedMotionMql) {
    attachReducedMotionListener(activeReducedMotionMql);
  }
  return () => {
    reducedMotionListeners.delete(listener);
    if (reducedMotionListeners.size === 0 && activeReducedMotionMql) {
      detachReducedMotionListener(activeReducedMotionMql);
      activeReducedMotionMql = null;
    }
  };
}

function getReducedMotionSnapshot(): boolean {
  return Boolean(getReducedMotionMql()?.matches);
}

function getReducedMotionServerSnapshot(): boolean {
  return false;
}

/** 查询当前系统是否启用了「减少动态效果」。 */
export function prefersReducedMotion(): boolean {
  return getReducedMotionSnapshot();
}

/** 共享单例订阅 `prefers-reduced-motion: reduce`，避免全站重复挂载 `matchMedia` 监听。 */
export function useSharedReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot,
  );
}

/** 遵守 `prefers-reduced-motion` 的滚动定位，减少动态效果下自动退回 `auto`。 */
export function smoothScrollIntoView(
  el: Element | null | undefined,
  options?: ScrollIntoViewOptions,
): void {
  if (!el || typeof el.scrollIntoView !== "function") return;
  const behavior: ScrollBehavior = prefersReducedMotion()
    ? "auto"
    : (options?.behavior ?? "smooth");
  el.scrollIntoView({ block: "nearest", ...options, behavior });
}

/**
 * 保留上一个非空值，供 Dialog / Sheet / 抽屉在关闭退场期间继续渲染原内容，
 * 避免 `open={false}` 与数据置空同帧导致 150–160ms 退场动画途中内容瞬间塌陷。
 *
 * 使用 `useRef` 零 `setState` 保活，调用方传入每次渲染新派生的数组或对象也绝不会触发重渲循环。
 */
export function useRetainedValue<T>(
  value: T | null | undefined,
): T | null | undefined {
  const retainedRef = useRef<T | null | undefined>(value);
  if (value !== null && value !== undefined) {
    retainedRef.current = value;
  }
  return value ?? retainedRef.current;
}

/**
 * 兼顾「首次打开前懒挂载」与「关闭时完整播放退场动画」的挂载控制器：
 * - 初始 `open === false` 时 `mounted === false`（零挂载开销）；
 * - `open` 变 `true` 当帧立刻 `mounted === true`；
 * - `open` 变 `false` 后维持挂载，待 `onExited()`（可直连 Base UI `onOpenChangeComplete`）
 *   或兜底定时器触发后自动卸载（零裸 `useEffect`）。
 */
export function usePresenceMount(
  open: boolean,
  exitMs: number = DURATION_MS.exit,
): { mounted: boolean; onExited: () => void } {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) {
    setMounted(true);
  }

  const openRef = useRef(open);
  openRef.current = open;

  const onExited = useCallback(() => {
    if (!openRef.current) {
      setMounted(false);
    }
  }, []);

  const fallbackDelay =
    !open && mounted ? (prefersReducedMotion() ? 0 : exitMs + 40) : null;

  useTimeout(onExited, fallbackDelay, open);

  return { mounted, onExited };
}

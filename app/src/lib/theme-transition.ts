import { isResizing } from "@/lib/resize-state";

type ViewTransitionLike = {
  ready?: Promise<unknown>;
  finished: Promise<unknown>;
  skipTransition?: () => void;
};

type DocumentWithViewTransition = Document & {
  startViewTransition?: (
    callback: () => Promise<unknown> | undefined,
  ) => ViewTransitionLike;
};

const SWITCHING_ATTR = "data-theme-switching";
const COMMIT_FALLBACK_MS = 32;

let switchGen = 0;
let raf1 = 0;
let raf2 = 0;
let pendingCommitTimer = 0;
let pendingCommitResolve: (() => void) | null = null;
let activeTransition: ViewTransitionLike | null = null;

function clearScheduledRelease(): void {
  if (typeof window === "undefined") {
    raf1 = 0;
    raf2 = 0;
    return;
  }
  if (raf1) {
    window.cancelAnimationFrame(raf1);
    raf1 = 0;
  }
  if (raf2) {
    window.cancelAnimationFrame(raf2);
    raf2 = 0;
  }
}

function resolvePendingCommit(): void {
  if (typeof window !== "undefined" && pendingCommitTimer) {
    window.clearTimeout(pendingCommitTimer);
  }
  pendingCommitTimer = 0;
  const resolve = pendingCommitResolve;
  pendingCommitResolve = null;
  resolve?.();
}

function releaseIfCurrent(targetGen: number): void {
  if (switchGen !== targetGen || typeof document === "undefined") return;
  document.documentElement.removeAttribute(SWITCHING_ATTR);
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 判断当前环境是否适合启用 GPU 合成层 View Transitions API 做深浅交叉淡入。
 * 隐藏标签页、窗口缩放期、减动效、性能模式或静态背景下走原子冻结同步回退。
 */
export function canUseThemeViewTransition(root: HTMLElement): boolean {
  if (typeof document === "undefined") return false;
  const doc = document as DocumentWithViewTransition;
  if (typeof doc.startViewTransition !== "function") return false;
  if (document.visibilityState === "hidden") return false;
  if (isResizing()) return false;
  if (
    root.getAttribute("data-perf") === "on" ||
    root.getAttribute("data-static-bg") === "on"
  ) {
    return false;
  }
  if (prefersReducedMotion()) return false;
  return true;
}

/**
 * 通知正在等待 React 提交的 ViewTransition 回调可以结束（无需 flushSync）。
 */
export function notifyThemeTransitionCommitted(): void {
  resolvePendingCommit();
}

/**
 * 取消任何在途的深浅切换过渡与冻结标志（供重置等场景使用）。
 */
export function cancelActiveThemeTransition(): void {
  switchGen += 1;
  clearScheduledRelease();
  resolvePendingCommit();
  const transition = activeTransition;
  activeTransition = null;
  if (transition) {
    try {
      transition.skipTransition?.();
    } catch {
      // 忽略浏览器已结束或中断的 ViewTransition 异常
    }
  }
  if (typeof document !== "undefined") {
    document.documentElement.removeAttribute(SWITCHING_ATTR);
  }
}

function runFallbackFrozen(apply: () => void, gen: number): void {
  const root = document.documentElement;
  root.setAttribute(SWITCHING_ATTR, "1");
  apply();
  if (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function"
  ) {
    raf1 = window.requestAnimationFrame(() => {
      raf1 = 0;
      raf2 = window.requestAnimationFrame(() => {
        raf2 = 0;
        releaseIfCurrent(gen);
      });
    });
    return;
  }
  releaseIfCurrent(gen);
}

/**
 * 协调深浅色切换：先挂 `data-theme-switching="1"` 冻结 240+ 子节点并发过渡，
 * 再同步写入 DOM；支持时在 GPU 合成层做交叉淡入，否则双 rAF 后解冻。
 */
export function runThemeTransition(
  apply: () => void,
  options?: { animate?: boolean; waitForCommit?: boolean },
): void {
  if (typeof document === "undefined") {
    apply();
    return;
  }

  const root = document.documentElement;
  clearScheduledRelease();
  resolvePendingCommit();
  if (activeTransition) {
    const prev = activeTransition;
    activeTransition = null;
    try {
      prev.skipTransition?.();
    } catch {
      // 忽略快速连点中断前一次过渡的异常
    }
  }

  switchGen += 1;
  const gen = switchGen;

  const useViewTransition =
    options?.animate !== false && canUseThemeViewTransition(root);
  const startVT = (document as DocumentWithViewTransition).startViewTransition;

  if (useViewTransition && typeof startVT === "function") {
    try {
      let applied = false;
      const transition = startVT.call(document, () => {
        if (switchGen !== gen) return undefined;
        applied = true;
        root.setAttribute(SWITCHING_ATTR, "1");
        apply();
        if (!options?.waitForCommit) return undefined;
        return new Promise<void>((resolve) => {
          pendingCommitResolve = resolve;
          if (typeof window !== "undefined") {
            pendingCommitTimer = window.setTimeout(() => {
              resolvePendingCommit();
            }, COMMIT_FALLBACK_MS);
          } else {
            resolvePendingCommit();
          }
        });
      });

      if (switchGen !== gen) {
        try {
          transition.skipTransition?.();
        } catch {
          // 已过期代际直接跳过
        }
        return;
      }

      activeTransition = transition;
      transition.ready?.catch(() => {});
      transition.finished
        .catch(() => {})
        .finally(() => {
          if (activeTransition === transition) {
            activeTransition = null;
          }
          if (switchGen === gen) {
            resolvePendingCommit();
            releaseIfCurrent(gen);
          }
        });
      // 若浏览器同步调用了 callback 但未完成 apply（防御极少数异常实现），兜底执行一次
      if (!applied && activeTransition === null) {
        apply();
      }
      return;
    } catch {
      activeTransition = null;
      resolvePendingCommit();
    }
  }

  runFallbackFrozen(apply, gen);
}

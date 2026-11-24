import { startTransition, useEffect, useState } from "react";
import { resizeInProgress } from "@/lib/resize-state";

/**
 * 跨断点渐进挂载开关：
 * - 非缩放期或首次挂载就是 true 时，首帧同步返回 true（零额外延迟）；
 * - 仅当 shouldMount 在窗口几何切换/缩放期（resizeInProgress()）由 false 翻为 true 时，
 *   首帧先返回 false 让主线程 16ms 内先绘出全宽背景、顶栏、聊天列与空玻璃壳，下一帧 rAF
 *   再通过 startTransition 渐进挂载重型子树，消除 Windows 切回大窗/最大化时的半屏白墙撕裂。
 */
export function useDeferWhileResizing(shouldMount: boolean): boolean {
  const [prevShouldMount, setPrevShouldMount] = useState(shouldMount);
  const [ready, setReady] = useState(shouldMount);

  let effectiveReady = ready;
  if (shouldMount !== prevShouldMount) {
    setPrevShouldMount(shouldMount);
    effectiveReady = shouldMount ? !resizeInProgress() : false;
    if (ready !== effectiveReady) setReady(effectiveReady);
  }

  useEffect(() => {
    if (!shouldMount || ready) return;
    if (typeof requestAnimationFrame !== "function") {
      startTransition(() => setReady(true));
      return;
    }
    let cancelled = false;
    const frameId = requestAnimationFrame(() => {
      if (cancelled) return;
      startTransition(() => {
        if (!cancelled) setReady(true);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
    };
  }, [shouldMount, ready]);

  return shouldMount && effectiveReady;
}

import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  initialMountedCount,
  mountStartIndex,
  nextMountedCount,
  reconcileMountedCount,
  TAIL_BACKFILL_ATTR,
} from "@/lib/chat/tail-first-paint";

/** 浏览器原生滚动锚定（Chrome / Edge / Firefox）。Safari 没有，走 JS 兜底。 */
export function supportsOverflowAnchor(): boolean {
  return (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("overflow-anchor", "auto")
  );
}

type Idle = (cb: () => void) => () => void;

/** 空闲时补下一批（最多等 50ms），没有 requestIdleCallback 就退回 rAF。 */
const scheduleIdle: Idle = (cb) => {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(cb, { timeout: 50 });
    return () => cancelIdleCallback(id);
  }
  const id = requestAnimationFrame(cb);
  return () => cancelAnimationFrame(id);
};

/**
 * 长对话首屏只挂尾巴，随后在空闲时分批往前补。`scrollKey` 换频道时重置。
 *
 * 位置怎么保（jank P1-2）：
 * - 贴底（默认）：补行时**不读** scrollHeight。上面补的行由浏览器的 `overflow-anchor` 补偿，
 *   滚动容器本身也在 following-bottom 模式；全部补完后读一次 scrollHeight 钉底。
 *   以前每批都在 layout effect 里读 scrollHeight，每批一次整棵 transcript 强制样式重算（REPORT #1）。
 * - 人已上滑：原生锚定保持当前看到的行不动（§35）；没有 overflow-anchor 的浏览器才量
 *   scrollHeight 差把 scrollTop 垫回去。
 * 滚到顶附近再加速补（`prependHistory`），避免「上面空着翻不动」。`?message=` 靠 MessageFind
 * 轮询，全量挂完落在既有等待窗口内。
 */
export function useTailFirstMount(
  total: number,
  scrollKey: string | undefined,
  viewport: RefObject<HTMLElement | null>,
  /** Same first row means new rows were appended, rather than older history prepended. */
  firstId?: string,
): { startIndex: number; pending: boolean; prependHistory: () => void } {
  const [mounted, setMounted] = useState(() => initialMountedCount(total));
  const totalRef = useRef(total);
  const keyRef = useRef(scrollKey);
  const firstRef = useRef(firstId);
  const appended = firstId !== undefined && firstRef.current === firstId;
  const startRef = useRef(mountStartIndex(total, mounted));
  /** 只在需要 JS 兜底时才有值：补行前量的 scrollHeight。 */
  const heightBeforeRef = useRef(0);
  const atBottomRef = useRef(true);
  const pinFrameRef = useRef(0);
  const nativeAnchorRef = useRef<boolean | null>(null);
  const nativeAnchor = () => {
    nativeAnchorRef.current ??= supportsOverflowAnchor();
    return nativeAnchorRef.current;
  };

  useLayoutEffect(() => {
    firstRef.current = firstId;
    if (keyRef.current !== scrollKey) {
      keyRef.current = scrollKey;
      totalRef.current = total;
      const next = initialMountedCount(total);
      startRef.current = mountStartIndex(total, next);
      heightBeforeRef.current = 0;
      atBottomRef.current = true;
      setMounted(next);
      return;
    }
    const prev = totalRef.current;
    totalRef.current = total;
    if (prev === total) return;
    setMounted((m) => reconcileMountedCount(prev, total, m, appended));
  }, [scrollKey, total, firstId, appended]);

  // Reconcile before rendering: after an append, `mounted` still describes the previous total.
  // Using it directly moves a full window's start from 0 to 1 for one commit, unmounting the oldest
  // message before the layout effect mounts it again. Keep every already-mounted row in that commit.
  const renderedMounted =
    keyRef.current !== scrollKey
      ? initialMountedCount(total)
      : reconcileMountedCount(totalRef.current, total, mounted, appended);
  const startIndex = mountStartIndex(total, renderedMounted);

  /** 在改窗口之前调：只有「上滑 + 没有原生锚定」才量一次高度，其余情况零布局读取。 */
  const measureBeforeGrow = useCallback(() => {
    const el = viewport.current;
    heightBeforeRef.current =
      el && !atBottomRef.current && !nativeAnchor() ? el.scrollHeight : 0;
  }, [viewport]);

  useLayoutEffect(() => {
    const el = viewport.current;
    const prevStart = startRef.current;
    startRef.current = startIndex;
    const before = heightBeforeRef.current;
    heightBeforeRef.current = 0;
    if (!el || startIndex >= prevStart) return;
    if (nativeAnchor()) {
      // 这次提交的 MutationObserver 回调（微任务，排在 DOM 变动时）先于下面这个微任务跑：
      // 它们看到标记就不当场量布局（jank P1-2 复审：每批两次强制样式 + 布局）。
      el.setAttribute(TAIL_BACKFILL_ATTR, "");
      queueMicrotask(() => el.removeAttribute(TAIL_BACKFILL_ATTR));
    }
    if (atBottomRef.current) {
      // 原生锚定在补行时已经让底部那几行不动；补完那一批钉一次底。没有原生锚定就每批当场钉。
      if (!nativeAnchor()) el.scrollTop = el.scrollHeight;
      else if (startIndex === 0) {
        // 放到下一帧：在这次提交里读 scrollHeight 会把最后一批（最大的一批）的样式重算 + 布局
        // 强制塞进同一个长任务（复审 trace：约 300ms）。下一帧本来就要算样式，读它不多花。
        cancelAnimationFrame(pinFrameRef.current);
        pinFrameRef.current = requestAnimationFrame(() => {
          if (atBottomRef.current) el.scrollTop = el.scrollHeight;
        });
      }
      return;
    }
    if (before <= 0) return;
    const delta = el.scrollHeight - before;
    if (delta > 0) el.scrollTop += delta;
  }, [startIndex, viewport]);

  const prependHistory = useCallback(() => {
    measureBeforeGrow();
    setMounted((m) => nextMountedCount(nextMountedCount(m, total), total));
  }, [measureBeforeGrow, total]);

  useEffect(() => () => cancelAnimationFrame(pinFrameRef.current), []);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onScroll = () => {
      atBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (el.scrollTop < 480) prependHistory();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [viewport, prependHistory]);

  useEffect(() => {
    // scrollKey: restart catch-up when the channel identity changes (same total is common).
    void scrollKey;
    let cancelled = false;
    let cancel = () => {};
    const step = () => {
      cancel = scheduleIdle(() => {
        if (cancelled) return;
        measureBeforeGrow();
        setMounted((m) => {
          if (m >= total) return m;
          const n = nextMountedCount(m, total);
          if (n < total) step();
          return n;
        });
      });
    };
    step();
    return () => {
      cancelled = true;
      cancel();
    };
  }, [scrollKey, total, measureBeforeGrow]);

  return {
    startIndex,
    pending: renderedMounted < total,
    prependHistory,
  };
}

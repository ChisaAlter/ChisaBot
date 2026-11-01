import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  catchUpTarget,
  initialMountedCount,
  MOUNT_ALL_HISTORY_EVENT,
  mountStartIndex,
  nextMountedCount,
  reconcileMountedCount,
} from "@/lib/chat/tail-first-paint";

/** 视口里第一条看得见的消息，和它的上边离视口上边多远（可以是负的）。 */
function readAnchor(
  viewport: HTMLElement | null,
): { id: string; top: number } | null {
  if (!viewport) return null;
  const edge = viewport.getBoundingClientRect().top;
  for (const row of viewport.querySelectorAll<HTMLElement>(
    "[data-message-id]",
  )) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > edge + 1) {
      const id = row.dataset.messageId;
      return id ? { id, top: rect.top - edge } : null;
    }
  }
  return null;
}

/**
 * 长对话首屏只挂尾巴，随后用 rAF 往前补，补到 TAIL_FIRST_CAP 为止。`scrollKey` 换频道时重置。
 *
 * 人已上滑时补上面的行会撑高滚动区：用 scrollHeight 差把 scrollTop 垫回去（§35）。
 * 滚到顶附近再加速补，避免「上面空着翻不动」。
 *
 * 封顶之上的历史只在三种情况下挂：人往上滚到顶附近（上面那条）、`mountAll()` /
 * MOUNT_ALL_HISTORY_EVENT（跳转目标不在 DOM 里：`?message=`、活动记录），或 `options.uncapped`
 * （有待恢复的滚动锚点：上次停在中间，那一条可能很旧）。
 */
export function useTailFirstMount(
  total: number,
  scrollKey: string | undefined,
  viewport: RefObject<HTMLElement | null>,
  /** Same first row means new rows were appended, rather than older history prepended. */
  firstId?: string,
  options: { uncapped?: boolean } = {},
): {
  startIndex: number;
  /** 还在往目标条数补（封顶之内）。 */
  pending: boolean;
  /** 上面还有没挂的历史。 */
  truncated: boolean;
  /** 把全部历史挂上（分批，不是一次）。 */
  mountAll: () => void;
} {
  const [mounted, setMounted] = useState(() => initialMountedCount(total));
  const [expanded, setExpanded] = useState(false);
  const full = expanded || options.uncapped === true;
  const totalRef = useRef(total);
  const keyRef = useRef(scrollKey);
  const firstRef = useRef(firstId);
  const appended = firstId !== undefined && firstRef.current === firstId;
  const startRef = useRef(mountStartIndex(total, mounted));
  const scrollHeightRef = useRef(0);
  const atBottomRef = useRef(true);
  /** The row the reader was looking at, and how far below the top edge it sat, taken just before older rows are mounted above it. */
  const anchorRef = useRef<{ id: string; top: number } | null>(null);
  const mountAll = useCallback(() => setExpanded(true), []);

  useLayoutEffect(() => {
    firstRef.current = firstId;
    if (keyRef.current !== scrollKey) {
      keyRef.current = scrollKey;
      totalRef.current = total;
      const next = initialMountedCount(total);
      startRef.current = mountStartIndex(total, next);
      scrollHeightRef.current = 0;
      atBottomRef.current = true;
      setExpanded(false);
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

  // This render will put older rows above the reader: note which row they are looking at while the DOM
  // is still the old one. (Pinned to the bottom needs no reference row.) Only a ref is written, so a
  // render that never commits does no harm.
  if (startIndex < startRef.current && !atBottomRef.current) {
    anchorRef.current = readAnchor(viewport.current);
  }

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const prevStart = startRef.current;
    const prevHeight = scrollHeightRef.current;
    const nextHeight = el.scrollHeight;
    startRef.current = startIndex;
    scrollHeightRef.current = nextHeight;
    if (startIndex >= prevStart || prevHeight <= 0) return;
    const delta = nextHeight - prevHeight;
    if (delta <= 0) return;
    if (atBottomRef.current) {
      anchorRef.current = null;
      el.scrollTop = nextHeight;
      return;
    }
    // Scrolled up: put the row the reader was looking at back where it was. Browsers with scroll
    // anchoring (Chrome) have usually done this already by the time the height was read above, so the
    // drift is 0 and nothing more is added; adding `delta` blindly doubled the move (a 50-row jump).
    const anchor = anchorRef.current;
    anchorRef.current = null;
    const row = anchor
      ? el.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(anchor.id)}"]`,
        )
      : null;
    if (anchor && row) {
      const drift =
        row.getBoundingClientRect().top -
        el.getBoundingClientRect().top -
        anchor.top;
      if (Math.abs(drift) > 0.5) el.scrollTop += drift;
      return;
    }
    // No reference row (history arrived some other way): the old behaviour.
    el.scrollTop += delta;
  }, [startIndex, viewport]);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onScroll = () => {
      atBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (el.scrollTop < 480) {
        setMounted((m) => nextMountedCount(nextMountedCount(m, total), total));
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener(MOUNT_ALL_HISTORY_EVENT, mountAll);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener(MOUNT_ALL_HISTORY_EVENT, mountAll);
    };
  }, [viewport, total, mountAll]);

  useEffect(() => {
    // scrollKey: restart catch-up when the channel identity changes (same total is common).
    void scrollKey;
    let cancelled = false;
    let raf = 0;
    const target = catchUpTarget(total, full);
    const step = () => {
      raf = requestAnimationFrame(() => {
        if (cancelled) return;
        setMounted((m) => {
          // Never undo what scrolling up or an append already mounted: stop, do not shrink.
          if (m >= target) return m;
          const n = Math.min(nextMountedCount(m, total), target);
          if (n < target) step();
          return n;
        });
      });
    };
    step();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [scrollKey, total, full]);

  return {
    startIndex,
    pending: renderedMounted < catchUpTarget(total, full),
    truncated: renderedMounted < total,
    mountAll,
  };
}

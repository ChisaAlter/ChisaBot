import {
  type RefObject,
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
} from "@/lib/chat/tail-first-paint";

/**
 * 长对话首屏只挂尾巴，随后用 rAF 往前补。`scrollKey` 换频道时重置。
 *
 * 人已上滑时补上面的行会撑高滚动区：用 scrollHeight 差把 scrollTop 垫回去（§35）。
 * 滚到顶附近再加速补，避免「上面空着翻不动」。`?message=` 靠 MessageFind 轮询，
 * 全量挂完通常一两百毫秒，落在既有等待窗口内。
 */
export function useTailFirstMount(
  total: number,
  scrollKey: string | undefined,
  viewport: RefObject<HTMLElement | null>,
): { startIndex: number; pending: boolean } {
  const [mounted, setMounted] = useState(() => initialMountedCount(total));
  const totalRef = useRef(total);
  const keyRef = useRef(scrollKey);
  const startRef = useRef(mountStartIndex(total, mounted));
  const scrollHeightRef = useRef(0);
  const atBottomRef = useRef(true);

  useLayoutEffect(() => {
    if (keyRef.current !== scrollKey) {
      keyRef.current = scrollKey;
      totalRef.current = total;
      const next = initialMountedCount(total);
      startRef.current = mountStartIndex(total, next);
      scrollHeightRef.current = 0;
      atBottomRef.current = true;
      setMounted(next);
      return;
    }
    const prev = totalRef.current;
    totalRef.current = total;
    if (prev === total) return;
    setMounted((m) => reconcileMountedCount(prev, total, m));
  }, [scrollKey, total]);

  const startIndex = mountStartIndex(total, mounted);

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const prevStart = startRef.current;
    const prevHeight = scrollHeightRef.current;
    const nextHeight = el.scrollHeight;
    startRef.current = startIndex;
    scrollHeightRef.current = nextHeight;
    if (startIndex >= prevStart || prevHeight <= 0) return;
    if (atBottomRef.current) return;
    const delta = nextHeight - prevHeight;
    if (delta > 0) el.scrollTop += delta;
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
    return () => el.removeEventListener("scroll", onScroll);
  }, [viewport, total]);

  useEffect(() => {
    // scrollKey: restart catch-up when the channel identity changes (same total is common).
    void scrollKey;
    let cancelled = false;
    let raf = 0;
    const step = () => {
      raf = requestAnimationFrame(() => {
        if (cancelled) return;
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
      cancelAnimationFrame(raf);
    };
  }, [scrollKey, total]);

  return {
    startIndex,
    pending: mounted < total,
  };
}

import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  anchorShortfall,
  captureScrollAnchor,
  catchUpTarget,
  hasVisibleRow,
  initialMountedCount,
  MOUNT_ALL_HISTORY_EVENT,
  mountStartIndex,
  nextMountedCount,
  reconcileMountedCount,
  requestAnchorSlack,
  restoreScrollAnchor,
  type ScrollAnchor,
  TAIL_BACKFILL_ATTR,
  TAIL_FIRST_THRESHOLD,
  visibleWindowStart,
  withoutSmoothScroll,
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
 * 位置怎么保（jank P1-2 / 聊天记录消失 QA #519 P2-1）：
 * - 贴底（默认）：空闲补行时**不读** scrollHeight。上面补的行由浏览器的 `overflow-anchor` 补偿，
 *   滚动容器本身也在 following-bottom 模式；全部补完后读一次 scrollHeight 钉底。
 *   以前每批都在 layout effect 里读 scrollHeight，每批一次整棵 transcript 强制样式重算（REPORT #1）。
 * - 人点「显示更早的消息」（或滚到顶附近触发 `prependHistory`）：补行前记下正在看的那一行和它的
 *   偏移，layout effect 里同步改 scrollTop 恢复。不依赖浏览器锚定——scrollTop 为 0 时
 *   Chrome 不做 overflow-anchor，之前会先跳到新内容顶部，再动画滚回底部，正在看的行飞出去约 1 秒。
 * - 人已上滑、且是空闲补行：原生锚定保持当前看到的行不动（§35）；没有 overflow-anchor 的浏览器才量
 *   scrollHeight 差把 scrollTop 垫回去。
 * 滚到顶附近再加速补（`prependHistory`），避免「上面空着翻不动」。
 */
export function useTailFirstMount(
  total: number,
  scrollKey: string | undefined,
  viewport: RefObject<HTMLElement | null>,
  /** Same first row means new rows were appended, rather than older history prepended. */
  firstId?: string,
  options?: {
    uncapped?: boolean;
    /**
     * 按看得见的行计数（聊天记录消失，2026-11-10）：`marks` 来自 windowMarks（每一格的起点），`total` 传
     * `marks.length`，`itemCount` 是整段列表的条数。返回的 `startIndex` 是整段列表里的下标。
     */
    marks?: readonly number[];
    itemCount?: number;
    /** 最上面那个看得见的条目的下标：起点在它后面才算「上面还有历史」。 */
    firstVisible?: number;
    /** 这个下标（整段列表里）往后的一定挂上：正在进行的这一轮，从人发的那条到干活提示所在的行。 */
    pin?: number;
    /**
     * 打开时如果人跟着底部（默认 true），首帧就在 layout 里钉到底，不要等下一帧
     * （QA #519 P3：先在顶部停约 200ms）。恢复上次停在中间的位置时传 false。
     */
    followBottom?: boolean;
  },
): {
  startIndex: number;
  /** 还在往目标条数补（封顶之内）。 */
  pending: boolean;
  /** 上面还有没挂的历史。 */
  truncated: boolean;
  /** 把全部历史挂上（分批，不是一次）。 */
  mountAll: () => void;
  prependHistory: () => void;
} {
  const [mounted, setMounted] = useState(() => initialMountedCount(total));
  const [expanded, setExpanded] = useState(false);
  const full = expanded || options?.uncapped === true;
  const totalRef = useRef(total);
  const keyRef = useRef(scrollKey);
  const firstRef = useRef(firstId);
  const appended = firstId !== undefined && firstRef.current === firstId;
  const startRef = useRef(mountStartIndex(total, mounted));
  /** 只在需要 JS 兜底时才有值：补行前量的 scrollHeight。 */
  const heightBeforeRef = useRef(0);
  /** 点「显示更早的消息」等主动补行前记下的锚；空闲补行不用它，以免干扰贴底。 */
  const userAnchorRef = useRef<ScrollAnchor | null>(null);
  const atBottomRef = useRef(true);
  const pinFrameRef = useRef(0);
  /** 这个频道是否已经在首帧（或内容第一次到时）钉过底。 */
  const firstPinnedRef = useRef(false);
  const nativeAnchorRef = useRef<boolean | null>(null);
  const nativeAnchor = () => {
    nativeAnchorRef.current ??= supportsOverflowAnchor();
    return nativeAnchorRef.current;
  };
  const mountAll = useCallback(() => setExpanded(true), []);

  useLayoutEffect(() => {
    firstRef.current = firstId;
    if (keyRef.current !== scrollKey) {
      keyRef.current = scrollKey;
      // 换频道：上一个频道还没跑的「补完钉底」作废（补行的 idle 回调由下面 effect 的清理取消）。
      cancelAnimationFrame(pinFrameRef.current);
      pinFrameRef.current = 0;
      totalRef.current = total;
      const next = initialMountedCount(total);
      startRef.current = mountStartIndex(total, next);
      heightBeforeRef.current = 0;
      userAnchorRef.current = null;
      atBottomRef.current = true;
      firstPinnedRef.current = false;
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
  const marks = options?.marks;
  const pin = options?.pin;
  const startIndex = marks
    ? visibleWindowStart(
        options?.itemCount ?? total,
        marks,
        renderedMounted,
        pin,
      )
    : Math.min(
        mountStartIndex(total, renderedMounted),
        pin === undefined || pin < 0 ? total : pin,
      );
  const target = catchUpTarget(total, full);
  /** 上面还有看得见的历史没挂（按看得见的行计数时，最上面那些看不见的行不算）。 */
  const truncated = marks
    ? startIndex >
      (options?.firstVisible ?? marks[0] ?? Number.POSITIVE_INFINITY)
    : startIndex > 0;
  const pending = renderedMounted < target;

  /** 在改窗口之前调：只有「上滑 + 没有原生锚定」才量一次高度，其余情况零布局读取。 */
  const measureBeforeGrow = useCallback(() => {
    const el = viewport.current;
    heightBeforeRef.current =
      el && !atBottomRef.current && !nativeAnchor() ? el.scrollHeight : 0;
  }, [viewport]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: target 只用于判断当前批次是否已追完
  useLayoutEffect(() => {
    const el = viewport.current;
    const prevStart = startRef.current;
    startRef.current = startIndex;
    const before = heightBeforeRef.current;
    heightBeforeRef.current = 0;
    const userAnchor = userAnchorRef.current;
    userAnchorRef.current = null;
    if (!el || startIndex >= prevStart) {
      // 这个频道的首帧（或内容第一次到时）跟着底部的话，当场钉到底，不要等 rAF。
      // 只钉一次，避免流式输出每帧都读 scrollHeight。恢复中间位置不钉。
      // 短对话全挂、高度往往不够一屏：不必读 scrollHeight（scroll-reads 回归也靠这一点）。
      const needsPin =
        startIndex > 0 ||
        pending ||
        (options?.marks?.length ?? 0) > TAIL_FIRST_THRESHOLD;
      if (
        el &&
        !firstPinnedRef.current &&
        needsPin &&
        atBottomRef.current &&
        options?.followBottom !== false
      ) {
        withoutSmoothScroll(el, () => {
          el.scrollTop = el.scrollHeight;
        });
        firstPinnedRef.current = true;
      }
      return;
    }
    // 主动补行（或有原生锚定的空闲补行）期间告诉贴底观察器别当场量布局。
    if (userAnchor || nativeAnchor()) {
      // 这次提交的 MutationObserver 回调（微任务，排在 DOM 变动时）先于下面这个微任务跑：
      // 它们看到标记就不当场量布局（jank P1-2 复审：每批两次强制样式 + 布局）。
      el.setAttribute(TAIL_BACKFILL_ATTR, "");
      queueMicrotask(() => el.removeAttribute(TAIL_BACKFILL_ATTR));
    }
    // 点「显示更早的消息」：按记下的锚同步恢复，不要走贴底（内容不够一屏时 atBottom 也是 true，
    // 以前会在下一帧把视口动画钉回底部，正在看的行飞出屏幕约 1 秒）。
    if (userAnchor && restoreScrollAnchor(el, userAnchor)) {
      // 内容原本不够一屏（scrollTop 0 也算贴底）：新的高度全在上面，恢复要的 scrollTop 比能滚到的还大，
      // 被夹在最底，正在看的行掉到视口底部（QA #519 r2 P2-1：偏 408px）。差多少请留白垫多少，再恢复一次。
      // 垫完之后「最底」正好就是锚点位置，后面任何贴底都不会再挪它。
      const short = anchorShortfall(el, userAnchor);
      if (short > 0 && requestAnchorSlack(el, short)) {
        restoreScrollAnchor(el, userAnchor);
      }
      return;
    }
    if (atBottomRef.current) {
      // 原生锚定在补行时已经让底部那几行不动；补完那一批钉一次底。没有原生锚定就每批当场钉。
      if (!nativeAnchor()) el.scrollTop = el.scrollHeight;
      else if (startIndex === 0 || renderedMounted >= target) {
        // 放到下一帧：在这次提交里读 scrollHeight 会把最后一批（最大的一批）的样式重算 + 布局
        // 强制塞进同一个长任务（复审 trace：约 300ms）。下一帧本来就要算样式，读它不多花。
        cancelAnimationFrame(pinFrameRef.current);
        const key = keyRef.current;
        pinFrameRef.current = requestAnimationFrame(() => {
          pinFrameRef.current = 0;
          // 换了频道就不钉：否则会把新频道（keep-alive 恢复的上滑位置）拽到底。
          if (keyRef.current !== key) return;
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
    const el = viewport.current;
    if (el) userAnchorRef.current = captureScrollAnchor(el);
    measureBeforeGrow();
    setMounted((m) => nextMountedCount(nextMountedCount(m, total), total));
  }, [measureBeforeGrow, total, viewport]);

  useEffect(() => () => cancelAnimationFrame(pinFrameRef.current), []);

  /*
   * 兜底（聊天记录消失，2026-11-10）：补完了（或封顶了）、上面还有历史，挂着的行却一行都看不见
   * （过程行默认整格 display:none，判断看得见的那一份又漏了）——接着往前补，不受 TAIL_FIRST_CAP 限制，
   * 直到露出一行或者挂到头。只在不补行的时候查一次 DOM，不读布局。
   */
  useEffect(() => {
    if (pending || !truncated) return;
    if (hasVisibleRow(viewport.current)) return;
    measureBeforeGrow();
    setMounted((m) => nextMountedCount(m, total));
  });

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onScroll = () => {
      atBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (el.scrollTop < 480) prependHistory();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener(MOUNT_ALL_HISTORY_EVENT, mountAll);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener(MOUNT_ALL_HISTORY_EVENT, mountAll);
    };
  }, [viewport, prependHistory, mountAll]);

  useEffect(() => {
    // scrollKey: restart catch-up when the channel identity changes (same total is common).
    void scrollKey;
    let cancelled = false;
    let cancel = () => {};
    const goal = catchUpTarget(total, full);
    const step = () => {
      cancel = scheduleIdle(() => {
        if (cancelled) return;
        measureBeforeGrow();
        setMounted((m) => {
          // 已排队的更新在换频道后才执行：不再给新频道多挂、也不再续排旧频道的下一批。
          if (cancelled || m >= goal) return m;
          const n = Math.min(nextMountedCount(m, total), goal);
          if (n < goal) step();
          return n;
        });
      });
    };
    step();
    return () => {
      cancelled = true;
      cancel();
      cancelAnimationFrame(pinFrameRef.current);
      pinFrameRef.current = 0;
    };
  }, [scrollKey, total, full, measureBeforeGrow]);

  return {
    startIndex,
    pending,
    truncated,
    mountAll,
    prependHistory,
  };
}

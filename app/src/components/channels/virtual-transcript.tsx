import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type CacheSnapshot,
  Virtualizer,
  type VirtualizerHandle,
} from "virtua";
import { IconChevronDown, IconChevronUp, IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMessageScroller } from "@/components/ui/message-scroller";
import { MESSAGE_FLASH_CLASS } from "@/lib/channels/focus-message";
import type {
  TranscriptDataLayer,
  TranscriptScrollOptions,
} from "@/lib/chat/transcript-data-layer";
import {
  findTranscriptMatches,
  REVEAL_MESSAGE_EVENT,
  isPrepend,
  stepMatch,
  TranscriptSizeCache,
  VIRTUAL_BUFFER_PX,
} from "@/lib/chat/virtual-transcript";

/**
 * 长对话虚拟化的渲染层（jank P3-3，flag `virtualTranscript` 后面）。
 *
 * 结构：滚动容器还是原来的 `MessageScrollerViewport`（贴底、留白 §88/§94、回到底部按钮、键盘都照旧），
 * 里面除了末尾常驻的几行，其余的行交给 virtua 的 `Virtualizer`（`scrollRef` 指向这个滚动容器）。
 * - 行高：virtua 用 ResizeObserver 实测；离开时把快照按会话 key + 消息 id 存进 `transcriptSizeCache`，切回复用。
 * - 前插历史：第一行往后挪了就开 `shift`，视口内容不动（tail-first 的补行 / scrollHeight 补偿整条不走）。
 * - 流式：最后几行不在虚拟列表里（常驻，见 VIRTUAL_TAIL_ROWS），贴底跟随仍由原来的滚动容器做，人上滑时不抢。
 */

export type VirtualCell = { id: string; node: ReactNode };

/** 全局一份：按会话 key 存行高快照。KeepAlive（P1-3）卸载会话时调 `release(key)`。 */
export const transcriptSizeCache = new TranscriptSizeCache<CacheSnapshot>();

/** 每个 cell 下面补的间距，等于原来 `MessageScrollerContent` 的 gap-6。 */
const CELL_CLASS = "min-w-0 pb-6";

export function VirtualTranscriptRows({
  cells,
  scrollKey,
  viewportRef,
  handleRef,
  layoutKey,
}: {
  cells: readonly VirtualCell[];
  scrollKey: string;
  viewportRef: RefObject<HTMLElement | null>;
  handleRef: RefObject<VirtualizerHandle | null>;
  /** 虚拟列表上面的东西变了（置顶提示出现 / 消失）时换值，重新量 startMargin。 */
  layoutKey?: unknown;
}) {
  const ids = useMemo(() => cells.map((cell) => cell.id), [cells]);
  const previousIds = useRef<readonly string[]>(ids);
  const shift = isPrepend(previousIds.current, ids);
  useLayoutEffect(() => {
    previousIds.current = ids;
  });

  // 只在挂上时取一次：之后 virtua 自己维护。
  const [cache] = useState(() => transcriptSizeCache.restore(scrollKey, ids));

  // 卸载（换对话 / KeepAlive 淘汰之前）时存快照。
  const idsRef = useRef(ids);
  idsRef.current = ids;
  useLayoutEffect(() => {
    return () => {
      const handle = handleRef.current;
      if (!handle) return;
      transcriptSizeCache.save(scrollKey, idsRef.current, handle.cache, (i) =>
        handle.getItemSize(i),
      );
    };
  }, [scrollKey, handleRef]);

  // 虚拟列表顶上到滚动内容顶上的距离（上面有 padding / 置顶提示）。只在挂上和上面变了时量。
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [startMargin, setStartMargin] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutKey 就是用来触发重新量的
  useLayoutEffect(() => {
    const box = boxRef.current;
    const viewport = viewportRef.current;
    if (!box || !viewport) return;
    const top =
      box.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top +
      viewport.scrollTop;
    const next = Math.max(0, Math.round(top));
    setStartMargin((m) => (m === next ? m : next));
  }, [viewportRef, layoutKey]);

  return (
    <div
      ref={boxRef}
      className="min-w-0"
      data-testid="virtual-transcript"
      data-virtual-rows={cells.length}
    >
      <Virtualizer
        bufferSize={VIRTUAL_BUFFER_PX}
        cache={cache}
        data={cells as VirtualCell[]}
        ref={handleRef}
        scrollRef={viewportRef}
        shift={shift}
        startMargin={startMargin}
      >
        {(cell) => (
          <div className={CELL_CLASS} data-virtual-cell={cell.id} key={cell.id}>
            {cell.node}
          </div>
        )}
      </Virtualizer>
    </div>
  );
}

/**
 * virtua 版的 TranscriptDataLayer（与 #446 的 `useTailFirstDataLayer` 同一接口），必须在
 * `MessageScrollerProvider` 里面调。
 * - prependHistory：数据层已经把整段给了渲染层，virtua 只挂视口附近的行，所以这里不需要扩窗；
 *   真正的前插（items 第一行变了）由 `shift` 保位。
 * - scrollToBottom：最后一行常驻在滚动容器里，交给原来的 scrollToEnd（§94 留白逻辑不变）。
 * - scrollToMessage：先 id → index；在虚拟列表里的用 scrollToIndex，常驻的交给原来的 scrollToMessage。
 */
export function useVirtuaDataLayer<Row extends { id: string }>(
  items: readonly Row[],
  virtualIds: readonly string[],
  handleRef: RefObject<VirtualizerHandle | null>,
): TranscriptDataLayer<Row> {
  const { scrollToEnd, scrollToMessage } = useMessageScroller();
  const indexRef = useRef(new Map<string, number>());
  indexRef.current = useMemo(() => {
    const map = new Map<string, number>();
    virtualIds.forEach((id, i) => map.set(id, i));
    return map;
  }, [virtualIds]);
  const prependHistory = useCallback(() => {}, []);
  return useMemo(
    () => ({
      items,
      prependHistory,
      scrollToBottom: (options?: TranscriptScrollOptions) =>
        scrollToEnd(options),
      scrollToMessage: (id: string, options?: TranscriptScrollOptions) => {
        const index = indexRef.current.get(id);
        const handle = handleRef.current;
        if (index !== undefined && handle) {
          handle.scrollToIndex(index, {
            align:
              options?.align === "nearest"
                ? "nearest"
                : (options?.align ?? "center"),
            smooth: options?.behavior === "smooth",
          });
          return true;
        }
        return scrollToMessage(id, options);
      },
    }),
    [items, prependHistory, scrollToEnd, scrollToMessage, handleRef],
  );
}

/**
 * 给以后接 P1-3 `useKeptSlot().registerScroll({save, restore})` 用：虚拟列表下滚动位置就是 virtua 的 offset。
 */
export function virtualScrollSlot(
  handleRef: RefObject<VirtualizerHandle | null>,
) {
  return {
    save: () => handleRef.current?.scrollOffset ?? 0,
    restore: (offset: number) => handleRef.current?.scrollTo(offset),
  };
}

/** 应用内搜索里当前命中的那一行带的标记（高亮复用 `message-flash`，不加新样式）。 */
export const FIND_CURRENT_ATTR = "data-find-current";

/**
 * 会话内 Ctrl+F（只在虚拟化打开时拦截：未挂载的行浏览器搜不到）。
 * 在数据里搜，命中后经数据层滚到那一行（未挂载返回 false 就下一帧重试），再给那一行闪一下高亮。
 */
export function TranscriptFindBar<Row extends { id: string }>({
  dataLayer,
  textOf,
  viewportRef,
  onClose,
}: {
  dataLayer: TranscriptDataLayer<Row>;
  textOf: (row: Row) => string | null;
  viewportRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(-1);
  const hits = useMemo(
    () => findTranscriptMatches(dataLayer.items, query, textOf),
    [dataLayer.items, query, textOf],
  );
  // 搜索词变了从最新（最下面）那条开始，和浏览器从视口附近开始的手感接近。
  useEffect(() => {
    setCurrent(hits.length > 0 ? hits.length - 1 : -1);
  }, [hits]);

  const target = current >= 0 ? hits[current] : undefined;
  const layerRef = useRef(dataLayer);
  layerRef.current = dataLayer;
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    let frame = 0;
    let tries = 0;
    let marked: HTMLElement | null = null;
    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    const mark = () => {
      if (cancelled) return;
      const row = viewportRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(target)}"]`,
      );
      if (!row) {
        if (tries++ < 30) frame = requestAnimationFrame(attempt);
        return;
      }
      marked = row;
      row.setAttribute(FIND_CURRENT_ATTR, "");
      row.classList.remove(MESSAGE_FLASH_CLASS);
      void row.offsetWidth;
      row.classList.add(MESSAGE_FLASH_CLASS);
      flashTimer = setTimeout(
        () => row.classList.remove(MESSAGE_FLASH_CLASS),
        2400,
      );
    };
    const attempt = () => {
      if (cancelled) return;
      if (!layerRef.current.scrollToMessage(target, { align: "center" })) {
        if (tries++ < 30) frame = requestAnimationFrame(attempt);
        return;
      }
      frame = requestAnimationFrame(mark);
    };
    attempt();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (flashTimer) clearTimeout(flashTimer);
      marked?.removeAttribute(FIND_CURRENT_ATTR);
      marked?.classList.remove(MESSAGE_FLASH_CLASS);
    };
  }, [target, viewportRef]);

  const step = (delta: 1 | -1) =>
    setCurrent((c) => stepMatch(c, hits.length, delta));

  return (
    <div
      role="search"
      aria-label="在对话中查找"
      className="absolute top-2 right-4 z-20 flex items-center gap-1 rounded-md border border-border bg-background p-1 shadow-sm"
      data-testid="transcript-find"
    >
      <Input
        aria-label="查找"
        autoFocus
        className="h-7 w-48"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey ? 1 : -1);
          }
        }}
        placeholder="在对话中查找"
        value={query}
      />
      <span
        aria-live="polite"
        className="min-w-12 text-center text-muted-foreground text-xs tabular-nums"
        data-testid="transcript-find-count"
      >
        {query.trim()
          ? `${hits.length === 0 ? 0 : current + 1}/${hits.length}`
          : ""}
      </span>
      <Button
        aria-label="上一个"
        disabled={hits.length === 0}
        onClick={() => step(-1)}
        size="icon-sm"
        variant="ghost"
      >
        <IconChevronUp />
      </Button>
      <Button
        aria-label="下一个"
        disabled={hits.length === 0}
        onClick={() => step(1)}
        size="icon-sm"
        variant="ghost"
      >
        <IconChevronDown />
      </Button>
      <Button
        aria-label="关闭查找"
        onClick={onClose}
        size="icon-sm"
        variant="ghost"
      >
        <IconX />
      </Button>
    </div>
  );
}

/** 这段对话可见（不是 KeepAlive 藏起来的那几段）时，Ctrl/⌘+F 打开应用内搜索。 */
export function useFindShortcut(
  enabled: boolean,
  viewportRef: RefObject<HTMLElement | null>,
  open: () => void,
) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() !== "f") return;
      const viewport = viewportRef.current;
      // KeepAlive 藏起来的会话带 inert（P1-3），不抢。
      if (!viewport?.isConnected || viewport.closest("[inert],[hidden]"))
        return;
      event.preventDefault();
      open();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, viewportRef, open]);
}

/**
 * 虚拟化下挂在 `MessageScroller` 里面的那部分：拿数据层（必须在 Provider 里）、接 `?message=` 的 reveal、
 * Ctrl+F 和搜索框。flag 关着时整个不渲染，旧路径不多调一个 hook。
 */
export function VirtualTranscriptControls<Row extends { id: string }>({
  items,
  virtualIds,
  handleRef,
  viewportRef,
  layerRef,
  textOf,
}: {
  items: readonly Row[];
  virtualIds: readonly string[];
  handleRef: RefObject<VirtualizerHandle | null>;
  viewportRef: RefObject<HTMLElement | null>;
  layerRef: { current: TranscriptDataLayer<Row> | null };
  textOf: (row: Row) => string | null;
}) {
  const dataLayer = useVirtuaDataLayer(items, virtualIds, handleRef);
  layerRef.current = dataLayer;
  useEffect(
    () => () => {
      layerRef.current = null;
    },
    [layerRef],
  );
  useEffect(() => {
    const onReveal = (event: Event) => {
      const id = (event as CustomEvent<{ messageId?: string }>).detail
        ?.messageId;
      const layer = layerRef.current;
      if (id && layer?.items.some((item) => item.id === id))
        layer.scrollToMessage(id, { align: "center" });
    };
    window.addEventListener(REVEAL_MESSAGE_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_MESSAGE_EVENT, onReveal);
  }, [layerRef]);
  const [findOpen, setFindOpen] = useState(false);
  const openFind = useCallback(() => setFindOpen(true), []);
  useFindShortcut(true, viewportRef, openFind);
  return findOpen ? (
    <TranscriptFindBar
      dataLayer={dataLayer}
      onClose={() => setFindOpen(false)}
      textOf={textOf}
      viewportRef={viewportRef}
    />
  ) : null;
}

/**
 * 面板看板（2026-10-22，docs/live-panel-sources.md 第 2 节）。
 *
 * 右栏宽 ≥ 480px 时最多两张并排、中间拖动调比例；窄窗口抽屉里永远单列。拖动标题左边的握把，
 * 放到另一张卡上就并进那一行 / 换位，放到列表空白处就单独一行；每张卡底部一条细横条拖高
 * （最小 120px，内部滚动，双击回自动）；点标题折叠（只留标题行，落盘，并且不再取数）。
 *
 * 拖动期刻意不 setState：指针事件只改 DOM（高亮、分隔条 / 卡高），松手才提交一次布局——
 * 和 `panel-rail.tsx` 拖栏宽同一个理由，右栏里挂着实时面板和各自的轮询，逐帧渲染整栏会卡。
 */
import { IconGripVertical } from "@tabler/icons-react";
import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  canPairPanels,
  clampPanelHeight,
  clampPanelRatio,
  dropPanelOnOwnRow,
  dropPanelOnPanel,
  emptyPanelLayout,
  isPanelCollapsed,
  movePanelRow,
  PANEL_MAX_HEIGHT,
  PANEL_MIN_HEIGHT,
  PANEL_RATIO_STEP,
  pairPanelWith,
  type PanelLayout,
  readPanelLayout,
  reconcilePanelLayout,
  rowGridTemplate,
  samePanelLayout,
  setPanelCollapsed,
  setPanelHeight,
  setRowRatio,
  visiblePanelRows,
  writePanelLayout,
} from "@/lib/panels/panel-layout";

/** 看板交给卡片的三样东西：折叠状态、折叠开关（点标题）、标题左边的拖动握把。 */
export type PanelBoardChrome = {
  collapsed: boolean;
  toggleCollapsed: () => void;
  grip: ReactNode;
};

export type PanelBoardProps<T extends { id: string; title: string }> = {
  botId: string;
  panels: readonly T[];
  /** 右栏实测宽度（PanelRail 量好传进来）；为 0 时退回卡片自己量到的宽度。 */
  width: number;
  /** 窄窗口抽屉：永远单列。 */
  drawer?: boolean;
  renderCard: (panel: T, chrome: PanelBoardChrome) => ReactNode;
};

type CardHit = { kind: "card"; target: HTMLElement; id: string; side: "before" | "after" };
type BlankHit = { kind: "blank"; index: number };
type DropHit = CardHit | BlankHit;

type DragState = {
  id: string;
  pointerId: number;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  moved: boolean;
  /** 拖起来那一刻这张卡的位置：落回自己身上不算「放到空白处」。 */
  sourceRect: DOMRect | null;
};
type RatioDrag = {
  row: number;
  element: HTMLElement;
  rect: DOMRect;
  pointerId: number;
  ratio: number;
};
type HeightDrag = {
  id: string;
  slot: HTMLElement;
  startY: number;
  startHeight: number;
  pointerId: number;
  height: number;
  moved: boolean;
};

export function PanelBoard<T extends { id: string; title: string }>({
  botId,
  panels,
  width,
  drawer = false,
  renderCard,
}: PanelBoardProps<T>) {
  const ids = panels.map((panel) => panel.id);
  const idsKey = ids.join("\n");
  const idsRef = useRef(ids);
  idsRef.current = ids;

  const [layout, setLayout] = useState<PanelLayout>(() => {
    const saved = readPanelLayout(botId);
    // 面板列表还在路上（第一次打开）：先留着记下的布局，等列表到了再对齐，别把行擦掉。
    return ids.length > 0 ? reconcilePanelLayout(ids, saved) : (saved ?? emptyPanelLayout());
  });
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const [dragId, setDragId] = useState<string | null>(null);
  const [resizing, setResizing] = useState(false);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<DragState | null>(null);
  const ratioDrag = useRef<RatioDrag | null>(null);
  const heightDrag = useRef<HeightDrag | null>(null);
  /** 拖动时被标成落点的卡片：直接改 DOM，不走 React。 */
  const highlighted = useRef<HTMLElement | null>(null);

  const commit = useCallback(
    (next: PanelLayout) => {
      if (samePanelLayout(next, layoutRef.current)) return;
      layoutRef.current = next;
      setLayout(next);
      writePanelLayout(botId, next);
    },
    [botId],
  );

  /*
   * 服务器列表变了 / 换了机器人：把记下的布局与现在这批面板对齐。
   * 换机器人要重新读它自己的那份（同一台设备、按机器人记，DESIGN.md §88）。
   */
  const layoutBot = useRef(botId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: idsKey 变化（面板增删）时也要重新对齐，effect 里读的是 ref。
  useEffect(() => {
    const switched = layoutBot.current !== botId;
    // 还没有面板（列表在加载 / 这个机器人确实没有面板）：不动记下的布局，也不把「换过机器人」这件事记账。
    if (idsRef.current.length === 0) return;
    const base = switched ? readPanelLayout(botId) : layoutRef.current;
    layoutBot.current = botId;
    const next = reconcilePanelLayout(idsRef.current, base);
    if (samePanelLayout(next, layoutRef.current)) return;
    setLayout(next);
    writePanelLayout(botId, next);
  }, [botId, idsKey]);

  /*
   * 并排与否看右栏宽度（PanelRail 拖动时量好的那个数，≥480 才并排）。ResizeObserver 只是兜底：
   * 没有传宽度时（别处单独用 PanelBoard）退回卡片自己量到的宽度。
   */
  const [measured, setMeasured] = useState(0);
  useEffect(() => {
    const node = boardRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      // 被 KeepAlive 藏起来时宽度是 0：不记，回来时就不会因为 0→原值多渲染一遍。
      if (rect && rect.width > 0) setMeasured(Math.round(rect.width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const availableWidth = width > 0 ? width : measured;
  const allowPair = canPairPanels(availableWidth, drawer);
  const rows = visiblePanelRows(layout, allowPair);

  const clearDropMarks = () => {
    const node = highlighted.current;
    if (node) {
      node.classList.remove("is-drop-target");
      delete node.dataset.dropSide;
      highlighted.current = null;
    }
    if (boardRef.current) delete boardRef.current.dataset.dropBlank;
  };

  /** 指针下面是哪张卡（落在左半还是右半），或者落在第几行之间。 */
  const hitTest = (x: number, y: number, sourceId: string): DropHit => {
    const element = document.elementFromPoint(x, y) as HTMLElement | null;
    const slot = element?.closest<HTMLElement>("[data-live-panel-slot]") ?? null;
    const id = slot?.dataset.livePanelSlot;
    if (slot && id && id !== sourceId) {
      const rect = slot.getBoundingClientRect();
      return {
        kind: "card",
        target: slot,
        id,
        side: x < rect.left + rect.width / 2 ? "before" : "after",
      };
    }
    const rowNodes = boardRef.current
      ? [...boardRef.current.querySelectorAll<HTMLElement>("[data-live-board-row]")]
      : [];
    let index = rowNodes.length;
    for (let at = 0; at < rowNodes.length; at += 1) {
      const node = rowNodes[at];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        index = at;
        break;
      }
    }
    return { kind: "blank", index };
  };

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const slot = event.currentTarget.closest<HTMLElement>("[data-live-panel-slot]");
    drag.current = {
      id,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      fromX: event.clientX,
      fromY: event.clientY,
      moved: false,
      sourceRect: slot?.getBoundingClientRect() ?? null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragId(id);
    clearDropMarks();
  };

  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    state.x = event.clientX;
    state.y = event.clientY;
    if (!state.moved && Math.hypot(state.x - state.fromX, state.y - state.fromY) < 4) return;
    state.moved = true;
    // 逐帧只改类名 / 属性（不放 state）：整栏不重排，拖动跟手。
    clearDropMarks();
    const hit = hitTest(state.x, state.y, state.id);
    if (hit.kind === "card") {
      hit.target.classList.add("is-drop-target");
      hit.target.dataset.dropSide = hit.side;
      highlighted.current = hit.target;
    } else if (boardRef.current) {
      boardRef.current.dataset.dropBlank = "1";
    }
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>, apply: boolean) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    // 只是点了一下握把、或者又放回自己身上：不重排。
    const rect = state.sourceRect;
    const onSelf =
      rect !== null &&
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    const boardRect = boardRef.current?.getBoundingClientRect();
    const insideBoard =
      boardRect !== undefined &&
      event.clientX >= boardRect.left &&
      event.clientX <= boardRect.right &&
      event.clientY >= boardRect.top &&
      event.clientY <= boardRect.bottom;
    // 拖出右栏才松手：当作取消，不把卡片甩到列表最后。
    const hit = apply && state.moved && !onSelf && insideBoard ? hitTest(event.clientX, event.clientY, state.id) : null;
    clearDropMarks();
    setDragId(null);
    if (!hit) return;
    if (hit.kind === "card") {
      commit(dropPanelOnPanel(layoutRef.current, state.id, hit.id, hit.side));
    } else {
      commit(dropPanelOnOwnRow(layoutRef.current, state.id, hit.index));
    }
  };

  /** 指针被系统收回（窗口失焦、触摸被抢走）：只收摊，不提交。 */
  const cancelDrag = () => {
    drag.current = null;
    clearDropMarks();
    setDragId(null);
  };

  const cancelRatio = () => {
    const state = ratioDrag.current;
    ratioDrag.current = null;
    setResizing(false);
    if (state) state.element.style.gridTemplateColumns = rowGridTemplate(layoutRef.current.ratios[state.row]?.[0] ?? 0.5);
  };

  const cancelHeight = () => {
    const state = heightDrag.current;
    heightDrag.current = null;
    setResizing(false);
    if (!state) return;
    const committed = layoutRef.current.heights[state.id];
    if (committed) state.slot.style.height = `${committed}px`;
    else {
      state.slot.style.height = "";
      delete state.slot.dataset.height;
    }
  };

  const onGripKey = (event: ReactKeyboardEvent<HTMLButtonElement>, id: string) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      commit(movePanelRow(layoutRef.current, id, event.key === "ArrowUp" ? -1 : 1));
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      commit(pairPanelWith(layoutRef.current, id, event.key === "ArrowLeft" ? -1 : 1));
    }
  };

  const startRatio = (event: ReactPointerEvent<HTMLDivElement>, rowIndex: number) => {
    if (event.button !== 0) return;
    const element = event.currentTarget.parentElement;
    if (!(element instanceof HTMLElement)) return;
    event.preventDefault();
    ratioDrag.current = {
      row: rowIndex,
      element,
      rect: element.getBoundingClientRect(),
      pointerId: event.pointerId,
      ratio: layoutRef.current.ratios[rowIndex]?.[0] ?? 0.5,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  };

  const moveRatio = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = ratioDrag.current;
    if (!state || state.pointerId !== event.pointerId || state.rect.width <= 0) return;
    const ratio = clampPanelRatio((event.clientX - state.rect.left) / state.rect.width);
    state.ratio = ratio;
    state.element.style.gridTemplateColumns = rowGridTemplate(ratio);
  };

  const endRatio = (event: ReactPointerEvent<HTMLDivElement>, apply: boolean) => {
    const state = ratioDrag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    ratioDrag.current = null;
    setResizing(false);
    if (apply) {
      commit(setRowRatio(layoutRef.current, state.row, state.ratio));
    } else {
      // 取消（指针被系统收回）：把拖动期直接写进去的列宽还原成提交过的值。
      const current = layoutRef.current.ratios[state.row]?.[0] ?? 0.5;
      state.element.style.gridTemplateColumns = rowGridTemplate(current);
    }
  };

  const onRatioKey = (event: ReactKeyboardEvent<HTMLDivElement>, rowIndex: number, ratio: number) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    commit(
      setRowRatio(
        layoutRef.current,
        rowIndex,
        ratio + (event.key === "ArrowLeft" ? -PANEL_RATIO_STEP : PANEL_RATIO_STEP),
      ),
    );
  };

  const startHeight = (event: ReactPointerEvent<HTMLDivElement>, id: string) => {
    if (event.button !== 0) return;
    const slot = event.currentTarget.closest<HTMLElement>("[data-live-panel-slot]");
    if (!slot) return;
    event.preventDefault();
    const startHeight = layoutRef.current.heights[id] ?? slot.getBoundingClientRect().height;
    const height = clampPanelHeight(startHeight);
    heightDrag.current = {
      id,
      slot,
      startY: event.clientY,
      startHeight: height,
      pointerId: event.pointerId,
      height,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  };

  const moveHeight = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = heightDrag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (!state.moved && Math.abs(event.clientY - state.startY) < 2) return;
    state.moved = true;
    const next = clampPanelHeight(state.startHeight + (event.clientY - state.startY));
    state.height = next;
    // 拖动期只写这一张卡的高度：整栏不重排，内容区在卡里滚动。
    state.slot.style.height = `${next}px`;
    state.slot.dataset.height = "1";
  };

  const endHeight = (event: ReactPointerEvent<HTMLDivElement>, apply: boolean) => {
    const state = heightDrag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    heightDrag.current = null;
    setResizing(false);
    if (apply && state.moved) {
      commit(setPanelHeight(layoutRef.current, state.id, state.height));
      return;
    }
    const committed = layoutRef.current.heights[state.id];
    if (committed) state.slot.style.height = `${committed}px`;
    else {
      state.slot.style.height = "";
      delete state.slot.dataset.height;
    }
  };

  const resetHeight = (event: ReactMouseEvent<HTMLDivElement>, id: string) => {
    event.preventDefault();
    const slot = event.currentTarget.closest<HTMLElement>("[data-live-panel-slot]");
    if (slot) {
      slot.style.height = "";
      delete slot.dataset.height;
    }
    commit(setPanelHeight(layoutRef.current, id, null));
  };

  const onHeightKey = (event: ReactKeyboardEvent<HTMLDivElement>, id: string, slot: HTMLElement | null) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const current = layoutRef.current.heights[id] ?? slot?.getBoundingClientRect().height ?? PANEL_MIN_HEIGHT;
    commit(
      setPanelHeight(
        layoutRef.current,
        id,
        Math.min(PANEL_MAX_HEIGHT, Math.max(PANEL_MIN_HEIGHT, current + (event.key === "ArrowUp" ? -20 : 20))),
      ),
    );
  };

  return (
    <div
      className={dragId || resizing ? "live-board is-dragging" : "live-board"}
      data-dragging={dragId ? "1" : undefined}
      ref={boardRef}
    >
      {rows.map((row, rowIndex) => {
        const paired = allowPair && row.ids.length > 1;
        return (
          <div
            className="live-board-row"
            data-live-board-row={rowIndex}
            data-pair={paired ? "1" : undefined}
            key={row.ids.join("+")}
            style={paired ? { gridTemplateColumns: rowGridTemplate(row.ratio) } : undefined}
          >
            {row.ids.map((id, index) => {
              const panel = panels.find((item) => item.id === id);
              if (!panel) return null;
              const collapsed = isPanelCollapsed(layout, id);
              const height = layout.heights[id];
              const toggleCollapsed = () =>
                commit(setPanelCollapsed(layoutRef.current, id, !isPanelCollapsed(layoutRef.current, id)));
              const grip = (
                <button
                  aria-label={`拖动「${panel.title}」调整位置（方向键 ↕ 换行，↔ 并排或拆开）`}
                  className="live-panel-grip"
                  onKeyDown={(event) => onGripKey(event, id)}
                  onLostPointerCapture={cancelDrag}
                  onPointerCancel={(event) => endDrag(event, false)}
                  onPointerDown={(event) => startDrag(event, id)}
                  onPointerMove={moveDrag}
                  onPointerUp={(event) => endDrag(event, true)}
                  type="button"
                >
                  <IconGripVertical aria-hidden className="size-3.5" />
                </button>
              );
              return (
                <Fragment key={id}>
                  {index > 0 ? (
                    // biome-ignore lint/a11y/useSemanticElements: a draggable splitter has no native element.
                    <div
                      aria-label={`调整「${panel.title}」左边的宽度`}
                      aria-orientation="vertical"
                      aria-valuemax={75}
                      aria-valuemin={25}
                      aria-valuenow={Math.round(row.ratio * 100)}
                      aria-valuetext={`左边占 ${Math.round(row.ratio * 100)}%`}
                      className="live-board-vsep"
                      onKeyDown={(event) => onRatioKey(event, rowIndex, row.ratio)}
                      onLostPointerCapture={cancelRatio}
                      onPointerCancel={(event) => endRatio(event, false)}
                      onPointerDown={(event) => startRatio(event, rowIndex)}
                      onPointerMove={moveRatio}
                      onPointerUp={(event) => endRatio(event, true)}
                      role="separator"
                      tabIndex={0}
                    />
                  ) : null}
                  <div
                    className={dragId === id ? "live-board-slot is-dragging-source" : "live-board-slot"}
                    data-collapsed={collapsed ? "1" : undefined}
                    data-height={!collapsed && height ? "1" : undefined}
                    data-live-panel-slot={id}
                    style={!collapsed && height ? { height } : undefined}
                  >
                    {renderCard(panel, { collapsed, grip, toggleCollapsed })}
                    {collapsed ? null : (
                      // biome-ignore lint/a11y/useSemanticElements: a draggable height splitter has no native element.
                      <div
                        aria-label={`拖动调整「${panel.title}」的高度，双击回到自动高度`}
                        aria-orientation="horizontal"
                        aria-valuemax={PANEL_MAX_HEIGHT}
                        aria-valuemin={PANEL_MIN_HEIGHT}
                        aria-valuenow={height ?? undefined}
                        aria-valuetext={height ? `${height} 像素` : "自动高度"}
                        className="live-board-hbar"
                        onDoubleClick={(event) => resetHeight(event, id)}
                        onKeyDown={(event) => onHeightKey(event, id, event.currentTarget.closest<HTMLElement>("[data-live-panel-slot]"))}
                        onLostPointerCapture={cancelHeight}
                        onPointerCancel={(event) => endHeight(event, false)}
                        onPointerDown={(event) => startHeight(event, id)}
                        onPointerMove={moveHeight}
                        onPointerUp={(event) => endHeight(event, true)}
                        role="separator"
                        tabIndex={0}
                      />
                    )}
                  </div>
                </Fragment>
              );
            })}
          </div>
        );
      })}
      {dragId || resizing ? (
        <div aria-hidden className="live-board-drag-cover is-dragging" data-mode={dragId ? "move" : "resize"} />
      ) : null}
    </div>
  );
}


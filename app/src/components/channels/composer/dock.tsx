import {
  type PointerEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from "react";
import { useExternalConnection } from "@/hooks";
import { useSimpleMode } from "@/lib/simple-mode";
import { useCoarsePointer } from "@/lib/use-coarse-pointer";
import {
  applyDockDrag,
  clampDockRect,
  type DockDir,
  type DockRect,
} from "./dock-geometry";

const STORAGE_KEY = "chisabot.composer-dock";

const DIRS: readonly DockDir[] = ["n", "e", "s", "w", "ne", "nw", "se", "sw"];

function readDockRect(): DockRect | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<DockRect>;
    if (
      typeof v.x !== "number" ||
      typeof v.b !== "number" ||
      typeof v.w !== "number"
    ) {
      return null;
    }
    return { x: v.x, b: v.b, w: v.w, h: typeof v.h === "number" ? v.h : null };
  } catch {
    return null;
  }
}

function paneOf(box: HTMLElement | null): HTMLElement | null {
  return (
    (box?.offsetParent as HTMLElement | null) ?? box?.parentElement ?? null
  );
}

function applyDockStyle(
  box: HTMLDivElement,
  rect: DockRect | null,
  pill: boolean,
) {
  if (!rect) {
    delete box.dataset.docked;
    delete box.dataset.sized;
    box.style.left = "";
    box.style.bottom = "";
    box.style.width = "";
    box.style.height = "";
    box.style.right = "";
    box.style.top = "";
    box.style.margin = "";
    box.style.maxWidth = "";
    return;
  }
  const effectiveH = pill ? null : rect.h;
  box.dataset.docked = "true";
  if (effectiveH !== null) box.dataset.sized = "true";
  else delete box.dataset.sized;
  box.style.left = `${rect.x}px`;
  box.style.bottom = `${rect.b}px`;
  box.style.width = `${rect.w}px`;
  box.style.height = effectiveH !== null ? `${effectiveH}px` : "auto";
  box.style.right = "auto";
  box.style.top = "auto";
  box.style.margin = "0px";
  box.style.maxWidth = "none";
}

/**
 * 悬浮输入框底座：box 脱离文档流、绝对定位压在对话底边上，把手可四边/角拖动
 * 调整宽高，尺寸记进 localStorage。内容占据的底部高度写进面板 CSS 变量
 * `--chat-composer-h`，滚动区拿它加底部内边距，保证最后一条消息能滚到卡片上方。
 */
export function ComposerDock({
  dockRef,
  children,
}: {
  dockRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<DockRect | null>(readDockRect);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  // 收起横条没有「拉高」概念：DOM 里出现 .glass-composer-pill 时把 h 视为自然高。
  const [pill, setPill] = useState(false);
  const pillRef = useRef(pill);
  pillRef.current = pill;
  const coarse = useCoarsePointer();
  const simpleMode = useSimpleMode();
  const simpleModeRef = useRef(simpleMode);
  simpleModeRef.current = simpleMode;
  const lastInsetRef = useRef<number | null>(null);
  const appliedScrollPadRef = useRef<HTMLElement | null>(null);
  const appliedBottomPillRef = useRef<HTMLElement | null>(null);
  const scheduleSyncRef = useRef<() => void>(() => {});
  const drag = useRef<{
    dir: DockDir;
    px: number;
    py: number;
    start: DockRect;
    current: DockRect;
    moved: boolean;
    contentH: number;
    paneW: number;
    paneH: number;
  } | null>(null);

  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      boxRef.current = el;
      if (typeof dockRef === "function") {
        dockRef(el);
      } else if (dockRef) {
        (dockRef as RefObject<HTMLDivElement | null>).current = el;
      }
    },
    [dockRef],
  );

  const syncInset = useCallback(() => {
    const box = boxRef.current;
    const pane = paneOf(box);
    if (!box || !pane) return;
    const paneRect = pane.getBoundingClientRect();
    // 内容顶边 = box 内最靠上的可见子节点（提示卡 / 附件条 / 表单谁高算谁），
    // 把手层不计入；composer-frame 本身会占满框，要取它里面的内容。
    let top = paneRect.bottom;
    const visit = (el: Element) => {
      top = Math.min(top, el.getBoundingClientRect().top);
    };
    for (const child of Array.from(box.children)) {
      if ((child as HTMLElement).dataset.dockHandles !== undefined) continue;
      if (child.classList.contains("composer-frame")) {
        for (const inner of Array.from(child.children)) visit(inner);
      } else {
        visit(child);
      }
    }
    const nextInset = Math.max(0, Math.round(paneRect.bottom - top));
    const scrollPad = pane.querySelector<HTMLElement>(".chat-scroll-pad");
    const bottomPill = pane.querySelector<HTMLElement>(".chat-bottom-pill");
    if (
      lastInsetRef.current === nextInset &&
      appliedScrollPadRef.current === scrollPad &&
      appliedBottomPillRef.current === bottomPill
    ) {
      return;
    }
    lastInsetRef.current = nextInset;
    // 不在包裹 4,500+ 消息节点的 pane 上写继承型 --chat-composer-h（单次触发 ~200ms 全树 RecalcStyle）；
    // 直接给 .chat-scroll-pad 写非继承 padding-bottom（只标脏 1 节点），给叶子按钮 .chat-bottom-pill 写 --chat-composer-h。
    if (
      appliedScrollPadRef.current &&
      appliedScrollPadRef.current !== scrollPad
    ) {
      appliedScrollPadRef.current.style.removeProperty("padding-bottom");
    }
    if (scrollPad) {
      scrollPad.style.paddingBottom = `calc(24px + ${nextInset}px)`;
    }
    appliedScrollPadRef.current = scrollPad;
    if (
      appliedBottomPillRef.current &&
      appliedBottomPillRef.current !== bottomPill
    ) {
      appliedBottomPillRef.current.style.removeProperty("--chat-composer-h");
    }
    if (bottomPill) {
      bottomPill.style.setProperty("--chat-composer-h", `${nextInset}px`);
    }
    appliedBottomPillRef.current = bottomPill;
  }, []);

  useExternalConnection(true, () => {
    const box = boxRef.current;
    const pane = paneOf(box);
    if (!box || !pane) return;

    let rafId: number | null = null;
    const observed = new Set<Element>();

    const syncPill = () => {
      const nextPill = Boolean(box.querySelector(".glass-composer-pill"));
      pillRef.current = nextPill;
      setPill((prev) => (prev === nextPill ? prev : nextPill));
    };

    const observeContent = (ro: ResizeObserver | null) => {
      if (!ro) return;
      const targets = new Set<Element>([box, pane]);
      for (const child of Array.from(box.children)) {
        if ((child as HTMLElement).dataset.dockHandles !== undefined) continue;
        targets.add(child);
        if (child.classList.contains("composer-frame")) {
          for (const inner of Array.from(child.children)) targets.add(inner);
        }
      }
      for (const el of observed) {
        if (!targets.has(el)) {
          ro.unobserve(el);
          observed.delete(el);
        }
      }
      for (const el of targets) {
        if (!observed.has(el)) {
          ro.observe(el);
          observed.add(el);
        }
      }
    };

    let ro: ResizeObserver | null = null;

    const runSync = (clamp: boolean) => {
      syncPill();
      observeContent(ro);
      syncInset();
      if (!clamp || drag.current || simpleModeRef.current) return;
      const r = rectRef.current;
      if (!r) return;
      const p = pane.getBoundingClientRect();
      const next = clampDockRect(r, { w: p.width, h: p.height });
      if (
        next.x !== r.x ||
        next.b !== r.b ||
        next.w !== r.w ||
        next.h !== r.h
      ) {
        setRect(next);
      }
    };

    let pendingClamp = false;
    const scheduleSync = (clamp = false) => {
      pendingClamp = pendingClamp || clamp;
      if (rafId !== null) return;
      if (typeof requestAnimationFrame !== "function") {
        const shouldClamp = pendingClamp;
        pendingClamp = false;
        runSync(shouldClamp);
        return;
      }
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const shouldClamp = pendingClamp;
        pendingClamp = false;
        runSync(shouldClamp);
      });
    };
    scheduleSyncRef.current = () => scheduleSync(false);

    // 内容高变化（编辑、附件条、横条⇄卡片）→ rAF 合并重算 inset；
    // 面板尺寸变化 → 把已存的悬浮框夹回面板内 + 重算 inset。
    ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            scheduleSync(true);
          });

    // 定高模式下点击「收起/展开」会替换内部 form，但 box 外高可能不变；冒泡 click 兜底一帧同步。
    const onBoxClick = () => scheduleSync(false);
    box.addEventListener("click", onBoxClick);

    runSync(false);

    return () => {
      scheduleSyncRef.current = () => {};
      if (rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
      box.removeEventListener("click", onBoxClick);
      ro?.disconnect();
      observed.clear();
      lastInsetRef.current = null;
      appliedScrollPadRef.current?.style.removeProperty("padding-bottom");
      appliedScrollPadRef.current = null;
      appliedBottomPillRef.current?.style.removeProperty("--chat-composer-h");
      appliedBottomPillRef.current = null;
      pane.style.removeProperty("--chat-composer-h");
    };
  });

  // 精简模式切入时中止残留拖拽、清除直接写进 DOM 的 inline 定位并重算底部留白；保留 localStorage，切回标准模式无缝还原。
  useExternalConnection(simpleMode ? "simple" : "standard", () => {
    const box = boxRef.current;
    if (simpleMode) {
      drag.current = null;
      if (box) applyDockStyle(box, null, pillRef.current);
    } else if (box && rectRef.current && !coarse) {
      applyDockStyle(box, rectRef.current, pillRef.current);
    }
    scheduleSyncRef.current();
  });

  const onHandleDown = useCallback(
    (dir: DockDir) => (event: PointerEvent<HTMLSpanElement>) => {
      if (event.button !== 0 || simpleModeRef.current) return;
      const box = boxRef.current;
      const pane = paneOf(box);
      if (!box || !pane) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const paneRect = pane.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const current = rectRef.current;
      const effH = pill ? null : (current?.h ?? null);
      const vertical = dir.includes("n") || dir.includes("s");
      const start: DockRect = {
        x: current?.x ?? boxRect.left - paneRect.left,
        b: current?.b ?? paneRect.bottom - boxRect.bottom,
        w: current?.w ?? boxRect.width,
        // 横条永远自然高；展开卡片第一次竖向拖时把当前高固化为起点。
        h: pill ? null : (effH ?? (vertical ? boxRect.height : null)),
      };
      drag.current = {
        dir,
        px: event.clientX,
        py: event.clientY,
        contentH: boxRect.height,
        paneW: paneRect.width,
        paneH: paneRect.height,
        start,
        current: start,
        moved: false,
      };
    },
    [pill],
  );

  const onHandleMove = useCallback((event: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    const box = boxRef.current;
    if (!d || !box) return;
    const next = applyDockDrag(
      d.start,
      d.dir,
      event.clientX - d.px,
      event.clientY - d.py,
      { w: d.paneW, h: d.paneH },
      d.contentH,
    );
    d.current = next;
    d.moved = true;
    applyDockStyle(box, next, pillRef.current);
    scheduleSyncRef.current();
  }, []);

  const onHandleEnd = useCallback((event: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* 浏览器已释放 */
    }
    if (d.moved) {
      rectRef.current = d.current;
      setRect(d.current);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(d.current));
      } catch {
        /* 存储不可用只影响持久化 */
      }
    }
  }, []);

  const resetDock = useCallback(() => {
    setRect(null);
    if (boxRef.current) applyDockStyle(boxRef.current, null, pillRef.current);
    scheduleSyncRef.current();
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* 同上 */
    }
  }, []);

  const docked = rect !== null && !coarse && !simpleMode;
  const effectiveH = pill ? null : (rect?.h ?? null);
  const sized = docked && effectiveH !== null;

  return (
    <div
      className="chat-composer-box"
      data-docked={docked || undefined}
      data-sized={sized || undefined}
      ref={setRefs}
      style={
        docked
          ? {
              left: rect.x,
              bottom: rect.b,
              width: rect.w,
              height: effectiveH ?? "auto",
              right: "auto",
              top: "auto",
              margin: 0,
              maxWidth: "none",
            }
          : undefined
      }
    >
      {children}
      {coarse || simpleMode ? null : (
        <div
          aria-hidden="true"
          className="chat-dock-handles"
          data-dock-handles=""
        >
          {DIRS.map((dir) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: 纯指针的悬浮调整把手——不是键盘可达控件，整个把手层已对读屏隐藏
            <span
              className={`chat-dock-handle chat-dock-${dir}`}
              key={dir}
              onDoubleClick={resetDock}
              onPointerCancel={onHandleEnd}
              onPointerDown={onHandleDown(dir)}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleEnd}
              title="拖动调整输入框大小，双击还原"
            />
          ))}
        </div>
      )}
    </div>
  );
}

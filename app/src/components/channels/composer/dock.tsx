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
  const coarse = useCoarsePointer();
  const drag = useRef<{
    dir: DockDir;
    px: number;
    py: number;
    start: DockRect;
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
    pane.style.setProperty(
      "--chat-composer-h",
      `${Math.max(0, Math.round(paneRect.bottom - top))}px`,
    );
  }, []);

  useExternalConnection(true, () => {
    const box = boxRef.current;
    const pane = paneOf(box);
    if (!box || !pane) return;

    const syncPill = () =>
      setPill(Boolean(box.querySelector(".glass-composer-pill")));
    const syncAll = () => {
      syncPill();
      syncInset();
    };

    // 内容高变化（编辑、附件条、横条⇄卡片）→ 重算 inset；
    // 面板尺寸变化 → 把已存的悬浮框夹回面板内 + 重算 inset。
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            syncInset();
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
          });
    ro?.observe(box);
    ro?.observe(pane);

    // 编辑器里打字每个字都在改 DOM：落在编辑区里的变动不触发同步，高度变化由上面的 RO 报。
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (
          !(
            m.target instanceof Element &&
            m.target.closest(".glass-composer-editor")
          )
        ) {
          syncAll();
          return;
        }
      }
    });
    mo.observe(box, { childList: true, subtree: true });
    syncAll();

    return () => {
      ro?.disconnect();
      mo.disconnect();
      pane.style.removeProperty("--chat-composer-h");
    };
  });

  const onHandleDown = useCallback(
    (dir: DockDir) => (event: PointerEvent<HTMLSpanElement>) => {
      if (event.button !== 0) return;
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
      drag.current = {
        dir,
        px: event.clientX,
        py: event.clientY,
        contentH: boxRect.height,
        paneW: paneRect.width,
        paneH: paneRect.height,
        start: {
          x: current?.x ?? boxRect.left - paneRect.left,
          b: current?.b ?? paneRect.bottom - boxRect.bottom,
          w: current?.w ?? boxRect.width,
          // 横条永远自然高；展开卡片第一次竖向拖时把当前高固化为起点。
          h: pill ? null : (effH ?? (vertical ? boxRect.height : null)),
        },
      };
    },
    [pill],
  );

  const onHandleMove = useCallback((event: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d) return;
    setRect(
      applyDockDrag(
        d.start,
        d.dir,
        event.clientX - d.px,
        event.clientY - d.py,
        { w: d.paneW, h: d.paneH },
        d.contentH,
      ),
    );
  }, []);

  const onHandleEnd = useCallback((event: PointerEvent<HTMLSpanElement>) => {
    if (!drag.current) return;
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* 浏览器已释放 */
    }
    const next = rectRef.current;
    if (next) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* 存储不可用只影响持久化 */
      }
    }
  }, []);

  const resetDock = useCallback(() => {
    setRect(null);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* 同上 */
    }
  }, []);

  const docked = rect !== null && !coarse;
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
      {coarse ? null : (
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

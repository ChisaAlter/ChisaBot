import { IconX } from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useTimeout } from "@/hooks";
import { EASE_OUT } from "@/lib/motion";

/**
 * A main pane with details beside it when there is room, or in a sheet on narrow windows.
 *
 * The open/closed state belongs to the caller, in practice a search parameter, so opening a detail
 * is a real navigation: it survives a reload, it can be linked to, and Back closes it.
 *
 * The pane is animated by width and the content inside it is given that width outright, so the
 * content is laid out once and the pane reveals it.
 */

const ANIMATION_DURATION_SECONDS = 0.3;
const CLOSE_CLEANUP_MS = 360;
const DEFAULT_DETAIL_WIDTH = 400;
const MIN_MAIN_WIDTH = 400;

/**
 * The content overlaps the tail of the pane rather than following it.
 *
 * Delaying content slightly but ending with the pane keeps the reveal as one motion.
 */
const CONTENT_ENTRANCE_SECONDS = 0.18;
const CONTENT_ENTRANCE_DELAY_SECONDS = 0.12;
const CONTENT_ENTRANCE_OFFSET = "translateY(8px)";

function DetailPanelPane({
  overlay,
  open,
  initialAnimate,
  onClose,
  onExited,
  title,
  detail,
  detailWidth,
}: {
  overlay: boolean;
  open: boolean;
  initialAnimate: boolean;
  onClose: () => void;
  onExited: () => void;
  title?: ReactNode;
  detail?: ReactNode;
  detailWidth: number;
}) {
  // Reduced motion keeps the fade, which explains the change, and drops the movement.
  const shouldReduceMotion = useReducedMotion();
  const openRef = useRef(open);
  openRef.current = open;

  const finishClose = useCallback(() => {
    if (!openRef.current) onExited();
  }, [onExited]);

  // 兜底卸载：在无 CSS/Motion 过渡（如 reduced-motion 或测试环境）下，收起后及时拆除 ResizeObserver。
  useTimeout(finishClose, open ? null : CLOSE_CLEANUP_MS, overlay ? "o" : "s");

  if (overlay) {
    return (
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        onOpenChangeComplete={(next) => {
          if (!next) finishClose();
        }}
      >
        <SheetContent
          className="gap-0"
          style={{ width: `min(${detailWidth}px, 100vw)`, maxWidth: "100vw" }}
        >
          <SheetTitle className="h-12 shrink-0 px-4 pr-12 flex items-center">
            {title ?? "详情"}
          </SheetTitle>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {open ? detail : null}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <motion.div
      animate={{ width: open ? detailWidth : 0 }}
      className="shrink-0 overflow-hidden"
      // No entry animation on first paint: URL-opened panels should appear as initial state.
      initial={
        initialAnimate && !shouldReduceMotion ? { width: 0 } : false
      }
      onAnimationComplete={finishClose}
      transition={{
        duration: shouldReduceMotion ? 0 : ANIMATION_DURATION_SECONDS,
        ease: EASE_OUT,
      }}
    >
      <div
        className="flex h-full flex-col bg-sidebar border-l border-border"
        style={{ width: detailWidth }}
      >
        {/* Rendered for the whole animation, so the way out is available immediately. */}
        <div className="h-12 shrink-0 sticky top-0 flex flex-row items-center justify-between px-2 gap-2">
          <div className="flex min-w-0 w-full items-center gap-1.5">
            {title}
          </div>
          <div className="flex flex-row gap-1.5">
            <Button
              aria-label={"关闭详情"}
              onClick={onClose}
              variant="ghost"
              size="icon"
            >
              <IconX className="size-4.5" />
            </Button>
          </div>
        </div>
        {/*
         * Unmount while closed so dismissed form state and detail queries do not remain active.
         */}
        {open ? (
          <motion.div
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            className="flex-1 min-h-0 overflow-y-auto"
            initial={{
              opacity: 0,
              transform: shouldReduceMotion
                ? "none"
                : CONTENT_ENTRANCE_OFFSET,
            }}
            transition={{
              delay: shouldReduceMotion
                ? 0
                : CONTENT_ENTRANCE_DELAY_SECONDS,
              duration: CONTENT_ENTRANCE_SECONDS,
              ease: EASE_OUT,
            }}
          >
            {detail}
          </motion.div>
        ) : null}
      </div>
    </motion.div>
  );
}

export function DetailPanel({
  open,
  onClose,
  title,
  detail,
  detailWidth = DEFAULT_DETAIL_WIDTH,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Rendered at the left of the detail pane's header row, beside the close button. */
  title?: ReactNode;
  detail?: ReactNode;
  /** Open width of the detail pane, in pixels. */
  detailWidth?: number;
  children: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const openedOnMount = useRef(open);
  // 关闭态零开销：未展开或退出动画完成后不挂 ResizeObserver、useReducedMotion、Sheet 与 motion.div。
  const [paneMounted, setPaneMounted] = useState(open);
  if (open && !paneMounted) setPaneMounted(true);
  const [overlay, setOverlay] = useState(true);

  useLayoutEffect(() => {
    if (!paneMounted) return;
    const element = container.current;
    if (!element) return;
    const measure = (width: number) =>
      setOverlay(width < detailWidth + MIN_MAIN_WIDTH);
    measure(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) measure(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [paneMounted, detailWidth]);

  const handleExited = useCallback(() => {
    setPaneMounted(false);
  }, []);

  return (
    <div ref={container} className="flex h-full min-h-0">
      <div className="flex flex-1 min-w-0 flex-col">{children}</div>
      {paneMounted ? (
        <DetailPanelPane
          detail={detail}
          detailWidth={detailWidth}
          initialAnimate={!openedOnMount.current}
          onClose={onClose}
          onExited={handleExited}
          open={open}
          overlay={overlay}
          title={title}
        />
      ) : null}
    </div>
  );
}

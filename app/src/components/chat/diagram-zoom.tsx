import { IconZoomIn, IconZoomOut } from "@tabler/icons-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
const STEP = 1.5;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 100) / 100));
}

/** 从 SVG 源码里读出它本来的宽度（viewBox 优先，其次 width 属性）；读不到给一个常见宽度。 */
export function svgNaturalWidth(svg: string, fallback = 640): number {
  const open = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const viewBox =
    /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)/i.exec(open);
  const width = /\bwidth\s*=\s*["']\s*([\d.]+)(?:px)?\s*["']/i.exec(open);
  const value = Number.parseFloat(viewBox?.[1] ?? width?.[1] ?? "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 全屏弹窗里的图：按钮或 Ctrl / ⌘ + 滚轮缩放，放大后在框内滚动（触屏用手指拖）查看。
 * 100% = 图本来的宽度，但不超过弹窗宽。
 */
export function DiagramZoom({
  naturalWidth,
  children,
}: {
  naturalWidth: number;
  children: ReactNode;
}) {
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    // React 的 onWheel 是 passive 的，拦不住浏览器自己的整页缩放，这里直接挂原生监听。
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom((z) => clampZoom(event.deltaY < 0 ? z * 1.15 : z / 1.15));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div className="chat-artifact-zoom">
      <div
        aria-label={"缩放"}
        className="chat-artifact-zoom-bar"
        role="toolbar"
      >
        <Button
          aria-label={"缩小"}
          data-testid="artifact-zoom-out"
          disabled={zoom <= MIN_ZOOM}
          onClick={() => setZoom((z) => clampZoom(z / STEP))}
          size="icon-sm"
          variant="ghost"
        >
          <IconZoomOut aria-hidden="true" className="size-4" />
        </Button>
        <Button
          className="min-w-14 tabular-nums"
          data-testid="artifact-zoom-reset"
          onClick={() => setZoom(1)}
          size="xs"
          title={"还原"}
          variant="ghost"
        >
          {`${Math.round(zoom * 100)}%`}
        </Button>
        <Button
          aria-label={"放大"}
          data-testid="artifact-zoom-in"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => setZoom((z) => clampZoom(z * STEP))}
          size="icon-sm"
          variant="ghost"
        >
          <IconZoomIn aria-hidden="true" className="size-4" />
        </Button>
      </div>
      <div
        className="chat-artifact-zoom-viewport"
        data-testid="artifact-zoom-viewport"
        ref={viewport}
      >
        <div
          className="chat-artifact-zoom-canvas"
          data-zoom={zoom}
          style={{
            width: `calc(min(100%, ${Math.round(naturalWidth)}px) * ${zoom})`,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

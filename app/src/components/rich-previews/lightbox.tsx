import {
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconX,
  IconZoomIn,
  IconZoomOut,
} from "@tabler/icons-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/**
 * 看大图（2026-10-13，聊天富预览；DESIGN.md §31）。
 *
 * 一组图片里的任意一张点开：深色玻璃遮罩 + 居中大图；左右箭头 / ←→ / 左右滑动切换，Esc 或点空白关闭；
 * 双击（双指缩放之外的手机上：双击）在 1× 和 2.5× 之间切，滚轮 / ＋－ 键缩放到 1–4×，放大后拖动平移；
 * 右上角下载、关闭。打开时焦点落在关闭键上，关闭后回到点开它的那个元素；背后页面不滚动。
 * 进场 220ms 淡入 + 轻微放大，出场 150ms 淡出；减少动态效果时只淡入淡出。
 */

export type LightboxImage = {
  src: string;
  alt?: string;
  name?: string;
  /** 像素宽高（服务器给的，DESIGN.md §83.2）：单张图先按比例留框。 */
  width?: number;
  height?: number;
  /** 对话里画小图用的缩略图地址（`?w=` 档位）；没有就用 `src`。看大图始终用 `src`（原图）。 */
  thumb?: string;
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

function downloadNameOf(image: LightboxImage, index: number): string {
  if (image.name) return image.name;
  try {
    const last =
      new URL(image.src, location.href).pathname.split("/").pop() ?? "";
    if (/\.[a-z0-9]{2,5}$/i.test(last)) return decodeURIComponent(last);
  } catch {}
  return `图片-${index + 1}.jpg`;
}

export function Lightbox({
  images,
  startIndex,
  onClose,
}: {
  images: readonly LightboxImage[];
  startIndex: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(0, startIndex), images.length - 1),
  );
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [closing, setClosing] = useState(false);
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const opener = useRef<Element | null>(null);
  const drag = useRef<{
    x: number;
    y: number;
    px: number;
    py: number;
    moved: boolean;
    id: number;
  } | null>(null);
  const lastTap = useRef(0);
  const justDragged = useRef(false);
  const count = images.length;
  const image = images[index];

  const close = useCallback(() => {
    setClosing(true);
    const reduce = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    window.setTimeout(onClose, reduce ? 0 : 150);
  }, [onClose]);

  const go = useCallback(
    (delta: number) => {
      if (count < 2) return;
      setIndex((i) => (i + delta + count) % count);
      setZoom(1);
      setPan({ x: 0, y: 0 });
    },
    [count],
  );

  const zoomTo = useCallback((next: number) => {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    setZoom(z);
    if (z === 1) setPan({ x: 0, y: 0 });
  }, []);

  useLayoutEffect(() => {
    opener.current = document.activeElement;
    closeRef.current?.focus({ preventScroll: true });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      if (opener.current instanceof HTMLElement)
        opener.current.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      } else if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "ArrowRight") go(1);
      else if (event.key === "+" || event.key === "=") zoomTo(zoom + 0.5);
      else if (event.key === "-") zoomTo(zoom - 0.5);
      else if (event.key === "0") zoomTo(1);
      else if (event.key === "Tab") {
        // 焦点锁在看图层里。
        const root = document.querySelector(".rp-lightbox");
        const focusable = Array.from(
          root?.querySelectorAll<HTMLElement>("button, a[href]") ?? [],
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, go, zoom, zoomTo]);

  if (!image) return null;

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      px: pan.x,
      py: pan.y,
      moved: false,
      id: event.pointerId,
    };
    // 只在放大后拖动平移时抓住指针；不放大时抓住会让点图片也变成「点空白关闭」。
    if (zoom > 1)
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
    if (zoom > 1) setPan({ x: d.px + dx, y: d.py + dy });
  };
  const onPointerUp = (event: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    justDragged.current = d.moved;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (zoom === 1 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      go(dx < 0 ? 1 : -1);
      return;
    }
    if (!d.moved) {
      const now = Date.now();
      if (now - lastTap.current < 300) {
        lastTap.current = 0;
        zoomTo(zoom > 1 ? 1 : 2.5);
      } else {
        lastTap.current = now;
      }
    }
  };

  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: 点遮罩关闭只是鼠标的捷径；键盘用 Esc（上面的 keydown）和关闭键
    <div
      aria-label={count > 1 ? `图片 ${index + 1} / ${count}` : "图片"}
      aria-modal="true"
      className="rp-lightbox"
      data-closing={closing || undefined}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      role="dialog"
    >
      <div className="rp-lightbox-bar">
        <div className="rp-lightbox-bar-left">
          <button
            aria-label="关闭"
            className="rp-lb-btn rp-lb-close"
            onClick={close}
            ref={closeRef}
            title="关闭（Esc）"
            type="button"
          >
            <IconX className="size-5" />
          </button>
        </div>
        <div className="rp-lightbox-bar-center">
          <span className="rp-lightbox-name">
            {image.name || image.alt || downloadNameOf(image, index)}
          </span>
        </div>
        <div className="rp-lightbox-actions">
          <button
            aria-label="缩小"
            className="rp-lb-btn rp-lb-zoom"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => zoomTo(zoom - 0.5)}
            title="缩小（-）"
            type="button"
          >
            <IconZoomOut className="size-4" />
          </button>
          <button
            aria-label="放大"
            className="rp-lb-btn rp-lb-zoom"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => zoomTo(zoom + 0.5)}
            title="放大（+）"
            type="button"
          >
            <IconZoomIn className="size-4" />
          </button>
          <a
            aria-label="下载"
            className="rp-lb-btn rp-lb-download"
            download={downloadNameOf(image, index)}
            href={image.src}
            title="下载"
          >
            <IconDownload className="size-4" />
            <span>{"下载"}</span>
          </a>
        </div>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 拖动 / 滑动 / 双击缩放是指针手势；键盘有 ←→ ± 0 Esc */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: 同上 */}
      <div
        className="rp-lightbox-stage"
        data-zoomed={zoom > 1 || undefined}
        onClick={(event) => {
          if (justDragged.current) {
            justDragged.current = false;
            return;
          }
          if (event.target === event.currentTarget && zoom === 1) close();
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={(event) => {
          if (Math.abs(event.deltaY) < 2) return;
          zoomTo(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
        }}
      >
        {failed[index] ? (
          <p className="rp-lightbox-failed" role="note">
            这张图片打不开了
          </p>
        ) : (
          <img
            alt={image.alt || image.name || "图片"}
            className="rp-lightbox-img"
            draggable={false}
            key={image.src}
            onError={() => setFailed((f) => ({ ...f, [index]: true }))}
            src={image.src}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            }}
          />
        )}
      </div>
      {count > 1 ? (
        <>
          <button
            aria-label="上一张"
            className="rp-lb-nav rp-lb-prev"
            onClick={() => go(-1)}
            title="上一张（←）"
            type="button"
          >
            <IconChevronLeft className="size-6" />
          </button>
          <button
            aria-label="下一张"
            className="rp-lb-nav rp-lb-next"
            onClick={() => go(1)}
            title="下一张（→）"
            type="button"
          >
            <IconChevronRight className="size-6" />
          </button>
          <div className="rp-lightbox-foot">
            <span className="rp-lightbox-count">{`${index + 1} / ${count}`}</span>
            <div aria-hidden className="rp-lightbox-dots">
              {images.map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 圆点只按位置区分
                <span data-active={i === index || undefined} key={i} />
              ))}
            </div>
          </div>
        </>
      ) : null}
    </div>,
    document.body,
  );
}

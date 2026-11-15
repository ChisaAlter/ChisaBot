import {
  IconCheck,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconUpload,
} from "@tabler/icons-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSegmentedKeys } from "@/components/ui/segmented";
import {
  applyCropZoom,
  type CropHandle,
  centerCropAt,
  computeContainedImageBox,
  computeCropZoom,
  fitAspectCrop,
  MAX_WALLPAPER_CROP_ZOOM,
  moveCropRect,
  type NormalizedCropRect,
  resizeCropRect,
  resolveAspectRatio,
  toPixelCropRect,
  WALLPAPER_ASPECT_PRESETS,
  type WallpaperAspectPresetId,
} from "@/lib/wallpaper-crop";
import "./wallpaper-crop-dialog.css";

export type WallpaperCropSource = {
  blob: Blob;
  previewUrl: string;
  naturalWidth: number;
  naturalHeight: number;
  initialPreset?: WallpaperAspectPresetId;
  initialRect?: NormalizedCropRect;
  existingSourceDataUrl?: string;
};

type WallpaperCropDialogProps = {
  source: WallpaperCropSource | null;
  saving: boolean;
  onCancel: () => void;
  onReplaceFile: () => void;
  onApply: (payload: {
    rect: NormalizedCropRect;
    preset: WallpaperAspectPresetId;
  }) => Promise<void>;
};

const PRESET_VALUES: readonly WallpaperAspectPresetId[] =
  WALLPAPER_ASPECT_PRESETS.map((item) => item.id);

const CROP_HANDLES: readonly CropHandle[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];

const HANDLE_LABELS: Record<CropHandle, string> = {
  nw: "拖动调整左上角裁剪范围",
  n: "拖动调整上边缘裁剪范围",
  ne: "拖动调整右上角裁剪范围",
  e: "拖动调整右边缘裁剪范围",
  se: "拖动调整右下角裁剪范围",
  s: "拖动调整下边缘裁剪范围",
  sw: "拖动调整左下角裁剪范围",
  w: "拖动调整左边缘裁剪范围",
};

const DEFAULT_STAGE_SIZE = { width: 560, height: 320 };

const rangeFillStyle = (
  value: number,
  min: number,
  max: number,
): CSSProperties =>
  ({ "--pct": `${((value - min) / (max - min)) * 100}%` }) as CSSProperties;

function readViewportSize(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1280, height: 720 };
  return {
    width: window.innerWidth || 1280,
    height: window.innerHeight || 720,
  };
}

function tryCapturePointer(el: HTMLElement | null, pointerId: number) {
  if (!el || typeof el.setPointerCapture !== "function") return;
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // 合成事件测试环境没有注册活动指针，跳过捕获不影响拖拽计算。
  }
}

type DragSession =
  | {
      kind: "move";
      startX: number;
      startY: number;
      startRect: NormalizedCropRect;
    }
  | {
      kind: "resize";
      handle: CropHandle;
      startX: number;
      startY: number;
      startRect: NormalizedCropRect;
    };

function WallpaperCropEditor({
  source,
  saving,
  onCancel,
  onReplaceFile,
  onApply,
}: {
  source: WallpaperCropSource;
  saving: boolean;
  onCancel: () => void;
  onReplaceFile: () => void;
  onApply: (payload: {
    rect: NormalizedCropRect;
    preset: WallpaperAspectPresetId;
  }) => Promise<void>;
}) {
  const [viewportSize, setViewportSize] = useState(readViewportSize);
  const [stageSize, setStageSize] = useState(DEFAULT_STAGE_SIZE);
  const [preset, setPreset] = useState<WallpaperAspectPresetId>(
    source.initialPreset ?? "screen",
  );
  const [rect, setRect] = useState<NormalizedCropRect>(() => {
    if (source.initialRect) return source.initialRect;
    const initPreset = source.initialPreset ?? "screen";
    const vp = readViewportSize();
    const ratio = resolveAspectRatio({
      preset: initPreset,
      imageWidth: source.naturalWidth,
      imageHeight: source.naturalHeight,
      viewportWidth: vp.width,
      viewportHeight: vp.height,
    });
    return fitAspectCrop({
      imageWidth: source.naturalWidth,
      imageHeight: source.naturalHeight,
      aspectRatio: ratio,
    });
  });
  const [dragging, setDragging] = useState(false);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragSession | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setViewportSize(readViewportSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const syncStage = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) {
        setStageSize((prev) =>
          prev.width === w && prev.height === h
            ? prev
            : { width: w, height: h },
        );
      }
    };
    syncStage();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(syncStage);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const aspectRatio = resolveAspectRatio({
    preset,
    imageWidth: source.naturalWidth,
    imageHeight: source.naturalHeight,
    viewportWidth: viewportSize.width,
    viewportHeight: viewportSize.height,
  });

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0015);
      setRect((current) => {
        const currentZoom = computeCropZoom({
          rect: current,
          imageWidth: source.naturalWidth,
          imageHeight: source.naturalHeight,
          aspectRatio,
        });
        return applyCropZoom({
          rect: current,
          nextZoom: currentZoom * factor,
          imageWidth: source.naturalWidth,
          imageHeight: source.naturalHeight,
          aspectRatio,
        });
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [aspectRatio, source.naturalHeight, source.naturalWidth]);

  const handlePresetChange = (nextPreset: WallpaperAspectPresetId) => {
    setPreset(nextPreset);
    if (nextPreset === "free") return;
    if (nextPreset === "original") {
      setRect({ x: 0, y: 0, width: 1, height: 1 });
      return;
    }
    const nextRatio = resolveAspectRatio({
      preset: nextPreset,
      imageWidth: source.naturalWidth,
      imageHeight: source.naturalHeight,
      viewportWidth: viewportSize.width,
      viewportHeight: viewportSize.height,
    });
    setRect((current) =>
      fitAspectCrop({
        imageWidth: source.naturalWidth,
        imageHeight: source.naturalHeight,
        aspectRatio: nextRatio,
        center: {
          x: current.x + current.width / 2,
          y: current.y + current.height / 2,
        },
      }),
    );
  };

  const presetKeys = useSegmentedKeys<WallpaperAspectPresetId>({
    value: preset,
    values: PRESET_VALUES,
    onChange: handlePresetChange,
    disabled: saving,
  });

  const imageBox = computeContainedImageBox({
    stageWidth: stageSize.width,
    stageHeight: stageSize.height,
    imageWidth: source.naturalWidth,
    imageHeight: source.naturalHeight,
  });

  const zoom = computeCropZoom({
    rect,
    imageWidth: source.naturalWidth,
    imageHeight: source.naturalHeight,
    aspectRatio,
  });

  const pixelCrop = toPixelCropRect(
    rect,
    source.naturalWidth,
    source.naturalHeight,
  );

  const zoomTo = (nextZoom: number) => {
    setRect((current) =>
      applyCropZoom({
        rect: current,
        nextZoom,
        imageWidth: source.naturalWidth,
        imageHeight: source.naturalHeight,
        aspectRatio,
      }),
    );
  };

  const handleReset = () => {
    if (preset === "free" || preset === "original") {
      setRect({ x: 0, y: 0, width: 1, height: 1 });
      return;
    }
    setRect(
      fitAspectCrop({
        imageWidth: source.naturalWidth,
        imageHeight: source.naturalHeight,
        aspectRatio,
      }),
    );
  };

  const handleStagePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (saving || event.button > 0) return;
    const stageEl = stageRef.current;
    if (!stageEl) return;
    stageEl.focus();
    const stageRect = stageEl.getBoundingClientRect();
    const relX = event.clientX - stageRect.left;
    const relY = event.clientY - stageRect.top;
    const cxNorm = (relX - imageBox.left) / Math.max(1, imageBox.width);
    const cyNorm = (relY - imageBox.top) / Math.max(1, imageBox.height);
    const centered = centerCropAt(rect, cxNorm, cyNorm);
    setRect(centered);
    dragRef.current = {
      kind: "move",
      startX: event.clientX,
      startY: event.clientY,
      startRect: centered,
    };
    setDragging(true);
    tryCapturePointer(stageEl, event.pointerId);
  };

  const handleCropBoxPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (saving || event.button > 0) return;
    event.stopPropagation();
    stageRef.current?.focus();
    dragRef.current = {
      kind: "move",
      startX: event.clientX,
      startY: event.clientY,
      startRect: rect,
    };
    setDragging(true);
    tryCapturePointer(stageRef.current, event.pointerId);
  };

  const handleResizePointerDown = (
    handle: CropHandle,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (saving || event.button > 0) return;
    event.stopPropagation();
    stageRef.current?.focus();
    dragRef.current = {
      kind: "resize",
      handle,
      startX: event.clientX,
      startY: event.clientY,
      startRect: rect,
    };
    setDragging(true);
    tryCapturePointer(stageRef.current, event.pointerId);
  };

  const handleStagePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dxNorm = (event.clientX - drag.startX) / Math.max(1, imageBox.width);
    const dyNorm = (event.clientY - drag.startY) / Math.max(1, imageBox.height);
    if (drag.kind === "move") {
      setRect(moveCropRect(drag.startRect, dxNorm, dyNorm));
      return;
    }
    setRect(
      resizeCropRect({
        startRect: drag.startRect,
        handle: drag.handle,
        dxNorm,
        dyNorm,
        imageWidth: source.naturalWidth,
        imageHeight: source.naturalHeight,
        aspectRatio,
      }),
    );
  };

  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
  };

  const handleStageKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (saving) return;
    const step = event.shiftKey ? 0.05 : 0.01;
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        setRect((current) => moveCropRect(current, -step, 0));
        return;
      case "ArrowRight":
        event.preventDefault();
        setRect((current) => moveCropRect(current, step, 0));
        return;
      case "ArrowUp":
        event.preventDefault();
        setRect((current) => moveCropRect(current, 0, -step));
        return;
      case "ArrowDown":
        event.preventDefault();
        setRect((current) => moveCropRect(current, 0, step));
        return;
      case "+":
      case "=":
        event.preventDefault();
        zoomTo(zoom + 0.2);
        return;
      case "-":
      case "_":
        event.preventDefault();
        zoomTo(zoom - 0.2);
        return;
      default:
        return;
    }
  };

  const cropBoxStyle: CSSProperties = {
    left: imageBox.left + rect.x * imageBox.width,
    top: imageBox.top + rect.y * imageBox.height,
    width: rect.width * imageBox.width,
    height: rect.height * imageBox.height,
  };

  return (
    <>
      <DialogBody className="mt-1 gap-3">
        <div
          aria-label="壁纸裁剪比例预设"
          className="sg-segmented wallpaper-crop-presets"
          {...presetKeys.groupProps}
          ref={presetKeys.groupRef}
          role="radiogroup"
        >
          {WALLPAPER_ASPECT_PRESETS.map((item) => (
            // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 分段单选控件，样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生 radio 无法替换
            <button
              aria-checked={preset === item.id}
              className="sg-segmented-item"
              data-testid={`wallpaper-crop-preset-${item.id}`}
              disabled={saving}
              key={item.id}
              onClick={() => handlePresetChange(item.id)}
              role="radio"
              tabIndex={presetKeys.itemTabIndex(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>

        <div
          aria-label="壁纸裁剪区域：拖动选框或边缘手柄调整范围，支持方向键微调与滚轮缩放"
          className="wallpaper-crop-stage"
          data-dragging={dragging ? "true" : undefined}
          data-testid="wallpaper-crop-stage"
          onKeyDown={handleStageKeyDown}
          onPointerCancel={endDrag}
          onPointerDown={handleStagePointerDown}
          onPointerMove={handleStagePointerMove}
          onPointerUp={endDrag}
          ref={stageRef}
          role="application"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: role=application 的裁剪舞台需要键盘焦点以响应方向键和缩放键
          tabIndex={0}
        >
          <img
            alt=""
            className="wallpaper-crop-img"
            draggable={false}
            src={source.previewUrl}
            style={{
              left: imageBox.left,
              top: imageBox.top,
              width: imageBox.width,
              height: imageBox.height,
            }}
          />
          <div
            className="wallpaper-crop-box"
            data-testid="wallpaper-crop-box"
            onPointerDown={handleCropBoxPointerDown}
            style={cropBoxStyle}
          >
            <div aria-hidden="true" className="wallpaper-crop-grid">
              <span className="wallpaper-crop-grid-v1" />
              <span className="wallpaper-crop-grid-v2" />
              <span className="wallpaper-crop-grid-h1" />
              <span className="wallpaper-crop-grid-h2" />
            </div>
            {CROP_HANDLES.map((handle) => (
              <button
                aria-label={HANDLE_LABELS[handle]}
                className={`wallpaper-crop-handle wallpaper-crop-handle-${handle}`}
                data-testid={`wallpaper-crop-handle-${handle}`}
                disabled={saving}
                key={handle}
                onPointerDown={(event) =>
                  handleResizePointerDown(handle, event)
                }
                tabIndex={-1}
                type="button"
              />
            ))}
          </div>
        </div>

        <div className="wallpaper-crop-toolbar">
          <div className="wallpaper-crop-zoom">
            <button
              aria-label="缩小裁剪范围"
              className="wallpaper-crop-zoom-btn"
              disabled={saving || zoom <= 1}
              onClick={() => zoomTo(zoom - 0.2)}
              type="button"
            >
              <IconMinus className="size-4" />
            </button>
            <input
              aria-label="缩放裁剪范围"
              className="appearance-range"
              data-testid="wallpaper-crop-zoom"
              disabled={saving}
              max={MAX_WALLPAPER_CROP_ZOOM}
              min={1}
              onChange={(event) => zoomTo(Number(event.target.value))}
              onInput={(event) => zoomTo(Number(event.currentTarget.value))}
              step={0.01}
              style={rangeFillStyle(zoom, 1, MAX_WALLPAPER_CROP_ZOOM)}
              type="range"
              value={zoom}
            />
            <button
              aria-label="放大裁剪范围"
              className="wallpaper-crop-zoom-btn"
              disabled={saving || zoom >= MAX_WALLPAPER_CROP_ZOOM}
              onClick={() => zoomTo(zoom + 0.2)}
              type="button"
            >
              <IconPlus className="size-4" />
            </button>
            <span className="wallpaper-crop-zoom-val">{`${zoom.toFixed(1)}×`}</span>
          </div>

          <div className="wallpaper-crop-meta">
            <span
              className="wallpaper-crop-dims"
              data-testid="wallpaper-crop-dimensions"
            >
              {`${pixelCrop.sw} × ${pixelCrop.sh} px`}
            </span>
            <Button
              data-testid="wallpaper-crop-reset"
              disabled={saving}
              onClick={handleReset}
              size="sm"
              type="button"
              variant="ghost"
            >
              <IconRefresh className="size-3.5" />
              {"重置"}
            </Button>
          </div>
        </div>

        <p className="wallpaper-crop-hint">
          {
            "拖动选框内部可平移位置，拖动四边或四角可调节裁剪范围，滚轮或滑杆可缩放"
          }
        </p>
      </DialogBody>

      <DialogFooter className="wallpaper-crop-foot mt-1">
        <Button
          data-testid="wallpaper-crop-replace"
          disabled={saving}
          onClick={onReplaceFile}
          size="sm"
          type="button"
          variant="ghost"
        >
          <IconUpload className="size-3.5" />
          {"换一张图片"}
        </Button>
        <div className="wallpaper-crop-foot-actions">
          <Button
            data-testid="wallpaper-crop-cancel"
            disabled={saving}
            onClick={onCancel}
            size="sm"
            type="button"
            variant="outline"
          >
            {"取消"}
          </Button>
          <Button
            data-testid="wallpaper-crop-apply"
            feedback={{
              pending: "处理中…",
              success: "已应用",
              error: "应用失败",
            }}
            loading={saving}
            onClick={() => void onApply({ rect, preset })}
            size="sm"
            type="button"
          >
            <IconCheck className="size-3.5" />
            {"应用壁纸"}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

export function WallpaperCropDialog({
  source,
  saving,
  onCancel,
  onReplaceFile,
  onApply,
}: WallpaperCropDialogProps) {
  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) onCancel();
      }}
      open={Boolean(source)}
    >
      <DialogContent
        className="glass-modal max-w-2xl"
        data-testid="wallpaper-crop-dialog"
      >
        <DialogHeader>
          <DialogTitle>{"裁剪并设置壁纸"}</DialogTitle>
          <DialogDescription>
            {"按屏幕比例或自由框选壁纸显示区域，保留高清晰度细节"}
          </DialogDescription>
        </DialogHeader>
        {source ? (
          <WallpaperCropEditor
            key={source.previewUrl}
            onApply={onApply}
            onCancel={onCancel}
            onReplaceFile={onReplaceFile}
            saving={saving}
            source={source}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

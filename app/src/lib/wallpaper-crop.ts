export type WallpaperAspectPresetId =
  | "screen"
  | "16:9"
  | "16:10"
  | "21:9"
  | "4:3"
  | "9:16"
  | "original"
  | "free";

export const WALLPAPER_ASPECT_PRESETS: readonly {
  id: WallpaperAspectPresetId;
  label: string;
}[] = [
  { id: "screen", label: "当前屏幕" },
  { id: "16:9", label: "16:9" },
  { id: "16:10", label: "16:10" },
  { id: "21:9", label: "21:9" },
  { id: "4:3", label: "4:3" },
  { id: "9:16", label: "9:16" },
  { id: "original", label: "原图" },
  { id: "free", label: "自由" },
] as const;

export type NormalizedCropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PixelCropRect = {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
};

export type CropHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export type ContainedBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export const MIN_WALLPAPER_CROP_PX = 64;
export const MAX_WALLPAPER_CROP_ZOOM = 4;

const VALID_PRESET_IDS = new Set<string>(
  WALLPAPER_ASPECT_PRESETS.map((item) => item.id),
);

function clamp(value: number, min: number, max: number): number {
  if (max <= min) return min;
  return Math.min(max, Math.max(min, value));
}

export function isWallpaperAspectPresetId(
  value: unknown,
): value is WallpaperAspectPresetId {
  return typeof value === "string" && VALID_PRESET_IDS.has(value);
}

export function isNormalizedCropRect(
  value: unknown,
): value is NormalizedCropRect {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const { x, y, width, height } = candidate;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return false;
  }
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return false;
  }
  return (
    x >= 0 &&
    y >= 0 &&
    width > 0 &&
    height > 0 &&
    width <= 1 &&
    height <= 1 &&
    x + width <= 1 + 1e-6 &&
    y + height <= 1 + 1e-6
  );
}

export function resolveAspectRatio(params: {
  preset: WallpaperAspectPresetId;
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}): number | null {
  const { preset, imageWidth, imageHeight, viewportWidth, viewportHeight } =
    params;
  switch (preset) {
    case "free":
      return null;
    case "original":
      return imageWidth > 0 && imageHeight > 0
        ? imageWidth / imageHeight
        : 16 / 9;
    case "screen":
      return viewportWidth > 0 && viewportHeight > 0
        ? viewportWidth / viewportHeight
        : 16 / 9;
    case "16:9":
      return 16 / 9;
    case "16:10":
      return 16 / 10;
    case "21:9":
      return 21 / 9;
    case "4:3":
      return 4 / 3;
    case "9:16":
      return 9 / 16;
    default: {
      const _exhaustive: never = preset;
      return _exhaustive;
    }
  }
}

export function computeContainedImageBox(params: {
  stageWidth: number;
  stageHeight: number;
  imageWidth: number;
  imageHeight: number;
  padding?: number;
}): ContainedBox {
  const padding = params.padding ?? 14;
  const stageWidth = Math.max(1, params.stageWidth);
  const stageHeight = Math.max(1, params.stageHeight);
  const iw = Math.max(1, params.imageWidth);
  const ih = Math.max(1, params.imageHeight);
  const availW = Math.max(1, stageWidth - padding * 2);
  const availH = Math.max(1, stageHeight - padding * 2);
  const scale = Math.min(availW / iw, availH / ih);
  const width = iw * scale;
  const height = ih * scale;
  return {
    left: (stageWidth - width) / 2,
    top: (stageHeight - height) / 2,
    width,
    height,
  };
}

function minCropFraction(
  imageWidth: number,
  imageHeight: number,
): {
  minW: number;
  minH: number;
} {
  const iw = Math.max(1, imageWidth);
  const ih = Math.max(1, imageHeight);
  const minPxX = Math.max(1, Math.min(MIN_WALLPAPER_CROP_PX, iw));
  const minPxY = Math.max(1, Math.min(MIN_WALLPAPER_CROP_PX, ih));
  return {
    minW: Math.min(1, minPxX / iw),
    minH: Math.min(1, minPxY / ih),
  };
}

function normalizedAspect(
  aspectRatio: number,
  imageWidth: number,
  imageHeight: number,
): number {
  const iw = Math.max(1, imageWidth);
  const ih = Math.max(1, imageHeight);
  const raw = aspectRatio * (ih / iw);
  return Math.abs(raw - 1) < 1e-6 ? 1 : raw;
}

export function fitAspectCrop(params: {
  imageWidth: number;
  imageHeight: number;
  aspectRatio: number | null;
  center?: { x: number; y: number };
}): NormalizedCropRect {
  const { imageWidth, imageHeight, aspectRatio, center } = params;
  if (
    aspectRatio === null ||
    !Number.isFinite(aspectRatio) ||
    aspectRatio <= 0
  ) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  const r = normalizedAspect(aspectRatio, imageWidth, imageHeight);
  const width = Math.min(r, 1);
  const height = r >= 1 ? 1 / r : 1;
  const cx = center?.x ?? 0.5;
  const cy = center?.y ?? 0.5;
  return {
    x: clamp(cx - width / 2, 0, 1 - width),
    y: clamp(cy - height / 2, 0, 1 - height),
    width,
    height,
  };
}

export function moveCropRect(
  rect: NormalizedCropRect,
  dxNorm: number,
  dyNorm: number,
): NormalizedCropRect {
  const width = clamp(rect.width, 0, 1);
  const height = clamp(rect.height, 0, 1);
  return {
    x: clamp(rect.x + dxNorm, 0, 1 - width),
    y: clamp(rect.y + dyNorm, 0, 1 - height),
    width,
    height,
  };
}

export function centerCropAt(
  rect: NormalizedCropRect,
  cxNorm: number,
  cyNorm: number,
): NormalizedCropRect {
  const width = clamp(rect.width, 0, 1);
  const height = clamp(rect.height, 0, 1);
  return {
    x: clamp(cxNorm - width / 2, 0, 1 - width),
    y: clamp(cyNorm - height / 2, 0, 1 - height),
    width,
    height,
  };
}

export function resizeCropRect(params: {
  startRect: NormalizedCropRect;
  handle: CropHandle;
  dxNorm: number;
  dyNorm: number;
  imageWidth: number;
  imageHeight: number;
  aspectRatio: number | null;
}): NormalizedCropRect {
  const {
    startRect,
    handle,
    dxNorm,
    dyNorm,
    imageWidth,
    imageHeight,
    aspectRatio,
  } = params;
  const { minW, minH } = minCropFraction(imageWidth, imageHeight);

  if (
    aspectRatio === null ||
    !Number.isFinite(aspectRatio) ||
    aspectRatio <= 0
  ) {
    let left = startRect.x;
    let top = startRect.y;
    let right = startRect.x + startRect.width;
    let bottom = startRect.y + startRect.height;

    if (handle.includes("w")) left = clamp(left + dxNorm, 0, right - minW);
    if (handle.includes("e")) right = clamp(right + dxNorm, left + minW, 1);
    if (handle.includes("n")) top = clamp(top + dyNorm, 0, bottom - minH);
    if (handle.includes("s")) bottom = clamp(bottom + dyNorm, top + minH, 1);

    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    };
  }

  const r = normalizedAspect(aspectRatio, imageWidth, imageHeight);
  const minLockedW = Math.min(1, Math.max(minW, minH * r));
  const minLockedH = minLockedW / r;

  if (handle === "e" || handle === "w") {
    const sx = handle === "e" ? 1 : -1;
    const ax = handle === "e" ? startRect.x : startRect.x + startRect.width;
    const cy = startRect.y + startRect.height / 2;
    const availX = sx > 0 ? 1 - ax : ax;
    const availY = 2 * Math.min(cy, 1 - cy);
    const maxW = Math.min(availX, availY * r);
    const w = clamp(
      startRect.width + sx * dxNorm,
      Math.min(minLockedW, maxW),
      maxW,
    );
    const h = w / r;
    const x = sx > 0 ? ax : ax - w;
    return {
      x: clamp(x, 0, 1 - w),
      y: clamp(cy - h / 2, 0, 1 - h),
      width: w,
      height: h,
    };
  }

  if (handle === "n" || handle === "s") {
    const sy = handle === "s" ? 1 : -1;
    const ay = handle === "s" ? startRect.y : startRect.y + startRect.height;
    const cx = startRect.x + startRect.width / 2;
    const availY = sy > 0 ? 1 - ay : ay;
    const availX = 2 * Math.min(cx, 1 - cx);
    const maxH = Math.min(availY, availX / r);
    const h = clamp(
      startRect.height + sy * dyNorm,
      Math.min(minLockedH, maxH),
      maxH,
    );
    const w = h * r;
    const y = sy > 0 ? ay : ay - h;
    return {
      x: clamp(cx - w / 2, 0, 1 - w),
      y: clamp(y, 0, 1 - h),
      width: w,
      height: h,
    };
  }

  const sx = handle.includes("e") ? 1 : -1;
  const sy = handle.includes("s") ? 1 : -1;
  const ax = sx > 0 ? startRect.x : startRect.x + startRect.width;
  const ay = sy > 0 ? startRect.y : startRect.y + startRect.height;
  const availX = sx > 0 ? 1 - ax : ax;
  const availY = sy > 0 ? 1 - ay : ay;
  const maxW = Math.min(availX, availY * r);
  const rawW = startRect.width + sx * dxNorm;
  const rawH = startRect.height + sy * dyNorm;
  const targetW = ((rawW * r + rawH) / (r * r + 1)) * r;
  const w = clamp(targetW, Math.min(minLockedW, maxW), maxW);
  const h = w / r;
  const x = sx > 0 ? ax : ax - w;
  const y = sy > 0 ? ay : ay - h;
  return {
    x: clamp(x, 0, 1 - w),
    y: clamp(y, 0, 1 - h),
    width: w,
    height: h,
  };
}

function effectiveZoomRatio(params: {
  rect: NormalizedCropRect;
  imageWidth: number;
  imageHeight: number;
  aspectRatio: number | null;
}): number {
  if (
    params.aspectRatio !== null &&
    Number.isFinite(params.aspectRatio) &&
    params.aspectRatio > 0
  ) {
    return params.aspectRatio;
  }
  const iw = Math.max(1, params.imageWidth);
  const ih = Math.max(1, params.imageHeight);
  if (params.rect.height <= 0) return iw / ih;
  return (params.rect.width * iw) / (params.rect.height * ih);
}

export function computeCropZoom(params: {
  rect: NormalizedCropRect;
  imageWidth: number;
  imageHeight: number;
  aspectRatio: number | null;
}): number {
  const ratio = effectiveZoomRatio(params);
  const maxRect = fitAspectCrop({
    imageWidth: params.imageWidth,
    imageHeight: params.imageHeight,
    aspectRatio: ratio,
  });
  const zoom = maxRect.width / Math.max(1e-6, params.rect.width);
  return clamp(zoom, 1, MAX_WALLPAPER_CROP_ZOOM);
}

export function applyCropZoom(params: {
  rect: NormalizedCropRect;
  nextZoom: number;
  imageWidth: number;
  imageHeight: number;
  aspectRatio: number | null;
}): NormalizedCropRect {
  const ratio = effectiveZoomRatio(params);
  const maxRect = fitAspectCrop({
    imageWidth: params.imageWidth,
    imageHeight: params.imageHeight,
    aspectRatio: ratio,
  });
  const r = normalizedAspect(ratio, params.imageWidth, params.imageHeight);
  const { minW, minH } = minCropFraction(params.imageWidth, params.imageHeight);
  const minLockedW = Math.min(maxRect.width, Math.max(minW, minH * r));
  const z = clamp(params.nextZoom, 1, MAX_WALLPAPER_CROP_ZOOM);
  const width = clamp(maxRect.width / z, minLockedW, maxRect.width);
  const height = width / r;
  const cx = params.rect.x + params.rect.width / 2;
  const cy = params.rect.y + params.rect.height / 2;
  return {
    x: clamp(cx - width / 2, 0, 1 - width),
    y: clamp(cy - height / 2, 0, 1 - height),
    width,
    height,
  };
}

export function toPixelCropRect(
  rect: NormalizedCropRect,
  imageWidth: number,
  imageHeight: number,
): PixelCropRect {
  const iw = Math.max(1, Math.round(imageWidth));
  const ih = Math.max(1, Math.round(imageHeight));
  const sx = Math.max(0, Math.min(iw - 1, Math.round(rect.x * iw)));
  const sy = Math.max(0, Math.min(ih - 1, Math.round(rect.y * ih)));
  const sw = Math.max(1, Math.min(iw - sx, Math.round(rect.width * iw)));
  const sh = Math.max(1, Math.min(ih - sy, Math.round(rect.height * ih)));
  return { sx, sy, sw, sh };
}

export function isFullImageCrop(
  crop: PixelCropRect,
  imageWidth: number,
  imageHeight: number,
): boolean {
  const iw = Math.max(1, Math.round(imageWidth));
  const ih = Math.max(1, Math.round(imageHeight));
  return crop.sx === 0 && crop.sy === 0 && crop.sw === iw && crop.sh === ih;
}

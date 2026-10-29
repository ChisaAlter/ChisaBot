/**
 * 自定义壁纸压缩（模块 11 第 11 条）。
 *
 * 以前在主线程用 `<img>` + `<canvas>.toDataURL` 压到最长边 1920：
 * 4000×2500 的照片会卡住主线程约 0.4 s（4× 降速时约 1.3 s），2× 屏上 1920 的图也会被放大发糊。
 *
 * 现在：
 * - 目标最长边 = 屏幕最长边 × devicePixelRatio，最多 3840（`wallpaperTargetLongEdge`）；原图更小就不放大。
 * - 优先放进 Worker：`createImageBitmap` 解码、`OffscreenCanvas` 缩放、`convertToBlob` 编码，
 *   `FileReaderSync` 转 Data URL，主线程只收一个字符串。
 * - 浏览器没有 Worker / OffscreenCanvas / createImageBitmap，或者 Worker 出错、超时，就退回主线程的老路径
 *   （同样的目标尺寸和编码参数）。
 * - 编码参数不变：先试 WebP 0.84，Data URL 超过 3.5M 字符或浏览器不支持 WebP 编码就改 JPEG 0.8。
 */

/** 最长边上限：4K 屏的物理宽度。 */
export const WALLPAPER_MAX_LONG_EDGE = 3840;
/** 拿不到屏幕尺寸时用的最长边（和以前一样）。 */
export const WALLPAPER_FALLBACK_LONG_EDGE = 1920;
/** WebP 结果超过这个长度（Data URL 字符数）就改用 JPEG。 */
export const WALLPAPER_WEBP_MAX_CHARS = 3_500_000;
export const WALLPAPER_WEBP_QUALITY = 0.84;
export const WALLPAPER_JPEG_QUALITY = 0.8;
/** Worker 多久没回话就放弃、退回主线程。 */
export const WALLPAPER_WORKER_TIMEOUT_MS = 30_000;

type ScreenSize = { width: number; height: number };

/** 目标最长边：屏幕最长边 × DPR，封顶 3840。 */
export function wallpaperTargetLongEdge(
  screenSize: ScreenSize | undefined = typeof screen === "undefined"
    ? undefined
    : { width: screen.width, height: screen.height },
  dpr: number = typeof devicePixelRatio === "number" ? devicePixelRatio : 1,
): number {
  const longest = Math.max(screenSize?.width ?? 0, screenSize?.height ?? 0);
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  if (!Number.isFinite(longest) || longest <= 0)
    return WALLPAPER_FALLBACK_LONG_EDGE;
  return Math.min(WALLPAPER_MAX_LONG_EDGE, Math.round(longest * ratio));
}

/** 等比缩到最长边不超过 maxSide；原图更小就保持原尺寸。 */
export function fitLongEdge(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } {
  if (width <= maxSide && height <= maxSide) return { width, height };
  const ratio = Math.min(maxSide / width, maxSide / height);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/** 主线程 ↔ Worker 的消息。 */
export type WallpaperCompressRequest = { file: Blob; maxSide: number };
export type WallpaperCompressResponse =
  | { ok: true; dataUrl: string; width: number; height: number }
  | { ok: false; error: string };

/** 没有 2D 上下文时返回 null，调用方用原图。 */
export async function compressBitmapToBlob(
  bitmap: ImageBitmap,
  maxSide: number,
): Promise<{
  webp: Blob | null;
  jpeg: () => Promise<Blob>;
  width: number;
  height: number;
} | null> {
  const { width, height } = fitLongEdge(bitmap.width, bitmap.height, maxSide);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const webp = await canvas.convertToBlob({
    type: "image/webp",
    quality: WALLPAPER_WEBP_QUALITY,
  });
  return {
    // 不支持 WebP 编码的浏览器会悄悄给 PNG。
    webp: webp.type === "image/webp" ? webp : null,
    jpeg: () =>
      canvas.convertToBlob({
        type: "image/jpeg",
        quality: WALLPAPER_JPEG_QUALITY,
      }),
    width,
    height,
  };
}

/** Data URL 的长度：`data:<type>;base64,` + base64。 */
export function dataUrlLength(blob: Blob): number {
  return `data:${blob.type};base64,`.length + Math.ceil(blob.size / 3) * 4;
}

/** 依次试 WebP、JPEG，返回要转成 Data URL 的那份。 */
export async function pickWallpaperBlob(
  encoded: NonNullable<Awaited<ReturnType<typeof compressBitmapToBlob>>>,
): Promise<Blob> {
  if (encoded.webp && dataUrlLength(encoded.webp) < WALLPAPER_WEBP_MAX_CHARS)
    return encoded.webp;
  return encoded.jpeg();
}

export type WorkerLike = {
  postMessage(message: WallpaperCompressRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WallpaperCompressResponse>) => void) | null;
  onerror: ((event: ErrorEvent | Event) => void) | null;
};

/** 这个浏览器能不能走 Worker 路径。 */
export function canCompressInWorker(
  scope: typeof globalThis = globalThis,
): boolean {
  return (
    typeof scope.Worker === "function" &&
    typeof scope.OffscreenCanvas === "function" &&
    typeof scope.createImageBitmap === "function"
  );
}

function defaultWorkerFactory(): WorkerLike {
  return new Worker(
    new URL("./wallpaper-compress.worker.ts", import.meta.url),
    {
      type: "module",
      name: "wallpaper-compress",
    },
  ) as unknown as WorkerLike;
}

/** 在 Worker 里压缩；Worker 起不来、报错或超时就 reject，由调用方退回主线程。 */
export function compressInWorker(
  file: Blob,
  maxSide: number,
  createWorker: () => WorkerLike = defaultWorkerFactory,
  timeoutMs = WALLPAPER_WORKER_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let worker: WorkerLike;
    try {
      worker = createWorker();
    } catch (error) {
      reject(error);
      return;
    }
    const done = (fn: () => void) => {
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error("壁纸压缩超时"))),
      timeoutMs,
    );
    worker.onmessage = (event) => {
      const data = event.data;
      done(() =>
        data.ok ? resolve(data.dataUrl) : reject(new Error(data.error)),
      );
    };
    worker.onerror = () =>
      done(() => reject(new Error("壁纸压缩 Worker 出错")));
    worker.postMessage({ file, maxSide });
  });
}

/** 主线程的老路径：`<img>` 解码 + `<canvas>` 编码。目标尺寸和编码参数与 Worker 路径一致。 */
export function compressOnMainThread(
  file: Blob,
  maxSide: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片文件失败"));
    reader.onload = () => {
      const src = typeof reader.result === "string" ? reader.result : "";
      if (!src) {
        reject(new Error("图片内容为空"));
        return;
      }
      const img = new Image();
      img.onerror = () => reject(new Error("无法解析该图片格式"));
      img.onload = () => {
        const { width, height } = fitLongEdge(img.width, img.height, maxSide);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(src);
          return;
        }
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, width, height);
        const webp = canvas.toDataURL("image/webp", WALLPAPER_WEBP_QUALITY);
        if (
          webp.startsWith("data:image/webp") &&
          webp.length < WALLPAPER_WEBP_MAX_CHARS
        ) {
          resolve(webp);
          return;
        }
        resolve(canvas.toDataURL("image/jpeg", WALLPAPER_JPEG_QUALITY));
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}

export type CompressWallpaperOptions = {
  maxSide?: number;
  /** 测试用：替换 Worker 和能力检测。 */
  createWorker?: () => WorkerLike;
  canUseWorker?: boolean;
  workerTimeoutMs?: number;
  mainThread?: (file: Blob, maxSide: number) => Promise<string>;
  /** Worker 路径失败、改走主线程时调用（测试和排查用）。 */
  onFallback?: (error: unknown) => void;
};

/** 压缩成 Data URL：先 Worker，失败退回主线程。 */
export async function compressWallpaperImage(
  file: Blob,
  options: CompressWallpaperOptions = {},
): Promise<string> {
  const maxSide = options.maxSide ?? wallpaperTargetLongEdge();
  if (options.canUseWorker ?? canCompressInWorker()) {
    try {
      return await compressInWorker(
        file,
        maxSide,
        options.createWorker,
        options.workerTimeoutMs,
      );
    } catch (error) {
      options.onFallback?.(error);
    }
  }
  return (options.mainThread ?? compressOnMainThread)(file, maxSide);
}

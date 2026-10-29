import type { AttachmentThumbWidth } from "../../../shared/attachments";

/**
 * `GET /api/attachments/:id?w=` 的缩略图：用 sharp 按宽度缩小，转成 WebP，放在进程内存里的 LRU 缓存里。
 *
 * 为什么要有：对话里的图片画出来最宽 320 CSS 像素，原图却常常是几 MB 的手机照片。每次打开对话都把原图
 * 整份传给浏览器，既费流量也费解码。缩略图只给对话里的小图用，点开看大图仍然拉原图。
 *
 * 缓存策略：
 * - 键是「附件 id + 档位」。附件的字节存进来以后从不改（见 `attachments.ts` 的 ETag 说明），所以缓存不需要
 *   过期时间，也不用在内容变化时作废。
 * - 只缓存结果字节，**不缓存「谁能看」**：路由每次照旧先查一遍可见性（成员、频道没删、草稿只给上传者），
 *   缓存命中只是省掉从 Postgres 读原图和重新缩放。附件被删以后这一项还在内存里，但再也没人能通过路由拿到它，
 *   等着被挤出去。
 * - 上限：总共 {@link DEFAULT_MAX_CACHE_BYTES}（64 MiB）、最多 {@link DEFAULT_MAX_CACHE_ENTRIES}（2000）项，
 *   超出时先丢最久没用的；单项超过 {@link DEFAULT_MAX_ENTRY_BYTES}（2 MiB）不进缓存。进程重启就清空，多个
 *   进程各有一份，不落盘。
 * - 同一项同时有多个请求时只算一次（共享同一个 Promise）。
 *
 * 回退原图（返回 `{ kind: "original" }`，路由照常回原图）：
 * - 不是 PNG / JPEG / WebP（GIF 可能是动图，缩成一帧会丢动画；文件、文本当然不缩）。
 * - 原图本来就不比这一档宽，或者转出来的 WebP 反而比原图大。
 * - sharp 装不上 / 加载失败（只记一次日志）、图片解不开、像素数超过 {@link MAX_INPUT_PIXELS}、
 *   超过 {@link RESIZE_TIMEOUT_SECONDS} 秒没算完。
 * 「回退」也会记进缓存（一个很小的标记），下次同一项直接回原图，不再重算。
 */

export type ThumbResult =
  | { kind: "thumb"; bytes: Uint8Array<ArrayBuffer>; mimeType: "image/webp" }
  | { kind: "original" };

/** sharp 用到的那一小部分，测试可以换掉。 */
export type SharpLike = (
  input: Uint8Array,
  options: { limitInputPixels: number; failOn: "error" },
) => {
  metadata(): Promise<{ width?: number; height?: number; pages?: number }>;
  rotate(): {
    resize(options: { width: number; withoutEnlargement: boolean }): {
      timeout(options: { seconds: number }): {
        webp(options: { quality: number }): {
          toBuffer(): Promise<Uint8Array>;
        };
      };
    };
  };
};

export type Thumbnailer = {
  /** 缓存里已经有这一项（缩略图或「回原图」标记）就直接给，不碰数据库。 */
  cached(id: string, width: AttachmentThumbWidth): ThumbResult | undefined;
  /** 算一张（或从缓存拿）。从不抛错：算不出来就是 `{ kind: "original" }`。 */
  thumbnail(
    id: string,
    width: AttachmentThumbWidth,
    mimeType: string,
    original: Uint8Array,
  ): Promise<ThumbResult>;
};

export const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_CACHE_ENTRIES = 2000;
export const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
/** 约 4000 万像素（比如 8000×5000）。更大的图解码要的内存太多，直接回原图。 */
export const MAX_INPUT_PIXELS = 40_000_000;
export const RESIZE_TIMEOUT_SECONDS = 10;
const WEBP_QUALITY = 80;
/** 「回原图」标记在缓存里按这么多字节算，免得两千个标记不占预算。 */
const ORIGINAL_MARKER_BYTES = 64;

const RESIZABLE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

async function loadSharp(): Promise<SharpLike | null> {
  try {
    const module = await import("sharp");
    const sharp = module.default;
    // libvips 自己的操作缓存关掉：结果已经由上面的 LRU 管着，再留一份只是多占内存。
    sharp.cache(false);
    return sharp as unknown as SharpLike;
  } catch (error) {
    console.warn(
      "sharp could not be loaded; attachment thumbnails fall back to the original image.",
      error,
    );
    return null;
  }
}

export function createThumbnailer(
  options: {
    load?: () => Promise<SharpLike | null>;
    maxCacheBytes?: number;
    maxCacheEntries?: number;
    maxEntryBytes?: number;
  } = {},
): Thumbnailer {
  const load = options.load ?? loadSharp;
  const maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
  const maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;

  let sharp: Promise<SharpLike | null> | null = null;
  // Map 记得插入顺序：命中时删了再插，最前面的就是最久没用的。
  const cache = new Map<string, ThumbResult>();
  let cacheBytes = 0;
  const inFlight = new Map<string, Promise<ThumbResult>>();

  const sizeOf = (result: ThumbResult) =>
    result.kind === "thumb" ? result.bytes.byteLength : ORIGINAL_MARKER_BYTES;

  function remember(key: string, result: ThumbResult) {
    const size = sizeOf(result);
    if (size > maxEntryBytes) return;
    const previous = cache.get(key);
    if (previous) {
      cache.delete(key);
      cacheBytes -= sizeOf(previous);
    }
    cache.set(key, result);
    cacheBytes += size;
    while (cacheBytes > maxCacheBytes || cache.size > maxCacheEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      const evicted = cache.get(oldest.value);
      cache.delete(oldest.value);
      if (evicted) cacheBytes -= sizeOf(evicted);
    }
  }

  async function compute(
    width: AttachmentThumbWidth,
    mimeType: string,
    original: Uint8Array,
  ): Promise<ThumbResult> {
    if (!RESIZABLE_MIME.has(mimeType)) return { kind: "original" };
    sharp ??= load();
    const resize = await sharp;
    if (!resize) return { kind: "original" };
    try {
      const image = resize(original, {
        limitInputPixels: MAX_INPUT_PIXELS,
        failOn: "error",
      });
      const metadata = await image.metadata();
      // 动画 WebP 和 GIF 一样不缩：缩出来只剩第一帧。
      if ((metadata.pages ?? 1) > 1) return { kind: "original" };
      if (!metadata.width || metadata.width <= width) {
        return { kind: "original" };
      }
      const bytes = await image
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .timeout({ seconds: RESIZE_TIMEOUT_SECONDS })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      if (bytes.byteLength >= original.byteLength) return { kind: "original" };
      return {
        kind: "thumb",
        // 和路由里回原图一样只做一个视图、不复制；sharp 回的 Buffer 不会是 SharedArrayBuffer。
        bytes: new Uint8Array(
          bytes.buffer as ArrayBuffer,
          bytes.byteOffset,
          bytes.byteLength,
        ),
        mimeType: "image/webp",
      };
    } catch (error) {
      console.warn(
        `Could not make a ${width}px thumbnail; serving the original.`,
        error,
      );
      return { kind: "original" };
    }
  }

  return {
    cached(id, width) {
      const key = `${id}:${width}`;
      const hit = cache.get(key);
      if (!hit) return undefined;
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    },
    thumbnail(id, width, mimeType, original) {
      const key = `${id}:${width}`;
      const hit = this.cached(id, width);
      if (hit) return Promise.resolve(hit);
      const pending = inFlight.get(key);
      if (pending) return pending;
      const job = compute(width, mimeType, original)
        .catch((): ThumbResult => ({ kind: "original" }))
        .then((result) => {
          remember(key, result);
          return result;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, job);
      return job;
    },
  };
}

/** 整个进程共用的一份（路由默认用它）。 */
export const attachmentThumbnailer: Thumbnailer = createThumbnailer();

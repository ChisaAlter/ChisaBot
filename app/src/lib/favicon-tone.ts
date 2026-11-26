import { useState } from "react";
import { useExternalConnection } from "@/hooks";

/**
 * 网站图标在暗色主题里会不会「黑上加黑」（DESIGN.md §96）。
 *
 * GitHub、Notion、X 这类单色黑图标放在暗色标签栏 / 收藏栏上几乎看不见。我们不按站点名单反色，
 * 而是看图标本身：不透明像素的平均亮度很低（基本是深色墨）就判成「深色图标」，暗色主题下给它垫一块
 * 浅色小底板（CSS `.dark .btab-ic.is-dark-ink`）。彩色图标、浅色图标保持原样。
 *
 * 图标都是 data: 地址（tabs.ts 只收 data:image/…），画到 canvas 上不会被跨域污染。
 */

/** 深色阈值：相对亮度（0 黑 … 1 白）低于它算深色墨。#24292f ≈ 0.023，#6b7280 ≈ 0.17。 */
export const DARK_INK_LUMINANCE = 0.12;

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** sRGB → WCAG 相对亮度。 */
export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** `#rgb` / `#rrggbb` → 亮度；解析不了返回 null。 */
export function hexLuminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1] as string;
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = Number.parseInt(h, 16);
  return relativeLuminance((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

/**
 * RGBA 像素 → 是不是「深色墨」图标。只看不透明度 > 0.5 的像素，按不透明度加权平均亮度；
 * 几乎全透明（没画东西）返回 false。
 */
export function isDarkInkPixels(data: ArrayLike<number>, threshold = DARK_INK_LUMINANCE): boolean {
  let weight = 0;
  let sum = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const a = (data[i + 3] as number) / 255;
    if (a <= 0.5) continue;
    weight += a;
    sum += a * relativeLuminance(data[i] as number, data[i + 1] as number, data[i + 2] as number);
  }
  if (weight < 4) return false;
  return sum / weight < threshold;
}

/** LRU 缓存上限：避免长时间浏览云端浏览器时模块级 Map 无限增长。 */
export const FAVICON_TONE_CACHE_MAX = 200;

const cache = new Map<string, boolean>();
const pending = new Map<string, Promise<boolean>>();

/**
 * 将可能高达 100 KB 的 data:image/* Base64 折叠为短哈希 Key（长度 + 双路 32 位 FNV-1a），
 * 避免模块级缓存长期持有整段 Base64 字符串。
 */
export function faviconToneCacheKey(src: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < src.length; i++) {
    const code = src.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${src.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

function getCachedTone(key: string): boolean | undefined {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

export function setCachedFaviconTone(src: string, dark: boolean): string {
  const key = faviconToneCacheKey(src);
  if (cache.has(key)) cache.delete(key);
  cache.set(key, dark);
  while (cache.size > FAVICON_TONE_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return key;
}

/** 测试用：读取当前缓存状态（不改变 LRU 顺序）。 */
export function faviconToneCacheStats(): {
  size: number;
  keys: string[];
} {
  return { size: cache.size, keys: [...cache.keys()] };
}

/** 测试用：清空缓存。 */
export function clearFaviconToneCache(): void {
  cache.clear();
  pending.clear();
}

function measure(src: string): Promise<boolean> {
  const key = faviconToneCacheKey(src);
  const hit = getCachedTone(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const running = pending.get(key);
  if (running) return running;
  const job = new Promise<boolean>((resolve) => {
    if (typeof Image === "undefined" || typeof document === "undefined") return resolve(false);
    const img = new Image();
    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return resolve(false);
        ctx.drawImage(img, 0, 0, size, size);
        resolve(isDarkInkPixels(ctx.getImageData(0, 0, size, size).data));
      } catch {
        resolve(false);
      }
    };
    img.onerror = () => resolve(false);
    img.src = src;
  }).then((dark) => {
    setCachedFaviconTone(src, dark);
    pending.delete(key);
    return dark;
  });
  pending.set(key, job);
  return job;
}

/** 图标 src 是不是深色墨（结果按短哈希 LRU 缓存；量出来之前是 false）。 */
export function useDarkInk(src: string | undefined): boolean {
  const key = src ? faviconToneCacheKey(src) : "";
  const [measured, setMeasured] = useState<{ key: string; dark: boolean } | null>(
    () => (key && cache.has(key) ? { key, dark: cache.get(key) ?? false } : null),
  );
  useExternalConnection(src || false, (activeSrc, signal) => {
    const activeKey = faviconToneCacheKey(activeSrc);
    void measure(activeSrc).then((value) => {
      if (!signal.aborted) {
        setMeasured((prev) =>
          prev?.key === activeKey && prev.dark === value
            ? prev
            : { key: activeKey, dark: value },
        );
      }
    });
  });
  if (!src) return false;
  return measured?.key === key ? measured.dark : (cache.get(key) ?? false);
}

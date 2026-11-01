import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  canCompressInWorker,
  compressBitmapToBlob,
  compressWallpaperImage,
  dataUrlLength,
  fitLongEdge,
  pickWallpaperBlob,
  WALLPAPER_FALLBACK_LONG_EDGE,
  WALLPAPER_MAX_LONG_EDGE,
  WALLPAPER_WEBP_MAX_CHARS,
  type WallpaperCompressRequest,
  type WallpaperCompressResponse,
  type WorkerLike,
  wallpaperTargetLongEdge,
} from "@/lib/wallpaper-compress";

/**
 * 模块 11 第 11 条：壁纸压缩放进 Worker，最长边按屏幕 × DPR（最多 3840）。
 * 浏览器里的实测数字（主线程长任务、输出大小）在 PR 描述里；这里锁住尺寸规则、Worker / 主线程的分流和回退，
 * 以及 Worker 入口本身（用替身 createImageBitmap / OffscreenCanvas 跑一遍真的 onmessage）。
 */

describe("target long edge", () => {
  test("screen longest edge × DPR, capped at 3840", () => {
    expect(wallpaperTargetLongEdge({ width: 1440, height: 900 }, 1)).toBe(1440);
    expect(wallpaperTargetLongEdge({ width: 1920, height: 1080 }, 1.5)).toBe(
      2880,
    );
    expect(wallpaperTargetLongEdge({ width: 390, height: 844 }, 3)).toBe(2532);
    expect(wallpaperTargetLongEdge({ width: 2560, height: 1440 }, 2)).toBe(
      WALLPAPER_MAX_LONG_EDGE,
    );
    expect(wallpaperTargetLongEdge({ width: 3840, height: 2160 }, 1)).toBe(
      3840,
    );
  });

  test("falls back to 1920 without a screen, and to DPR 1 when DPR is unusable", () => {
    expect(wallpaperTargetLongEdge(undefined, 2)).toBe(
      WALLPAPER_FALLBACK_LONG_EDGE,
    );
    expect(wallpaperTargetLongEdge({ width: 0, height: 0 }, 2)).toBe(
      WALLPAPER_FALLBACK_LONG_EDGE,
    );
    expect(
      wallpaperTargetLongEdge({ width: 1600, height: 1000 }, Number.NaN),
    ).toBe(1600);
    expect(wallpaperTargetLongEdge({ width: 1600, height: 1000 }, 0)).toBe(
      1600,
    );
  });

  test("fits the long edge without upscaling", () => {
    expect(fitLongEdge(4000, 2500, 3840)).toEqual({
      width: 3840,
      height: 2400,
    });
    expect(fitLongEdge(2500, 4000, 2532)).toEqual({
      width: 1583,
      height: 2532,
    });
    expect(fitLongEdge(1200, 800, 3840)).toEqual({ width: 1200, height: 800 });
    expect(fitLongEdge(10000, 10, 1920)).toEqual({ width: 1920, height: 2 });
  });
});

describe("worker first, main thread fallback", () => {
  const file = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });

  function fakeWorker(
    reply: (req: WallpaperCompressRequest, w: WorkerLike) => void,
  ) {
    const sent: WallpaperCompressRequest[] = [];
    let terminated = 0;
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(message) {
        sent.push(message);
        queueMicrotask(() => reply(message, worker));
      },
      terminate() {
        terminated++;
      },
    };
    return { worker, sent, terminated: () => terminated };
  }
  const answer = (w: WorkerLike, data: WallpaperCompressResponse) =>
    w.onmessage?.({ data } as MessageEvent<WallpaperCompressResponse>);

  test("uses the worker's result and never touches the main thread", async () => {
    const f = fakeWorker((_req, w) =>
      answer(w, {
        ok: true,
        dataUrl: "data:image/webp;base64,AAAA",
        width: 3840,
        height: 2400,
      }),
    );
    let mainCalls = 0;
    const out = await compressWallpaperImage(file, {
      maxSide: 3840,
      canUseWorker: true,
      createWorker: () => f.worker,
      mainThread: async () => {
        mainCalls++;
        return "main";
      },
    });
    expect(out).toBe("data:image/webp;base64,AAAA");
    expect(mainCalls).toBe(0);
    expect(f.sent).toEqual([{ file, maxSide: 3840 }]);
    expect(f.terminated()).toBe(1);
  });

  test("falls back to the main thread when the worker reports an error", async () => {
    const f = fakeWorker((_req, w) =>
      answer(w, { ok: false, error: "OffscreenCanvas 2D 不可用" }),
    );
    const fallbacks: unknown[] = [];
    const out = await compressWallpaperImage(file, {
      maxSide: 2000,
      canUseWorker: true,
      createWorker: () => f.worker,
      mainThread: async (_file, maxSide) => `main:${maxSide}`,
      onFallback: (e) => fallbacks.push(e),
    });
    expect(out).toBe("main:2000");
    expect(String(fallbacks[0])).toContain("OffscreenCanvas");
    expect(f.terminated()).toBe(1);
  });

  test("falls back when the worker throws, cannot start, or never answers", async () => {
    const crashing = fakeWorker((_req, w) => w.onerror?.(new Event("error")));
    expect(
      await compressWallpaperImage(file, {
        maxSide: 1,
        canUseWorker: true,
        createWorker: () => crashing.worker,
        mainThread: async () => "main-after-crash",
      }),
    ).toBe("main-after-crash");

    expect(
      await compressWallpaperImage(file, {
        maxSide: 1,
        canUseWorker: true,
        createWorker: () => {
          throw new Error("SecurityError");
        },
        mainThread: async () => "main-after-throw",
      }),
    ).toBe("main-after-throw");

    const silent = fakeWorker(() => {});
    const t0 = Date.now();
    expect(
      await compressWallpaperImage(file, {
        maxSide: 1,
        canUseWorker: true,
        workerTimeoutMs: 30,
        createWorker: () => silent.worker,
        mainThread: async () => "main-after-timeout",
      }),
    ).toBe("main-after-timeout");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(silent.terminated()).toBe(1);
  });

  test("goes straight to the main thread when the browser lacks Worker / OffscreenCanvas / createImageBitmap", async () => {
    let created = 0;
    const out = await compressWallpaperImage(file, {
      maxSide: 1,
      canUseWorker: false,
      createWorker: () => {
        created++;
        throw new Error("unused");
      },
      mainThread: async () => "main",
    });
    expect(out).toBe("main");
    expect(created).toBe(0);
    const fn = () => {};
    expect(
      canCompressInWorker({
        Worker: fn,
        OffscreenCanvas: fn,
        createImageBitmap: fn,
      } as never),
    ).toBe(true);
    expect(
      canCompressInWorker({ Worker: fn, createImageBitmap: fn } as never),
    ).toBe(false);
    expect(
      canCompressInWorker({
        OffscreenCanvas: fn,
        createImageBitmap: fn,
      } as never),
    ).toBe(false);
    expect(
      canCompressInWorker({ Worker: fn, OffscreenCanvas: fn } as never),
    ).toBe(false);
  });

  test("the worker is created the way Vite bundles it (new Worker(new URL(..., import.meta.url)))", () => {
    const src = readFileSync(
      path.join(import.meta.dir, "../src/lib/wallpaper-compress.ts"),
      "utf8",
    );
    expect(src).toMatch(
      /new Worker\(\s*new URL\("\.\/wallpaper-compress\.worker\.ts", import\.meta\.url\),\s*\{\s*type: "module"/,
    );
    const appearance = readFileSync(
      path.join(import.meta.dir, "../src/lib/appearance.ts"),
      "utf8",
    );
    expect(appearance).toContain(
      "assertWallpaperDataUrlSize(await compressWallpaperImage(file))",
    );
    expect(appearance).not.toContain("const maxSide = 1920");
  });
});

describe("encoding", () => {
  const blob = (type: string, size: number) =>
    new Blob([new Uint8Array(size)], { type });

  test("keeps WebP under the size limit, otherwise JPEG; PNG from a browser without WebP encoding counts as no WebP", async () => {
    const jpeg = blob("image/jpeg", 10);
    expect(
      await pickWallpaperBlob({
        webp: blob("image/webp", 1000),
        jpeg: async () => jpeg,
        width: 1,
        height: 1,
      }),
    ).toHaveProperty("type", "image/webp");
    expect(
      await pickWallpaperBlob({
        webp: null,
        jpeg: async () => jpeg,
        width: 1,
        height: 1,
      }),
    ).toBe(jpeg);
    const big = blob(
      "image/webp",
      Math.ceil((WALLPAPER_WEBP_MAX_CHARS * 3) / 4),
    );
    expect(dataUrlLength(big)).toBeGreaterThanOrEqual(WALLPAPER_WEBP_MAX_CHARS);
    expect(
      await pickWallpaperBlob({
        webp: big,
        jpeg: async () => jpeg,
        width: 1,
        height: 1,
      }),
    ).toBe(jpeg);
  });
});

describe("worker entry", () => {
  const saved = {
    self: (globalThis as Record<string, unknown>).self,
    createImageBitmap: (globalThis as Record<string, unknown>)
      .createImageBitmap,
    OffscreenCanvas: (globalThis as Record<string, unknown>).OffscreenCanvas,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved))
      (globalThis as Record<string, unknown>)[k] = v;
  });

  test("decodes, scales to the target, encodes WebP and answers with a data URL; bad images answer an error", async () => {
    const draws: number[][] = [];
    const encodes: string[] = [];
    let closed = 0;
    class FakeCanvas {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          imageSmoothingQuality: "low",
          drawImage: (
            _b: unknown,
            x: number,
            y: number,
            w: number,
            h: number,
          ) => draws.push([x, y, w, h]),
        };
      }
      async convertToBlob(opts: { type: string; quality: number }) {
        encodes.push(`${opts.type}@${opts.quality}`);
        return new Blob([new Uint8Array([7, 7, 7])], { type: opts.type });
      }
    }
    const posted: WallpaperCompressResponse[] = [];
    const scope: Record<string, unknown> = {
      postMessage: (m: WallpaperCompressResponse) => posted.push(m),
    };
    const g = globalThis as Record<string, unknown>;
    g.self = scope;
    g.OffscreenCanvas = FakeCanvas;
    g.createImageBitmap = async (b: Blob) => {
      if (b.type === "image/broken") throw new Error("decode");
      return { width: 4000, height: 2500, close: () => closed++ };
    };
    await import("@/lib/wallpaper-compress.worker");
    const onmessage = scope.onmessage as (e: {
      data: WallpaperCompressRequest;
    }) => Promise<void>;
    expect(typeof onmessage).toBe("function");

    await onmessage({
      data: {
        file: new Blob([new Uint8Array(4)], { type: "image/jpeg" }),
        maxSide: 3840,
      },
    });
    expect(draws).toEqual([[0, 0, 3840, 2400]]);
    expect(encodes).toEqual(["image/webp@0.84"]);
    expect(closed).toBe(1);
    expect(posted[0]).toEqual({
      ok: true,
      dataUrl: "data:image/webp;base64,BwcH",
      width: 3840,
      height: 2400,
    });

    await onmessage({
      data: { file: new Blob([], { type: "image/broken" }), maxSide: 3840 },
    });
    expect(posted[1]).toEqual({ ok: false, error: "无法解析该图片格式" });
  });

  test("compressBitmapToBlob returns null without a 2D context", async () => {
    (globalThis as Record<string, unknown>).OffscreenCanvas = class {
      getContext() {
        return null;
      }
    };
    expect(
      await compressBitmapToBlob(
        { width: 10, height: 10, close() {} } as ImageBitmap,
        5,
      ),
    ).toBeNull();
  });
});

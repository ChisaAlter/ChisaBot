import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { AppearancePreferences } from "@/components/settings/appearance-preferences";
import { ThemeProvider } from "@/components/theme-provider";
import {
  flushAppearanceWrites,
  getAppearanceState,
  loadUploadedWallpaperSource,
  resetAppearanceDefaults,
  saveUploadedWallpaper,
  saveUploadedWallpaperSource,
  setCustomWallpaperUrl,
  setWallpaperPreset,
} from "@/lib/appearance";
import {
  compressBitmapToBlob,
  compressWallpaperImage,
  dataUrlToBlob,
  type WorkerLike,
} from "@/lib/wallpaper-compress";
import {
  applyCropZoom,
  type CropHandle,
  centerCropAt,
  computeContainedImageBox,
  computeCropZoom,
  fitAspectCrop,
  isFullImageCrop,
  isNormalizedCropRect,
  isWallpaperAspectPresetId,
  MAX_WALLPAPER_CROP_ZOOM,
  MIN_WALLPAPER_CROP_PX,
  moveCropRect,
  type NormalizedCropRect,
  resizeCropRect,
  resolveAspectRatio,
  toPixelCropRect,
  WALLPAPER_ASPECT_PRESETS,
} from "@/lib/wallpaper-crop";
import {
  indexedDbWallpaperBackend,
  setWallpaperBackend,
  type WallpaperBackend,
  type WallpaperSourceRecord,
} from "@/lib/wallpaper-store";
import { settleReactWork } from "./settle-react-work";

function createInMemoryBackend(): WallpaperBackend & {
  records: Map<string, string>;
  sources: Map<string, WallpaperSourceRecord>;
} {
  const records = new Map<string, string>();
  const sources = new Map<string, WallpaperSourceRecord>();
  return {
    records,
    sources,
    async get() {
      return records.get("custom") ?? null;
    },
    async put(dataUrl: string) {
      records.set("custom", dataUrl);
    },
    async remove() {
      records.delete("custom");
    },
    async getSource() {
      return sources.get("custom-source") ?? null;
    },
    async putSource(record: WallpaperSourceRecord) {
      sources.set("custom-source", record);
    },
    async removeSource() {
      sources.delete("custom-source");
    },
  };
}

beforeAll(() => {
  GlobalRegistrator.register({
    url: "http://localhost:3710/settings/general",
  });
});

afterEach(() => {
  cleanup();
  setWallpaperBackend(indexedDbWallpaperBackend);
});

afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

describe("wallpaper-crop pure geometry", () => {
  test("resolveAspectRatio handles all presets including viewport and original image", () => {
    const base = {
      imageWidth: 3000,
      imageHeight: 2000,
      viewportWidth: 1440,
      viewportHeight: 900,
    };
    expect(resolveAspectRatio({ ...base, preset: "screen" })).toBeCloseTo(
      1.6,
      5,
    );
    expect(resolveAspectRatio({ ...base, preset: "16:9" })).toBeCloseTo(
      16 / 9,
      5,
    );
    expect(resolveAspectRatio({ ...base, preset: "16:10" })).toBeCloseTo(
      1.6,
      5,
    );
    expect(resolveAspectRatio({ ...base, preset: "21:9" })).toBeCloseTo(
      21 / 9,
      5,
    );
    expect(resolveAspectRatio({ ...base, preset: "4:3" })).toBeCloseTo(
      4 / 3,
      5,
    );
    expect(resolveAspectRatio({ ...base, preset: "9:16" })).toBeCloseTo(
      9 / 16,
      5,
    );
    expect(resolveAspectRatio({ ...base, preset: "original" })).toBeCloseTo(
      1.5,
      5,
    );
    expect(resolveAspectRatio({ ...base, preset: "free" })).toBeNull();
  });

  test("computeContainedImageBox centers image inside stage respecting padding", () => {
    const box = computeContainedImageBox({
      stageWidth: 560,
      stageHeight: 320,
      imageWidth: 2400,
      imageHeight: 1600,
      padding: 14,
    });
    expect(box.height).toBeCloseTo(292, 4);
    expect(box.width).toBeCloseTo(438, 4);
    expect(box.left).toBeCloseTo((560 - 438) / 2, 4);
    expect(box.top).toBeCloseTo(14, 4);
  });

  test("fitAspectCrop fits wide and portrait ratios centered and clamps off-center focus", () => {
    const portraitOnWide = fitAspectCrop({
      imageWidth: 2000,
      imageHeight: 1000,
      aspectRatio: 9 / 16,
    });
    expect(portraitOnWide.height).toBe(1);
    const actualRatio =
      (portraitOnWide.width * 2000) / (portraitOnWide.height * 1000);
    expect(actualRatio).toBeCloseTo(9 / 16, 4);
    expect(portraitOnWide.x).toBeCloseTo((1 - portraitOnWide.width) / 2, 4);

    const wideOnPortrait = fitAspectCrop({
      imageWidth: 1000,
      imageHeight: 2000,
      aspectRatio: 16 / 9,
      center: { x: 0.99, y: 0.99 },
    });
    expect(wideOnPortrait.width).toBe(1);
    expect(wideOnPortrait.y + wideOnPortrait.height).toBeCloseTo(1, 5);

    expect(
      fitAspectCrop({
        imageWidth: 2000,
        imageHeight: 1000,
        aspectRatio: null,
      }),
    ).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  test("moveCropRect and centerCropAt stay within [0, 1] image bounds", () => {
    const start: NormalizedCropRect = {
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    };
    expect(moveCropRect(start, 0.8, -0.8)).toEqual({
      x: 0.5,
      y: 0,
      width: 0.5,
      height: 0.5,
    });
    expect(centerCropAt(start, 0.02, 0.98)).toEqual({
      x: 0,
      y: 0.5,
      width: 0.5,
      height: 0.5,
    });
  });

  test("resizeCropRect preserves locked aspect ratio across all 8 handles and enforces minimum pixel floor", () => {
    const start: NormalizedCropRect = {
      x: 0.2,
      y: 0.2,
      width: 0.4,
      height: 0.45,
    };
    const imageWidth = 2000;
    const imageHeight = 1000;
    const aspectRatio = 16 / 9;

    const deltas: Record<CropHandle, { dx: number; dy: number }> = {
      nw: { dx: 0.05, dy: 0.05 },
      n: { dx: 0, dy: 0.06 },
      ne: { dx: -0.05, dy: 0.05 },
      e: { dx: -0.08, dy: 0 },
      se: { dx: -0.06, dy: -0.06 },
      s: { dx: 0, dy: -0.06 },
      sw: { dx: 0.05, dy: -0.05 },
      w: { dx: 0.08, dy: 0 },
    };

    for (const handle of Object.keys(deltas) as CropHandle[]) {
      const { dx, dy } = deltas[handle];
      const next = resizeCropRect({
        startRect: start,
        handle,
        dxNorm: dx,
        dyNorm: dy,
        imageWidth,
        imageHeight,
        aspectRatio,
      });
      expect(next.x).toBeGreaterThanOrEqual(0);
      expect(next.y).toBeGreaterThanOrEqual(0);
      expect(next.x + next.width).toBeLessThanOrEqual(1 + 1e-6);
      expect(next.y + next.height).toBeLessThanOrEqual(1 + 1e-6);
      const pixelRatio =
        (next.width * imageWidth) / (next.height * imageHeight);
      expect(pixelRatio).toBeCloseTo(aspectRatio, 3);
    }

    // 缩放到极限也不能小于 MIN_WALLPAPER_CROP_PX
    const shrunk = resizeCropRect({
      startRect: start,
      handle: "se",
      dxNorm: -0.99,
      dyNorm: -0.99,
      imageWidth,
      imageHeight,
      aspectRatio,
    });
    const px = toPixelCropRect(shrunk, imageWidth, imageHeight);
    expect(px.sw).toBeGreaterThanOrEqual(MIN_WALLPAPER_CROP_PX);
    expect(px.sh).toBeGreaterThanOrEqual(MIN_WALLPAPER_CROP_PX);
  });

  test("resizeCropRect allows independent axes in free aspect mode", () => {
    const start: NormalizedCropRect = {
      x: 0.1,
      y: 0.1,
      width: 0.8,
      height: 0.8,
    };
    const next = resizeCropRect({
      startRect: start,
      handle: "e",
      dxNorm: -0.3,
      dyNorm: 0.25,
      imageWidth: 1600,
      imageHeight: 900,
      aspectRatio: null,
    });
    expect(next.x).toBeCloseTo(0.1, 5);
    expect(next.y).toBeCloseTo(0.1, 5);
    expect(next.width).toBeCloseTo(0.5, 5);
    expect(next.height).toBeCloseTo(0.8, 5);
  });

  test("computeCropZoom and applyCropZoom zoom around center and respect caps", () => {
    const full = fitAspectCrop({
      imageWidth: 2400,
      imageHeight: 1600,
      aspectRatio: 16 / 9,
    });
    expect(
      computeCropZoom({
        rect: full,
        imageWidth: 2400,
        imageHeight: 1600,
        aspectRatio: 16 / 9,
      }),
    ).toBeCloseTo(1, 3);

    const zoomed = applyCropZoom({
      rect: full,
      nextZoom: 2,
      imageWidth: 2400,
      imageHeight: 1600,
      aspectRatio: 16 / 9,
    });
    expect(zoomed.width).toBeCloseTo(full.width / 2, 4);
    expect(zoomed.height).toBeCloseTo(full.height / 2, 4);
    expect(zoomed.x + zoomed.width / 2).toBeCloseTo(full.x + full.width / 2, 4);
    expect(zoomed.y + zoomed.height / 2).toBeCloseTo(
      full.y + full.height / 2,
      4,
    );

    const capped = applyCropZoom({
      rect: full,
      nextZoom: MAX_WALLPAPER_CROP_ZOOM + 10,
      imageWidth: 2400,
      imageHeight: 1600,
      aspectRatio: 16 / 9,
    });
    expect(
      computeCropZoom({
        rect: capped,
        imageWidth: 2400,
        imageHeight: 1600,
        aspectRatio: 16 / 9,
      }),
    ).toBeCloseTo(MAX_WALLPAPER_CROP_ZOOM, 3);
  });

  test("pixel rect conversion and type validators handle boundaries", () => {
    const px = toPixelCropRect(
      { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
      2000,
      1000,
    );
    expect(px).toEqual({ sx: 200, sy: 200, sw: 1000, sh: 600 });
    expect(
      isFullImageCrop({ sx: 0, sy: 0, sw: 2000, sh: 1000 }, 2000, 1000),
    ).toBe(true);
    expect(isFullImageCrop(px, 2000, 1000)).toBe(false);

    for (const item of WALLPAPER_ASPECT_PRESETS) {
      expect(isWallpaperAspectPresetId(item.id)).toBe(true);
    }
    expect(isWallpaperAspectPresetId("ultra")).toBe(false);
    expect(
      isNormalizedCropRect({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 }),
    ).toBe(true);
    expect(
      isNormalizedCropRect({ x: 0.7, y: 0.1, width: 0.5, height: 0.5 }),
    ).toBe(false);
    expect(
      isNormalizedCropRect({ x: -0.1, y: 0, width: 0.5, height: 0.5 }),
    ).toBe(false);
    expect(isNormalizedCropRect({ x: 0, y: 0, width: 0, height: 0.5 })).toBe(
      false,
    );
  });
});

describe("wallpaper-compress crop & dataUrlToBlob", () => {
  const originalOffscreen = globalThis.OffscreenCanvas;

  afterEach(() => {
    globalThis.OffscreenCanvas = originalOffscreen;
  });

  test("dataUrlToBlob converts base64 data URL without network fetch", async () => {
    const raw = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 42]);
    let binary = "";
    for (const byte of raw) {
      binary += String.fromCharCode(byte);
    }
    const dataUrl = `data:image/png;base64,${btoa(binary)}`;
    const blob = dataUrlToBlob(dataUrl);
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(raw.length);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(raw);
    expect(() => dataUrlToBlob("https://example.com/a.png")).toThrow();
  });

  test("compressBitmapToBlob uses 9-arg drawImage with clamped source region", async () => {
    const drawImageCalls: unknown[][] = [];
    const createdDims: { width: number; height: number }[] = [];

    class MockOffscreenCanvas {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        createdDims.push({ width, height });
      }
      getContext() {
        return {
          imageSmoothingQuality: "high",
          drawImage: (...args: unknown[]) => {
            drawImageCalls.push(args);
          },
        };
      }
      async convertToBlob(opts: { type: string }) {
        return new Blob(["webp-bytes"], { type: opts.type });
      }
    }

    globalThis.OffscreenCanvas =
      MockOffscreenCanvas as unknown as typeof OffscreenCanvas;

    const fakeBitmap = {
      width: 4000,
      height: 3000,
      close: () => {},
    } as unknown as ImageBitmap;

    const encoded = await compressBitmapToBlob(fakeBitmap, 3840, {
      sx: 400,
      sy: 200,
      sw: 1600,
      sh: 900,
    });
    expect(encoded?.webp?.type).toBe("image/webp");
    expect(encoded?.width).toBe(1600);
    expect(encoded?.height).toBe(900);
    expect(createdDims[0]).toEqual({ width: 1600, height: 900 });
    expect(drawImageCalls[0]).toEqual([
      fakeBitmap,
      400,
      200,
      1600,
      900,
      0,
      0,
      1600,
      900,
    ]);

    const scaledDown = await compressBitmapToBlob(fakeBitmap, 1920, {
      sx: 0,
      sy: 0,
      sw: 3840,
      sh: 2160,
    });
    expect(scaledDown?.width).toBe(1920);
    expect(scaledDown?.height).toBe(1080);
    expect(createdDims[1]).toEqual({ width: 1920, height: 1080 });
  });

  test("compressWallpaperImage forwards crop to Worker and falls back cleanly on main thread", async () => {
    const workerPayloads: unknown[] = [];
    const createSuccessWorker = (): WorkerLike => {
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage(data) {
          workerPayloads.push(data);
          queueMicrotask(() => {
            worker.onmessage?.({
              data: {
                ok: true,
                dataUrl: "data:image/webp;base64,V09SS0VS",
                width: 800,
                height: 450,
              },
            } as MessageEvent);
          });
        },
        terminate() {},
      };
      return worker;
    };

    const file = new File(["img"], "bg.png", { type: "image/png" });
    const crop = { sx: 10, sy: 20, sw: 800, sh: 450 };

    const workerResult = await compressWallpaperImage(file, {
      crop,
      maxSide: 3840,
      canUseWorker: true,
      createWorker: createSuccessWorker,
    });
    expect(workerResult).toBe("data:image/webp;base64,V09SS0VS");
    expect(workerPayloads[0]).toEqual({ file, maxSide: 3840, crop });

    // Worker 出错时带着相同的 crop 参数退回主线程
    const createFailingWorker = (): WorkerLike => {
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage() {
          queueMicrotask(() => {
            worker.onerror?.(new Event("error"));
          });
        },
        terminate() {},
      };
      return worker;
    };

    const mainCalls: unknown[][] = [];
    const fallbackResult = await compressWallpaperImage(file, {
      crop,
      maxSide: 3840,
      canUseWorker: true,
      createWorker: createFailingWorker,
      mainThread: async (...args) => {
        mainCalls.push(args);
        return "data:image/webp;base64,FALLBACK";
      },
    });
    expect(fallbackResult).toBe("data:image/webp;base64,FALLBACK");
    expect(mainCalls[0]).toEqual([file, 3840, crop]);
  });
});

describe("wallpaper source persistence", () => {
  let backend = createInMemoryBackend();

  beforeEach(() => {
    backend = createInMemoryBackend();
    setWallpaperBackend(backend);
    localStorage.clear();
    resetAppearanceDefaults();
    flushAppearanceWrites();
  });

  test("persists source + last crop rect/preset and clears both on remove or reset", async () => {
    await saveUploadedWallpaper("data:image/webp;base64,CROPPED");
    await saveUploadedWallpaperSource({
      sourceDataUrl: "data:image/png;base64,ORIGINAL",
      preset: "16:9",
      rect: { x: 0.1, y: 0.2, width: 0.8, height: 0.45 },
    });

    const loaded = await loadUploadedWallpaperSource();
    expect(loaded).toEqual({
      sourceDataUrl: "data:image/png;base64,ORIGINAL",
      preset: "16:9",
      rect: { x: 0.1, y: 0.2, width: 0.8, height: 0.45 },
    });

    // 切到预设艺术壁纸时保留原图缓存与已裁剪结果
    setWallpaperPreset("waterlily-pond");
    await Promise.resolve();
    expect(backend.records.get("custom")).toBe(
      "data:image/webp;base64,CROPPED",
    );
    expect(await loadUploadedWallpaperSource()).not.toBeNull();

    // 清空自定义壁纸时同步清除原图缓存
    setCustomWallpaperUrl("");
    await Promise.resolve();
    expect(backend.records.get("custom")).toBeUndefined();
    expect(await loadUploadedWallpaperSource()).toBeNull();

    // 恢复默认设置时同样清除原图缓存
    await saveUploadedWallpaper("data:image/webp;base64,CROPPED2");
    await saveUploadedWallpaperSource({
      sourceDataUrl: "data:image/png;base64,ORIGINAL2",
      preset: "9:16",
      rect: { x: 0.3, y: 0, width: 0.4, height: 1 },
    });
    resetAppearanceDefaults();
    await Promise.resolve();
    expect(await loadUploadedWallpaperSource()).toBeNull();
  });
});

describe("AppearancePreferences wallpaper crop dialog integration", () => {
  let originalImage: typeof globalThis.Image;
  let originalCreateObjectURL: typeof URL.createObjectURL;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL;
  let originalWorker: typeof globalThis.Worker;
  let originalInnerWidth = 1024;
  let originalInnerHeight = 768;
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
  let originalToDataURL: typeof HTMLCanvasElement.prototype.toDataURL;

  let backend = createInMemoryBackend();
  const mockNaturalWidth = 2400;
  const mockNaturalHeight = 1600;
  let createdBlobUrls: string[] = [];
  let revokedBlobUrls: string[] = [];
  let drawImageCalls: unknown[][] = [];
  let urlCounter = 0;

  beforeEach(() => {
    originalImage = globalThis.Image;
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    originalWorker = globalThis.Worker;
    originalInnerWidth = window.innerWidth;
    originalInnerHeight = window.innerHeight;
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    originalToDataURL = HTMLCanvasElement.prototype.toDataURL;

    backend = createInMemoryBackend();
    setWallpaperBackend(backend);
    localStorage.clear();
    resetAppearanceDefaults();
    flushAppearanceWrites();

    createdBlobUrls = [];
    revokedBlobUrls = [];
    drawImageCalls = [];
    urlCounter = 0;

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1440,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 900,
    });

    class MockImage {
      naturalWidth = mockNaturalWidth;
      naturalHeight = mockNaturalHeight;
      width = mockNaturalWidth;
      height = mockNaturalHeight;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private _src = "";
      set src(value: string) {
        this._src = value;
        queueMicrotask(() => {
          this.naturalWidth = mockNaturalWidth;
          this.naturalHeight = mockNaturalHeight;
          this.width = mockNaturalWidth;
          this.height = mockNaturalHeight;
          this.onload?.();
        });
      }
      get src() {
        return this._src;
      }
    }
    globalThis.Image = MockImage as unknown as typeof Image;

    URL.createObjectURL = () => {
      const url = `blob:http://localhost:3710/mock-${++urlCounter}`;
      createdBlobUrls.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      revokedBlobUrls.push(url);
    };

    // 主线程降级路径使用 <canvas> 的 getContext("2d") 与 toDataURL
    globalThis.Worker = undefined as unknown as typeof Worker;
    HTMLCanvasElement.prototype.getContext = function mockGetContext(
      contextId: string,
    ) {
      if (contextId !== "2d") return null;
      return {
        imageSmoothingQuality: "high",
        drawImage: (...args: unknown[]) => {
          drawImageCalls.push(args);
        },
      } as unknown as CanvasRenderingContext2D;
    } as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = () =>
      "data:image/webp;base64,UklGRg==";
  });

  afterEach(() => {
    globalThis.Image = originalImage;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    globalThis.Worker = originalWorker;
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalInnerWidth,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  const body = () => within(document.body);

  test("rejects unsupported file types without opening crop dialog", async () => {
    const { container } = render(<ThemeProvider><AppearancePreferences /></ThemeProvider>);
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    if (!input) return;

    const invalidFile = new File(["plain"], "note.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [invalidFile] } });

    await settleReactWork();
    expect(body().queryByTestId("wallpaper-crop-dialog") === null).toBe(true);
    expect(createdBlobUrls).toEqual([]);
  });

  test("opens crop dialog on upload, supports cancel without mutating wallpaper", async () => {
    const { container } = render(<ThemeProvider><AppearancePreferences /></ThemeProvider>);
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    if (!input) return;

    const file = new File(["imgdata"], "desktop.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    const dialog = await body().findByTestId("wallpaper-crop-dialog");
    expect(dialog).toBeTruthy();

    // 默认选中"当前屏幕"（1440×900 -> 16:10），2400×1600 的最大 16:10 为 2400×1500
    const screenPreset = body().getByTestId("wallpaper-crop-preset-screen");
    expect(screenPreset.getAttribute("aria-checked")).toBe("true");
    expect(body().getByTestId("wallpaper-crop-dimensions").textContent).toBe(
      "2400 × 1500 px",
    );

    fireEvent.click(body().getByTestId("wallpaper-crop-cancel"));
    await waitFor(() => {
      expect(body().queryByTestId("wallpaper-crop-dialog") === null).toBe(true);
    });
    expect(revokedBlobUrls).toEqual(createdBlobUrls);
    expect(getAppearanceState().wallpaperId).toBe("none");
  });

  test("supports preset switch, handle drag, zoom slider, keyboard move, apply, and lossless recrop", async () => {
    const { container } = render(<ThemeProvider><AppearancePreferences /></ThemeProvider>);
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    if (!input) return;

    const file = new File(["raw-original-bytes"], "photo.png", {
      type: "image/png",
    });
    fireEvent.change(input, { target: { files: [file] } });

    await body().findByTestId("wallpaper-crop-dialog");

    // 切换到 9:16 竖屏裁切：2400×1600 居中适配高度 1600 -> 900 × 1600 px
    fireEvent.click(body().getByTestId("wallpaper-crop-preset-9:16"));
    expect(body().getByTestId("wallpaper-crop-dimensions").textContent).toBe(
      "900 × 1600 px",
    );

    // 拖动东南角手柄缩小裁剪区
    const stage = body().getByTestId("wallpaper-crop-stage");
    const seHandle = body().getByTestId("wallpaper-crop-handle-se");
    fireEvent.pointerDown(seHandle, {
      button: 0,
      clientX: 400,
      clientY: 280,
      pointerId: 1,
    });
    fireEvent.pointerMove(stage, {
      clientX: 340,
      clientY: 220,
      pointerId: 1,
    });
    fireEvent.pointerUp(stage, { pointerId: 1 });
    const afterDragText =
      body().getByTestId("wallpaper-crop-dimensions").textContent ?? "";
    expect(afterDragText).not.toBe("900 × 1600 px");

    // 拖动选区移动并按方向键微调 + 重置
    const cropBox = body().getByTestId("wallpaper-crop-box");
    const initialStyle = cropBox.getAttribute("style");
    fireEvent.pointerDown(cropBox, {
      button: 0,
      clientX: 250,
      clientY: 160,
      pointerId: 2,
    });
    fireEvent.pointerMove(stage, {
      clientX: 275,
      clientY: 160,
      pointerId: 2,
    });
    fireEvent.pointerUp(stage, { pointerId: 2 });
    expect(cropBox.getAttribute("style")).not.toBe(initialStyle);

    // 点击空白舞台处会直接把选区重定位过去
    const beforeStageClickStyle = cropBox.getAttribute("style");
    fireEvent.pointerDown(stage, {
      button: 0,
      clientX: 100,
      clientY: 160,
      pointerId: 3,
    });
    fireEvent.pointerUp(stage, { pointerId: 3 });
    expect(cropBox.getAttribute("style")).not.toBe(beforeStageClickStyle);

    fireEvent.keyDown(stage, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(stage, { key: "+" });
    expect(
      body().getByTestId("wallpaper-crop-dimensions").textContent,
    ).not.toBe("900 × 1600 px");

    // 自由预设 + 滚轮缩放
    fireEvent.click(body().getByTestId("wallpaper-crop-preset-free"));
    expect(
      body()
        .getByTestId("wallpaper-crop-preset-free")
        .getAttribute("aria-checked"),
    ).toBe("true");
    const beforeWheelText =
      body().getByTestId("wallpaper-crop-dimensions").textContent ?? "";
    fireEvent.wheel(stage, { deltaY: -180 });
    expect(
      body().getByTestId("wallpaper-crop-dimensions").textContent ?? "",
    ).not.toBe(beforeWheelText);

    // 切回 9:16 重置到满高选区，再用缩放滑杆缩放到 2×
    fireEvent.click(body().getByTestId("wallpaper-crop-preset-9:16"));
    fireEvent.click(body().getByTestId("wallpaper-crop-reset"));
    expect(body().getByTestId("wallpaper-crop-dimensions").textContent).toBe(
      "900 × 1600 px",
    );

    const zoomSlider = body().getByTestId(
      "wallpaper-crop-zoom",
    ) as HTMLInputElement;
    fireEvent.input(zoomSlider, { target: { value: "2" } });
    expect(body().getByTestId("wallpaper-crop-dimensions").textContent).toBe(
      "450 × 800 px",
    );

    // 点击应用壁纸：用真实裁剪区域调用 drawImage，持久化并激活 custom
    fireEvent.click(body().getByTestId("wallpaper-crop-apply"));
    await waitFor(() => {
      expect(body().queryByTestId("wallpaper-crop-dialog") === null).toBe(true);
    });

    expect(drawImageCalls.length).toBeGreaterThan(0);
    const cropDrawCall = drawImageCalls[0];
    expect(cropDrawCall?.length).toBe(9);
    // 原图 2400×1600 中心裁剪 450×800 -> sx=975, sy=400, sw=450, sh=800
    expect(cropDrawCall?.slice(1, 5)).toEqual([975, 400, 450, 800]);
    expect(getAppearanceState().wallpaperId).toBe("custom");
    expect(backend.records.get("custom")).toStartWith(
      "data:image/webp;base64,",
    );
    const savedSource = await loadUploadedWallpaperSource();
    expect(savedSource?.preset).toBe("9:16");
    expect(savedSource?.rect.width).toBeCloseTo(450 / 2400, 3);
    expect(savedSource?.rect.height).toBeCloseTo(800 / 1600, 3);

    // 出现"裁剪区域"按钮，点击后恢复原图与上次预设比例 9:16 和选框尺寸 450×800
    const recropBtn = await body().findByTestId("wallpaper-custom-recrop");
    fireEvent.click(recropBtn);
    await body().findByTestId("wallpaper-crop-dialog");
    expect(
      body()
        .getByTestId("wallpaper-crop-preset-9:16")
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(body().getByTestId("wallpaper-crop-dimensions").textContent).toBe(
      "450 × 800 px",
    );

    // 二次重裁切到 16:9 并应用
    fireEvent.click(body().getByTestId("wallpaper-crop-preset-16:9"));
    expect(body().getByTestId("wallpaper-crop-dimensions").textContent).toBe(
      "2400 × 1350 px",
    );
    fireEvent.click(body().getByTestId("wallpaper-crop-apply"));
    await waitFor(() => {
      expect(body().queryByTestId("wallpaper-crop-dialog") === null).toBe(true);
    });
    const secondSource = await loadUploadedWallpaperSource();
    expect(secondSource?.preset).toBe("16:9");
  });
});

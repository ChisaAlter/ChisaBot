import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  assertWallpaperDataUrlSize,
  compressUploadedWallpaper,
  flushAppearanceWrites,
  GLASS_OPACITY_STORAGE_KEY,
  getAppearanceState,
  MAX_WALLPAPER_DATA_URL_CHARS,
  MAX_WALLPAPER_FILE_BYTES,
  reloadAppearanceFromStorage,
  resetAppearanceDefaults,
  resolveActiveWallpaperCss,
  SLIDER_WRITE_DELAY_MS,
  saveUploadedWallpaper,
  setCustomWallpaperUrl,
  setGlassOpacity,
  setWallpaperBlur,
  setWallpaperDim,
  validateWallpaperFile,
  WALLPAPER_BLUR_STORAGE_KEY,
  WALLPAPER_CUSTOM_URL_STORAGE_KEY,
  WALLPAPER_DIM_STORAGE_KEY,
  WALLPAPER_ID_STORAGE_KEY,
} from "../src/lib/appearance";
import {
  setWallpaperBackend,
  WALLPAPER_IDB_MARKER,
  type WallpaperBackend,
} from "../src/lib/wallpaper-store";

const read = (rel: string) =>
  readFileSync(path.join(import.meta.dir, rel), "utf8");

function memoryBackend() {
  const box: { value: string | null; puts: number; fail: boolean } = {
    value: null,
    puts: 0,
    fail: false,
  };
  const backend: WallpaperBackend = {
    async get() {
      return box.value;
    },
    async put(v) {
      if (box.fail) throw new Error("QuotaExceededError");
      box.puts += 1;
      box.value = v;
    },
    async remove() {
      box.value = null;
    },
  };
  return { box, backend };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const DATA_URL = `data:image/webp;base64,${"A".repeat(4096)}`;

let mem = memoryBackend();
let restore: WallpaperBackend;

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

beforeEach(() => {
  mem = memoryBackend();
  restore = setWallpaperBackend(mem.backend);
  resetAppearanceDefaults();
  flushAppearanceWrites();
  window.localStorage.clear();
});

afterEach(() => {
  resetAppearanceDefaults();
  flushAppearanceWrites();
  setWallpaperBackend(restore);
});

describe("1) 隐私：天空引擎不再调用 ipapi.co", () => {
  test("wallpaper_core.html 没有任何第三方 IP 定位请求，降级改用浏览器时区", () => {
    const html = read("../public/wallpaper_core.html");
    expect(html).not.toMatch(/fetch\(\s*['"`]https?:\/\/(www\.)?ipapi\.co/);
    expect(html).not.toMatch(/['"`]https?:\/\/(www\.)?ipapi\.co/);
    const ipLocate = html.slice(
      html.indexOf("ipLocate:"),
      html.indexOf("search: (q, token)"),
    );
    expect(ipLocate).toContain("resolvedOptions().timeZone");
    expect(ipLocate).toContain("CITIES.find");
    expect(ipLocate).not.toContain("fetch(");
  });

  test("sky-background 的 fetch 拦截层兜底拦掉 ipapi.co", () => {
    const src = read("../src/components/sky-background.tsx");
    expect(src).toContain('url.includes("ipapi.co")');
  });
});

describe("2) 壁纸上传：类型、大小上限与保存失败提示", () => {
  test("只接受 PNG / JPG / WebP / GIF / AVIF，超过 20 MB 直接拒绝", () => {
    expect(validateWallpaperFile({ type: "image/png", size: 1024 })).toBeNull();
    expect(
      validateWallpaperFile({
        type: "image/jpeg",
        size: MAX_WALLPAPER_FILE_BYTES,
      }),
    ).toBeNull();
    expect(
      validateWallpaperFile({ type: "image/svg+xml", size: 10 }),
    ).toContain("图片格式");
    expect(validateWallpaperFile({ type: "text/html", size: 10 })).toContain(
      "图片格式",
    );
    expect(
      validateWallpaperFile({
        type: "image/png",
        size: MAX_WALLPAPER_FILE_BYTES + 1,
      }),
    ).toContain("图片太大");
  });

  test("超限文件在读进内存前就被 compressUploadedWallpaper 拒绝", async () => {
    const big = new File(
      [new Uint8Array(MAX_WALLPAPER_FILE_BYTES + 1)],
      "big.png",
      {
        type: "image/png",
      },
    );
    await expect(compressUploadedWallpaper(big)).rejects.toThrow("图片太大");
    const svg = new File(["<svg/>"], "x.svg", { type: "image/svg+xml" });
    await expect(compressUploadedWallpaper(svg)).rejects.toThrow("图片格式");
  });

  test("压缩后仍超限会报错", () => {
    expect(assertWallpaperDataUrlSize("data:image/jpeg;base64,AAAA")).toBe(
      "data:image/jpeg;base64,AAAA",
    );
    expect(() =>
      assertWallpaperDataUrlSize("x".repeat(MAX_WALLPAPER_DATA_URL_CHARS + 1)),
    ).toThrow("压缩后仍然太大");
  });

  test("保存失败（配额不足）抛出明确错误，且不会假装已应用", async () => {
    mem.box.fail = true;
    await expect(saveUploadedWallpaper(DATA_URL)).rejects.toThrow(
      "壁纸保存失败",
    );
    expect(getAppearanceState().wallpaperId).toBe("none");
    expect(getAppearanceState().customWallpaperUrl).toBe("");
  });

  test("上传组件用现有 toast 提示校验与保存错误", () => {
    const src = read("../src/components/settings/appearance-preferences.tsx");
    expect(src).toContain("validateWallpaperFile(file)");
    expect(src).toContain("await saveUploadedWallpaper(dataUrl)");
    expect(src).toContain("toast.error(invalid)");
  });

  test("自定义壁纸 URL 写进 CSS 时转义反斜杠、引号并去掉换行", () => {
    setCustomWallpaperUrl('https://example.com/a"b\\c\nd.jpg');
    expect(resolveActiveWallpaperCss(getAppearanceState())).toBe(
      'url("https://example.com/a\\"b\\\\cd.jpg")',
    );
  });
});

describe("4) 外观滑块：localStorage 写入防抖，预览实时", () => {
  test("连续拖动只在停手后写一次，状态每一步都立即更新", async () => {
    const storage = window.localStorage;
    const keys = [
      GLASS_OPACITY_STORAGE_KEY,
      WALLPAPER_BLUR_STORAGE_KEY,
      WALLPAPER_DIM_STORAGE_KEY,
    ];
    for (let v = 6; v <= 30; v += 1) {
      setGlassOpacity(v);
      setWallpaperBlur(v);
      setWallpaperDim(v);
      expect(getAppearanceState().glassOpacity).toBe(v);
      expect(getAppearanceState().wallpaperBlur).toBe(v);
      expect(
        document.documentElement.style.getPropertyValue("--lg-alpha"),
      ).toBe((v / 100).toFixed(2));
      // 拖动过程中一个滑块键都没写
      for (const k of keys) expect(storage.getItem(k)).toBeNull();
    }
    await new Promise((r) => setTimeout(r, SLIDER_WRITE_DELAY_MS + 80));
    for (const k of keys) expect(storage.getItem(k)).toBe("30");
  });

  test("flushAppearanceWrites 立即写出（pagehide 时调用）", () => {
    setGlassOpacity(22);
    expect(window.localStorage.getItem(GLASS_OPACITY_STORAGE_KEY)).toBeNull();
    flushAppearanceWrites();
    expect(window.localStorage.getItem(GLASS_OPACITY_STORAGE_KEY)).toBe("22");
  });
});

describe("5) 壁纸图片数据存 IndexedDB，不进 localStorage", () => {
  test("上传后 localStorage 只有占位标记，刷新后从 IndexedDB 读回", async () => {
    await saveUploadedWallpaper(DATA_URL);
    expect(getAppearanceState().customWallpaperUrl).toBe(DATA_URL);
    expect(window.localStorage.getItem(WALLPAPER_CUSTOM_URL_STORAGE_KEY)).toBe(
      WALLPAPER_IDB_MARKER,
    );
    expect(window.localStorage.getItem(WALLPAPER_ID_STORAGE_KEY)).toBe(
      "custom",
    );
    expect(mem.box.value).toBe(DATA_URL);
    expect(mem.box.puts).toBe(1);

    await reloadAppearanceFromStorage();
    expect(getAppearanceState().wallpaperId).toBe("custom");
    expect(getAppearanceState().customWallpaperUrl).toBe(DATA_URL);
    expect(resolveActiveWallpaperCss(getAppearanceState())).toContain(
      "data:image/webp",
    );
  });

  test("旧版本 localStorage 里的 Data URL 迁移进 IndexedDB 并清掉", async () => {
    window.localStorage.setItem(WALLPAPER_ID_STORAGE_KEY, "custom");
    window.localStorage.setItem(WALLPAPER_CUSTOM_URL_STORAGE_KEY, DATA_URL);
    await reloadAppearanceFromStorage();
    expect(getAppearanceState().customWallpaperUrl).toBe(DATA_URL);
    expect(mem.box.value).toBe(DATA_URL);
    expect(window.localStorage.getItem(WALLPAPER_CUSTOM_URL_STORAGE_KEY)).toBe(
      WALLPAPER_IDB_MARKER,
    );
  });

  test("迁移失败时保留旧数据，壁纸不丢", async () => {
    mem.box.fail = true;
    window.localStorage.setItem(WALLPAPER_ID_STORAGE_KEY, "custom");
    window.localStorage.setItem(WALLPAPER_CUSTOM_URL_STORAGE_KEY, DATA_URL);
    await reloadAppearanceFromStorage();
    expect(getAppearanceState().customWallpaperUrl).toBe(DATA_URL);
    expect(window.localStorage.getItem(WALLPAPER_CUSTOM_URL_STORAGE_KEY)).toBe(
      DATA_URL,
    );
  });

  test("移除壁纸会清掉 IndexedDB 里的图片；普通网址仍存 localStorage", async () => {
    await saveUploadedWallpaper(DATA_URL);
    setCustomWallpaperUrl("");
    await tick();
    expect(mem.box.value).toBeNull();
    expect(window.localStorage.getItem(WALLPAPER_CUSTOM_URL_STORAGE_KEY)).toBe(
      "",
    );

    setCustomWallpaperUrl("https://example.com/wall.jpg");
    expect(window.localStorage.getItem(WALLPAPER_CUSTOM_URL_STORAGE_KEY)).toBe(
      "https://example.com/wall.jpg",
    );
    expect(mem.box.value).toBeNull();
  });

  test("直接设置 Data URL 也只写占位标记，图片写进 IndexedDB", async () => {
    setCustomWallpaperUrl(DATA_URL);
    await tick();
    expect(window.localStorage.getItem(WALLPAPER_CUSTOM_URL_STORAGE_KEY)).toBe(
      WALLPAPER_IDB_MARKER,
    );
    expect(mem.box.value).toBe(DATA_URL);
  });
});

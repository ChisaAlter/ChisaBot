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
  APPEARANCE_STORAGE_KEY,
  assertWallpaperDataUrlSize,
  compressUploadedWallpaper,
  flushAppearanceWrites,
  getAppearanceConfig,
  getCustomWallpaperUrl,
  MAX_WALLPAPER_DATA_URL_CHARS,
  MAX_WALLPAPER_FILE_BYTES,
  reloadAppearanceFromStorage,
  removeCustomWallpaper,
  resetAppearance,
  resolveWallpaperCssFromConfig,
  SLIDER_WRITE_DELAY_MS,
  saveUploadedWallpaper,
  setWallpaperAdjustments,
  setWallpaperSource,
  validateWallpaperFile,
  WALLPAPER_CUSTOM_URL_STORAGE_KEY,
  WALLPAPER_ID_STORAGE_KEY,
} from "../src/lib/appearance";
import {
  setWallpaperBackend,
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

beforeEach(async () => {
  mem = memoryBackend();
  restore = setWallpaperBackend(mem.backend);
  window.localStorage.clear();
  resetAppearance();
  flushAppearanceWrites();
  window.localStorage.clear();
  await reloadAppearanceFromStorage();
});

afterEach(() => {
  resetAppearance();
  flushAppearanceWrites();
  setWallpaperBackend(restore);
  document.body.innerHTML = "";
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
    expect(getAppearanceConfig().canvas.kind).toBe("sky");
    expect(getCustomWallpaperUrl()).toBe("");
  });

  test("上传组件用现有 toast 提示校验与保存错误", () => {
    const src = read("../src/components/settings/appearance-preferences.tsx");
    expect(src).toContain("validateWallpaperFile(file)");
    expect(src).toContain("await saveUploadedWallpaper(dataUrl)");
    expect(src).toContain("toast.error(invalid)");
  });

  test("自定义壁纸 URL 写进 CSS 时转义反斜杠、引号并去掉换行", () => {
    setWallpaperSource("custom");
    expect(
      resolveWallpaperCssFromConfig(
        getAppearanceConfig(),
        'https://example.com/a"b\\c\nd.jpg',
      ),
    ).toBe('url("https://example.com/a\\"b\\\\cd.jpg")');
  });
});

describe("4) 壁纸滑块：localStorage 写入防抖，#sky-root 预览实时", () => {
  test("连续拖动模糊与薄幕只在停手后写一次 chisabot-appearance，#sky-root 变量每步实时更新且不碰 <html>", async () => {
    const skyRoot = document.createElement("div");
    skyRoot.id = "sky-root";
    document.body.appendChild(skyRoot);

    setWallpaperSource("waterlily-pond");
    const beforeStored = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);

    for (let v = 4; v <= 20; v += 2) {
      setWallpaperAdjustments({ blur: v, scrim: v * 2 });
      const cfg = getAppearanceConfig();
      expect(cfg.canvas.kind).toBe("wallpaper");
      if (cfg.canvas.kind === "wallpaper") {
        expect(cfg.canvas.blur).toBe(v);
        expect(cfg.canvas.scrim).toBe(v * 2);
      }
      expect(skyRoot.style.getPropertyValue("--canvas-blur")).toBe(`${v}px`);
      expect(skyRoot.style.getPropertyValue("--canvas-scrim")).toBe(
        ((v * 2) / 100).toFixed(2),
      );
      expect(
        document.documentElement.style.getPropertyValue("--canvas-blur"),
      ).toBe("");
      expect(
        document.documentElement.style.getPropertyValue("--canvas-scrim"),
      ).toBe("");
      // 防抖窗口内尚未覆写存储
      expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe(
        beforeStored,
      );
    }

    await new Promise((r) => setTimeout(r, SLIDER_WRITE_DELAY_MS + 80));
    const saved = JSON.parse(
      window.localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}",
    );
    expect(saved.canvas).toEqual({
      kind: "wallpaper",
      source: "waterlily-pond",
      blur: 20,
      scrim: 40,
    });
  });

  test("flushAppearanceWrites 立即落盘（pagehide 时调用）", () => {
    setWallpaperSource("waterlily-pond");
    setWallpaperAdjustments({ blur: 12, scrim: 55 });
    const before = JSON.parse(
      window.localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}",
    );
    expect(before.canvas.blur).toBe(0);

    flushAppearanceWrites();
    const after = JSON.parse(
      window.localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}",
    );
    expect(after.canvas.blur).toBe(12);
    expect(after.canvas.scrim).toBe(55);
  });
});

describe("5) 壁纸图片数据存 IndexedDB，绝不进 localStorage", () => {
  test("上传后 localStorage 仅存 V2 source:\"custom\"，刷新后从 IndexedDB 读回", async () => {
    await saveUploadedWallpaper(DATA_URL);
    expect(getCustomWallpaperUrl()).toBe(DATA_URL);
    const savedJson = window.localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "";
    expect(savedJson).not.toContain("data:image/");
    expect(JSON.parse(savedJson).canvas.source).toBe("custom");
    expect(mem.box.value).toBe(DATA_URL);
    expect(mem.box.puts).toBe(1);

    await reloadAppearanceFromStorage();
    expect(getAppearanceConfig().canvas.kind).toBe("wallpaper");
    expect(getCustomWallpaperUrl()).toBe(DATA_URL);
    expect(resolveWallpaperCssFromConfig(getAppearanceConfig())).toContain(
      "data:image/webp",
    );
  });

  test("旧版本 localStorage 里的 Data URL 自动迁移进 IndexedDB 并清掉旧键", async () => {
    window.localStorage.setItem(WALLPAPER_ID_STORAGE_KEY, "custom");
    window.localStorage.setItem(WALLPAPER_CUSTOM_URL_STORAGE_KEY, DATA_URL);
    await reloadAppearanceFromStorage();
    expect(getCustomWallpaperUrl()).toBe(DATA_URL);
    expect(mem.box.value).toBe(DATA_URL);
    expect(window.localStorage.getItem(WALLPAPER_CUSTOM_URL_STORAGE_KEY)).toBeNull();
  });

  test("迁移写入 IndexedDB 失败时保留旧 Data URL 键，壁纸不丢", async () => {
    mem.box.fail = true;
    window.localStorage.setItem(WALLPAPER_ID_STORAGE_KEY, "custom");
    window.localStorage.setItem(WALLPAPER_CUSTOM_URL_STORAGE_KEY, DATA_URL);
    await reloadAppearanceFromStorage();
    expect(getCustomWallpaperUrl()).toBe(DATA_URL);
    expect(window.localStorage.getItem(WALLPAPER_CUSTOM_URL_STORAGE_KEY)).toBe(
      DATA_URL,
    );
  });

  test("移除壁纸会清掉 IndexedDB 图片并自动退回动态天空", async () => {
    await saveUploadedWallpaper(DATA_URL);
    removeCustomWallpaper();
    await tick();
    expect(mem.box.value).toBeNull();
    expect(getCustomWallpaperUrl()).toBe("");
    expect(getAppearanceConfig().canvas.kind).toBe("sky");
  });
});

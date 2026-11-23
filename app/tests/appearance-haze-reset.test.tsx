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
import { act, cleanup, render } from "@testing-library/react";
import { AppearancePreferences } from "@/components/settings/appearance-preferences";
import { ThemeProvider } from "@/components/theme-provider";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE_CONFIG,
  flushAppearanceWrites,
  getAppearanceConfig,
  HARK_ENGINE_STORAGE_KEYS,
  HARK_WEATHER_SNAPSHOT_STORAGE_KEY,
  isDefaultAppearance,
  reloadAppearanceFromStorage,
  resetAppearance,
  setSkyScene,
  setWallpaperAdjustments,
  setWallpaperSource,
  WALLPAPER_BLUR_MAX,
  WALLPAPER_BLUR_MIN,
  WALLPAPER_SCRIM_MAX,
  WALLPAPER_SCRIM_MIN,
} from "@/lib/appearance";
import { settleReactWork } from "./settle-react-work";

/**
 * V2 壁纸滑块范围契约与恢复默认清理守卫：
 *  1. 壁纸「背景模糊 (0–24px)」与「护眼薄幕 (0–100%)」UI 滑块范围与存储常量 1:1 严格对齐；
 *  2. `resetAppearance()` 彻底重置全部 V2 字段、清掉 `hark-wallpaper-v1` 引擎天气快照且不误删无关存储键；
 *  3. `wallpaper_core.html` 仅使用 `hark-wallpaper-v1` 作为其唯一 `SAVE_KEY`。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

beforeEach(async () => {
  window.localStorage.clear();
  resetAppearance();
  flushAppearanceWrites();
  window.localStorage.clear();
  await reloadAppearanceFromStorage();
});

describe("1) 壁纸模糊与护眼薄幕滑块范围与存储常量严格一致", () => {
  test("存储常量为 blur 0–24、scrim 0–100，并按边界裁剪", () => {
    expect([WALLPAPER_BLUR_MIN, WALLPAPER_BLUR_MAX]).toEqual([0, 24]);
    expect([WALLPAPER_SCRIM_MIN, WALLPAPER_SCRIM_MAX]).toEqual([0, 100]);

    setWallpaperSource("waterlily-pond");
    setWallpaperAdjustments({ blur: 99, scrim: 180 });
    let cfg = getAppearanceConfig();
    expect(cfg.canvas.kind).toBe("wallpaper");
    if (cfg.canvas.kind === "wallpaper") {
      expect(cfg.canvas.blur).toBe(24);
      expect(cfg.canvas.scrim).toBe(100);
    }

    setWallpaperAdjustments({ blur: -10, scrim: -5 });
    cfg = getAppearanceConfig();
    if (cfg.canvas.kind === "wallpaper") {
      expect(cfg.canvas.blur).toBe(0);
      expect(cfg.canvas.scrim).toBe(0);
    }
  });

  test("设置页仅渲染背景模糊与护眼薄幕 2 条滑块且准确回显已存值", async () => {
    window.localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_APPEARANCE_CONFIG,
        canvas: {
          kind: "wallpaper",
          source: "waterlily-pond",
          blur: 14,
          scrim: 62,
        },
      }),
    );
    await reloadAppearanceFromStorage();

    const view = render(
      <ThemeProvider>
        <AppearancePreferences />
      </ThemeProvider>,
    );

    const blurSlider = view.getByTestId(
      "wallpaper-blur-slider",
    ) as HTMLInputElement;
    const scrimSlider = view.getByTestId(
      "wallpaper-scrim-slider",
    ) as HTMLInputElement;

    expect(blurSlider.type).toBe("range");
    expect(blurSlider.min).toBe(String(WALLPAPER_BLUR_MIN));
    expect(blurSlider.max).toBe(String(WALLPAPER_BLUR_MAX));
    expect(blurSlider.value).toBe("14");
    expect(view.container.textContent).toContain("14 px");

    expect(scrimSlider.type).toBe("range");
    expect(scrimSlider.min).toBe(String(WALLPAPER_SCRIM_MIN));
    expect(scrimSlider.max).toBe(String(WALLPAPER_SCRIM_MAX));
    expect(scrimSlider.value).toBe("62");
    expect(view.container.textContent).toContain("62%");

    const setSlider = (el: HTMLInputElement, val: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      act(() => {
        el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        setter?.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      });
    };
    setSlider(blurSlider, "18");
    setSlider(scrimSlider, "48");
    const updated = getAppearanceConfig();
    if (updated.canvas.kind === "wallpaper") {
      expect(updated.canvas.blur).toBe(18);
      expect(updated.canvas.scrim).toBe(48);
    }
  });
});

describe("2) 恢复默认彻底清理天气快照与旧键", () => {
  test("hark-wallpaper-v1 属于天空引擎存储键清单", () => {
    expect(HARK_WEATHER_SNAPSHOT_STORAGE_KEY).toBe("hark-wallpaper-v1");
    expect(HARK_ENGINE_STORAGE_KEYS).toContain("hark-wallpaper-v1");
  });

  test("resetAppearance 清掉 hark-wallpaper-v1 与自定义设置，保留无关存储键", () => {
    setSkyScene("dusk");
    flushAppearanceWrites();
    window.localStorage.setItem(
      HARK_WEATHER_SNAPSHOT_STORAGE_KEY,
      JSON.stringify({
        place: { name: "Reykjavík", lat: 64.1, lon: -21.9 },
        weather: { code: 61 },
      }),
    );
    window.localStorage.setItem("unrelated-key", "keep");

    resetAppearance();
    flushAppearanceWrites();

    for (const key of HARK_ENGINE_STORAGE_KEYS) {
      expect(window.localStorage.getItem(key)).toBeNull();
    }
    expect(isDefaultAppearance(getAppearanceConfig())).toBe(true);
    expect(window.localStorage.getItem("unrelated-key")).toBe("keep");
  });

  test("localStorage.removeItem 抛异常时 resetAppearance 仍不崩溃", () => {
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = () => {
      throw new Error("SecurityError");
    };
    try {
      expect(() => resetAppearance()).not.toThrow();
    } finally {
      Storage.prototype.removeItem = original;
    }
  });
});

test("天空引擎仅使用 hark-wallpaper-v1 作为唯一 localStorage 键", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(
    new URL("../public/wallpaper_core.html", import.meta.url),
    "utf8",
  );
  expect(html).toMatch(/SAVE_KEY\s*=\s*['"]hark-wallpaper-v1['"]/);
  const keys = new Set(
    [
      ...html.matchAll(
        /localStorage\.(?:setItem|getItem|removeItem)\(\s*([^,)]+)/g,
      ),
    ].map((m) => (m[1] ?? "").trim()),
  );
  expect([...keys]).toEqual(["SAVE_KEY"]);
});

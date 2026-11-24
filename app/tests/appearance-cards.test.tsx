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
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { AppearancePreferences } from "@/components/settings/appearance-preferences";
import { ThemeProvider } from "@/components/theme-provider";
import {
  ARTISTIC_WALLPAPER_PRESETS,
  flushAppearanceWrites,
  getAppearanceConfig,
  getCustomWallpaperUrl,
  isDefaultAppearance,
  LEGACY_WALLPAPER_ID_MAP,
  MATERIALS,
  reloadAppearanceFromStorage,
  resetAppearance,
  SKY_SCENES,
  saveUploadedWallpaper,
  setWallpaperSource,
  THEMES,
  WALLPAPER_ID_STORAGE_KEY,
} from "@/lib/appearance";
import {
  indexedDbWallpaperBackend,
  setWallpaperBackend,
  type WallpaperBackend,
} from "@/lib/wallpaper-store";
import { settleReactWork } from "./settle-react-work";

/**
 * V2 全新四轴外观设置页真实 UI 渲染与交互断言：
 *  - 轴 1：外观模式三态分段（跟随系统 | 浅色 | 深色）；
 *  - 轴 2：6 套静态精选主题卡（3×2 深度预览卡片）+ 折叠自定义强调色；
 *  - 轴 3：互斥三选一背景画布（净色 | 动态天空（5 时刻 + 默认关天气）| 壁纸（15 幅艺术画作 + 仅模糊/薄幕 2 项滑块））；
 *  - 轴 4：3 档纯 CSS 材质（磨砂 | 通透 | 实色）+ 静止动态背景（省电）+ 减少透明度提示；
 *  - `isDefaultAppearance` 精确控制「恢复默认」按钮显隐。
 */

function createMemBackend(): WallpaperBackend {
  let saved: string | null = null;
  return {
    async get() {
      return saved;
    },
    async put(v: string) {
      saved = v;
    },
    async remove() {
      saved = null;
    },
  };
}

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  setWallpaperBackend(indexedDbWallpaperBackend);
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

beforeEach(async () => {
  setWallpaperBackend(createMemBackend());
  window.localStorage.clear();
  resetAppearance();
  flushAppearanceWrites();
  window.localStorage.clear();
  await reloadAppearanceFromStorage();
});

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  });
}

describe("四轴外观设置：模式、6 套主题、5 档天空与 3 档材质", () => {
  test("6 套色彩主题卡全部渲染，点选只改 theme 不改画布，支持折叠自定义强调色", () => {
    const view = render(
      <ThemeProvider>
        <AppearancePreferences />
      </ThemeProvider>,
    );

    expect(THEMES).toHaveLength(6);
    expect(view.queryByTestId("appearance-reset")).toBeNull();

    for (const theme of THEMES) {
      const card = view.getByTestId(`theme-card-${theme.id}`);
      expect(card.textContent).toContain(theme.name);
      expect(card.textContent).toContain(theme.tagline);
      const preview = card.querySelector<HTMLElement>(".ap-theme-preview");
      expect(preview?.style.background).toContain("gradient");
      const previewSurface = card.querySelector<HTMLElement>(
        ".ap-theme-preview-surface",
      );
      expect(previewSurface?.style.background).toBeTruthy();
      expect(
        card.querySelectorAll(".ap-theme-preview-line").length,
      ).toBeGreaterThanOrEqual(2);
      const swatch = card.querySelector<HTMLElement>(".ap-theme-swatch");
      expect(swatch?.style.background).toBeTruthy();
    }

    for (const id of ["claude", "cossui", "deepseek", "aurora", "porcelain"] as const) {
      fireEvent.click(view.getByTestId(`theme-card-${id}`));
      expect(getAppearanceConfig().theme).toBe(id);
      expect(getAppearanceConfig().canvas.kind).toBe("sky");
    }
    expect(isDefaultAppearance(getAppearanceConfig())).toBe(false);
    expect(view.getByTestId("appearance-reset")).toBeTruthy();

    // 折叠自定义强调色面板
    expect(view.queryByTestId("custom-accent-panel")).toBeNull();
    fireEvent.click(view.getByTestId("custom-accent-toggle"));
    const picker = view.getByTestId("custom-accent-picker") as HTMLInputElement;
    setInputValue(picker, "#e11d48");
    expect(getAppearanceConfig().customAccent).toBe("#e11d48");
    expect(view.getByTestId("custom-accent-reset")).toBeTruthy();

    fireEvent.click(view.getByTestId("custom-accent-reset"));
    expect(getAppearanceConfig().customAccent).toBeNull();
  });

  test("动态天空渲染 5 张互不相同的时刻卡，实时天气默认关闭且标注零外网请求", () => {
    const view = render(
      <ThemeProvider>
        <AppearancePreferences />
      </ThemeProvider>,
    );

    expect(SKY_SCENES).toHaveLength(5);
    const gradients = new Set<string>();
    for (const scene of SKY_SCENES) {
      const card = view.getByTestId(`sky-scene-${scene.id}`);
      expect(card.textContent).toContain(scene.name);
      const thumb = card.querySelector<HTMLElement>(
        ".appearance-wallpaper-thumb",
      );
      expect(thumb).toBeTruthy();
      const bg = thumb?.style.background ?? "";
      expect(bg).toContain("gradient");
      expect(gradients.has(bg)).toBe(false);
      gradients.add(bg);
    }

    // 实时天气默认关闭，提示零外网请求，城市输入未展开
    const weatherSwitch = view.getByTestId("sky-weather-switch");
    expect(weatherSwitch.getAttribute("aria-checked")).toBe("false");
    expect(view.getByTestId("sky-weather-panel").textContent).toContain(
      "零外网请求",
    );
    expect(view.queryByTestId("sky-weather-city-input")).toBeNull();

    // 开启实时天气后展示城市输入框，可保存与清空
    fireEvent.click(weatherSwitch);
    const cityInput = view.getByTestId(
      "sky-weather-city-input",
    ) as HTMLInputElement;
    setInputValue(cityInput, "上海");
    fireEvent.click(view.getByTestId("sky-weather-city-save"));
    const cfg = getAppearanceConfig();
    expect(cfg.canvas.kind).toBe("sky");
    if (cfg.canvas.kind === "sky") {
      expect(cfg.canvas.weather).toEqual({ enabled: true, city: "上海" });
    }
    fireEvent.click(view.getByTestId("sky-weather-city-clear"));
    const cleared = getAppearanceConfig();
    if (cleared.canvas.kind === "sky") {
      expect(cleared.canvas.weather.city).toBeNull();
    }
  });

  test("3 档材质卡全部渲染且净色画布互斥切换正常", () => {
    const view = render(
      <ThemeProvider>
        <AppearancePreferences />
      </ThemeProvider>,
    );

    expect(MATERIALS).toHaveLength(3);
    for (const mat of MATERIALS) {
      expect(view.getByTestId(`material-card-${mat.id}`)).toBeTruthy();
    }
    fireEvent.click(view.getByTestId("material-card-clear"));
    expect(getAppearanceConfig().material).toBe("clear");

    fireEvent.click(view.getByTestId("canvas-kind-pure"));
    expect(getAppearanceConfig().canvas).toEqual({ kind: "pure" });
    expect(view.getByTestId("canvas-pure-hint")).toBeTruthy();
    expect(view.queryByTestId("canvas-sky-panel")).toBeNull();
    expect(view.queryByTestId("canvas-wallpaper-panel")).toBeNull();
  });
});

describe("艺术壁纸图库、分类筛选与仅 2 项微调滑块", () => {
  test("切到壁纸画布后展示 15 幅艺术画作，支持 4 分类筛选且仅提供背景模糊与护眼薄幕 2 条滑块", () => {
    const view = render(
      <ThemeProvider>
        <AppearancePreferences />
      </ThemeProvider>,
    );

    fireEvent.click(view.getByTestId("canvas-kind-wallpaper"));
    expect(view.getByTestId("canvas-wallpaper-panel")).toBeTruthy();

    const fallbackGradients = new Set<string>();
    for (const art of ARTISTIC_WALLPAPER_PRESETS) {
      const card = view.getByTestId(`wallpaper-preset-${art.id}`);
      expect(card.textContent).toContain(art.name);
      expect(card.textContent).toContain(art.tag);
      const thumb = card.querySelector<HTMLElement>(".appearance-art-thumb");
      const img = card.querySelector<HTMLElement>(".appearance-art-img");
      expect(thumb).toBeTruthy();
      expect(img).toBeTruthy();
      expect(img?.style.backgroundImage).toContain(art.thumbUrl);
      const bg = thumb?.style.background ?? "";
      expect(fallbackGradients.has(bg)).toBe(false);
      fallbackGradients.add(bg);
    }

    fireEvent.click(view.getByTestId("wallpaper-cat-eastern"));
    expect(view.queryByTestId("wallpaper-preset-qinglv-shanhe")).toBeTruthy();
    expect(view.queryByTestId("wallpaper-preset-fuji-sakura")).toBeTruthy();
    expect(view.queryByTestId("wallpaper-preset-ink-bamboo-mist")).toBeTruthy();
    expect(view.queryByTestId("wallpaper-preset-waterlily-pond")).toBeNull();
    expect(view.queryByTestId("wallpaper-preset-arch-sunbeam")).toBeNull();

    fireEvent.click(view.getByTestId("wallpaper-cat-modern"));
    expect(view.queryByTestId("wallpaper-preset-arch-sunbeam")).toBeTruthy();
    expect(view.queryByTestId("wallpaper-preset-mineral-agate")).toBeTruthy();
    expect(view.queryByTestId("wallpaper-preset-nordic-fjord")).toBeTruthy();
    expect(view.queryByTestId("wallpaper-preset-qinglv-shanhe")).toBeNull();

    fireEvent.click(view.getByTestId("wallpaper-cat-all"));
    const lilyCard = view.getByTestId("wallpaper-preset-waterlily-pond");
    fireEvent.click(lilyCard);
    const cfg = getAppearanceConfig();
    expect(cfg.canvas.kind).toBe("wallpaper");
    if (cfg.canvas.kind === "wallpaper") {
      expect(cfg.canvas.source).toBe("waterlily-pond");
    }
    expect(lilyCard.getAttribute("aria-pressed")).toBe("true");

    // 仅 2 条滑块：背景模糊与护眼薄幕
    const ranges = view.container.querySelectorAll('input[type="range"]');
    expect(ranges.length).toBe(2);
    expect(view.getByTestId("wallpaper-blur-slider")).toBeTruthy();
    expect(view.getByTestId("wallpaper-scrim-slider")).toBeTruthy();
  });

  test("在艺术壁纸、动态天空与已上传自定义图片间切换不丢图，且旧壁纸预设 ID 无损迁移", async () => {
    await act(async () => {
      await saveUploadedWallpaper("data:image/webp;base64,UklGRg==");
    });
    const view = render(
      <ThemeProvider>
        <AppearancePreferences />
      </ThemeProvider>,
    );
    const initial = getAppearanceConfig();
    expect(initial.canvas.kind).toBe("wallpaper");
    if (initial.canvas.kind === "wallpaper") {
      expect(initial.canvas.source).toBe("custom");
    }

    fireEvent.click(view.getByTestId("wallpaper-preset-starry-rhone"));
    const afterPreset = getAppearanceConfig();
    expect(afterPreset.canvas.kind).toBe("wallpaper");
    if (afterPreset.canvas.kind === "wallpaper") {
      expect(afterPreset.canvas.source).toBe("starry-rhone");
    }
    expect(getCustomWallpaperUrl()).toBe("data:image/webp;base64,UklGRg==");

    fireEvent.click(view.getByTestId("wallpaper-custom-activate"));
    const reactivated = getAppearanceConfig();
    if (reactivated.canvas.kind === "wallpaper") {
      expect(reactivated.canvas.source).toBe("custom");
    }

    // 切到预设壁纸再验证旧 SVG 预设迁移
    act(() => {
      setWallpaperSource("waterlily-pond");
    });
    for (const [legacyId, mappedId] of Object.entries(
      LEGACY_WALLPAPER_ID_MAP,
    )) {
      window.localStorage.clear();
      window.localStorage.setItem(WALLPAPER_ID_STORAGE_KEY, legacyId);
      await act(async () => {
        await reloadAppearanceFromStorage();
      });
      const migrated = getAppearanceConfig();
      expect(migrated.canvas.kind).toBe("wallpaper");
      if (migrated.canvas.kind === "wallpaper") {
        expect(migrated.canvas.source).toBe(mappedId);
      }
    }
  });
});

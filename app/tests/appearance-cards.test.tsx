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
  getAppearanceState,
  HARK_SKY_SCENES,
  LEGACY_WALLPAPER_ID_MAP,
  reloadAppearanceFromStorage,
  resetAppearanceDefaults,
  setCustomWallpaperUrl,
  THEME_FAMILIES,
  WALLPAPER_ID_STORAGE_KEY,
} from "@/lib/appearance";
import { settleReactWork } from "./settle-react-work";

/**
 * 8 款主题族 + 8 款天象卡片的真实渲染：族卡是左右分半的浅 / 深预览，点半边写对应族槽；
 * 天象卡的预览渐变互不相同（去同质回归）。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  resetAppearanceDefaults();
  flushAppearanceWrites();
  window.localStorage.clear();
});

describe("主题族与动态天象选择卡", () => {
  test("8 款主题族卡全部渲染：每张卡左右两个半边（浅色 / 深色 seed 预览）", () => {
    const view = render(
      <ThemeProvider>
        <AppearancePreferences />
      </ThemeProvider>,
    );
    for (const f of THEME_FAMILIES) {
      for (const mode of ["light", "dark"] as const) {
        const half = view.getByTestId(`fam-half-${f.id}-${mode}`);
        // 半边底色 = 该模式 seed.bg（happy-dom 可能归一化成 rgb()，只核对写进去了值）
        expect(half.style.background).toBeTruthy();
      }
      // 族名在卡片 meta 里
      const card = view
        .getByTestId(`fam-half-${f.id}-light`)
        .closest(".appearance-fam-card");
      expect(card?.querySelector(".appearance-fam-meta b")?.textContent).toBe(
        f.name,
      );
    }
    expect(THEME_FAMILIES.map((f) => f.id)).toContain("amber");
    expect(THEME_FAMILIES.map((f) => f.id)).toContain("london");
    expect(THEME_FAMILIES.map((f) => f.id)).toContain("mono");
  });

  test("点半边只写对应族槽（浅 / 深混搭），自定义卡打开编辑器", () => {
    const view = render(
      <ThemeProvider>
        <AppearancePreferences />
      </ThemeProvider>,
    );
    // 浅色 = 落樱、深色 = 琥珀（混搭）
    fireEvent.click(view.getByTestId("fam-half-sakura-light"));
    expect(getAppearanceState().familyLight).toBe("sakura");
    expect(getAppearanceState().familyDark).toBe("azure");
    fireEvent.click(view.getByTestId("fam-half-amber-dark"));
    expect(getAppearanceState().familyDark).toBe("amber");
    expect(getAppearanceState().familyLight).toBe("sakura");
    // 第 9 张虚线卡 → 自定义编辑器
    fireEvent.click(view.getByTestId("fam-custom"));
    expect(view.getByTestId("fam-editor")).toBeTruthy();
    expect(view.getByTestId("fam-ed-light")).toBeTruthy();
    expect(view.getByTestId("fam-ed-dark")).toBeTruthy();
  });

  test("8 张天象卡全部渲染，且每张预览渐变互不相同（去同质）", () => {
    const view = render(
      <ThemeProvider>
        <AppearancePreferences />
      </ThemeProvider>,
    );
    expect(HARK_SKY_SCENES.length).toBe(8);
    const gradients = new Set<string>();
    for (const scene of HARK_SKY_SCENES) {
      const card = view.getByTestId(`hark-scene-${scene.id}`);
      expect(card.textContent).toContain(scene.name);
      const thumb = card.querySelector<HTMLElement>(
        ".appearance-wallpaper-thumb",
      );
      expect(thumb).toBeTruthy();
      const bg = thumb!.style.background;
      expect(bg).toContain("gradient");
      expect(gradients.has(bg)).toBe(false);
      gradients.add(bg);
    }
  });

  test("新增的两张场景卡（晨霞·檀香山、风暴·迈阿密）有名字和预览", () => {
    const view = render(
      <ThemeProvider>
        <AppearancePreferences />
      </ThemeProvider>,
    );
    const dawn = view.getByTestId("hark-scene-11");
    expect(dawn.textContent).toContain("晨霞初晓");
    expect(dawn.textContent).toContain("Honolulu");
    const storm = view.getByTestId("hark-scene-10");
    expect(storm.textContent).toContain("风暴雷云");
    expect(storm.textContent).toContain("Miami");
  });
});

describe("艺术壁纸图库与分类切换", () => {
  test("默认展示全部 9 幅艺术画作，支持按三大系列筛选并点击应用", () => {
    const view = render(
      <ThemeProvider>
        <AppearancePreferences />
      </ThemeProvider>,
    );
    const fallbackGradients = new Set<string>();
    for (const art of ARTISTIC_WALLPAPER_PRESETS) {
      const card = view.getByTestId(`wallpaper-preset-${art.id}`);
      expect(card.textContent).toContain(art.name);
      expect(card.textContent).toContain(art.tag);
      const thumb = card.querySelector<HTMLElement>(".appearance-art-thumb");
      const img = card.querySelector<HTMLElement>(".appearance-art-img");
      expect(thumb).toBeTruthy();
      expect(img).toBeTruthy();
      expect(img!.style.backgroundImage).toContain(art.thumbUrl);
      expect(fallbackGradients.has(thumb!.style.background)).toBe(false);
      fallbackGradients.add(thumb!.style.background);
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
    expect(getAppearanceState().wallpaperId).toBe("waterlily-pond");
    expect(lilyCard.getAttribute("aria-checked")).toBe("true");
    expect(view.getByLabelText("壁纸景深模糊度")).toBeTruthy();
    expect(view.getByLabelText("壁纸氛围压暗度")).toBeTruthy();
  });

  test("在艺术壁纸、动态天空与已上传自定义图片之间自由切换不丢图，且兼容旧预设 ID", () => {
    act(() => {
      setCustomWallpaperUrl("https://example.com/my-painting.webp");
    });
    const view = render(
      <ThemeProvider>
        <AppearancePreferences />
      </ThemeProvider>,
    );
    expect(getAppearanceState().wallpaperId).toBe("custom");

    fireEvent.click(view.getByTestId("wallpaper-preset-starry-rhone"));
    expect(getAppearanceState().wallpaperId).toBe("starry-rhone");
    expect(getAppearanceState().customWallpaperUrl).toBe(
      "https://example.com/my-painting.webp",
    );

    const reactivateBtn = view.getByTestId("wallpaper-custom-activate");
    fireEvent.click(reactivateBtn);
    expect(getAppearanceState().wallpaperId).toBe("custom");

    for (const [legacyId, mappedId] of Object.entries(
      LEGACY_WALLPAPER_ID_MAP,
    )) {
      window.localStorage.setItem(WALLPAPER_ID_STORAGE_KEY, legacyId);
      act(() => {
        void reloadAppearanceFromStorage();
      });
      expect(getAppearanceState().wallpaperId).toBe(mappedId);
    }
  });
});

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
import {
  ARTISTIC_WALLPAPER_PRESETS,
  flushAppearanceWrites,
  getAppearanceState,
  HARK_SKY_SCENES,
  LEGACY_WALLPAPER_ID_MAP,
  reloadAppearanceFromStorage,
  resetAppearanceDefaults,
  setCustomWallpaperUrl,
  THEME_PALETTES,
  WALLPAPER_ID_STORAGE_KEY,
} from "@/lib/appearance";
import { settleReactWork } from "./settle-react-work";

/**
 * 8 款配色 + 8 款天象卡片的真实渲染（同质化回归）：以前 auto / live / 晴空三张卡用几乎
 * 相同的蓝色渐变，截图里分不出谁是谁。现在每张卡的预览渐变都必须互不相同。
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

describe("主题配色与动态天象选择卡", () => {
  test("8 款配色卡全部渲染，含新增的银杏暖金与朱砂绛红", () => {
    const view = render(<AppearancePreferences />);
    for (const p of THEME_PALETTES) {
      const card = view.getByTestId(`palette-option-${p.id}`);
      expect(card.textContent).toContain(p.name);
      const swatch = card.querySelector(".appearance-palette-swatch");
      expect(swatch).toBeTruthy();
    }
    expect(THEME_PALETTES.map((p) => p.id)).toContain("gold");
    expect(THEME_PALETTES.map((p) => p.id)).toContain("ruby");
  });

  test("8 张天象卡全部渲染，且每张预览渐变互不相同（去同质）", () => {
    const view = render(<AppearancePreferences />);
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
    const view = render(<AppearancePreferences />);
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
    const view = render(<AppearancePreferences />);
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
    const view = render(<AppearancePreferences />);
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

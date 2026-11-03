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
import { cleanup, render } from "@testing-library/react";
import { AppearancePreferences } from "@/components/settings/appearance-preferences";
import {
  flushAppearanceWrites,
  HARK_SKY_SCENES,
  resetAppearanceDefaults,
  THEME_PALETTES,
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

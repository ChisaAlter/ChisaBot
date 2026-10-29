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
  GLASS_OPACITY_MAX,
  GLASS_OPACITY_MIN,
  GLASS_OPACITY_STORAGE_KEY,
  getAppearanceState,
  HARK_ENGINE_STORAGE_KEYS,
  HARK_SCENE_STORAGE_KEY,
  HARK_WEATHER_SNAPSHOT_STORAGE_KEY,
  reloadAppearanceFromStorage,
  resetAppearanceDefaults,
  setGlassOpacity,
  setHarkSkyScene,
} from "@/lib/appearance";
import { settleReactWork } from "./settle-react-work";

/**
 * 模块 11 第 10、13 条。
 *
 * 10：「面板雾度」滑块以前是 min 5 / max 45，存储层却允许 5–55——存过 46–55 的人一打开设置页，
 *     滑块就被浏览器夹到 45，拖一下就把自己存的值改掉了。现在滑块和存储共用 GLASS_OPACITY_MIN / MAX。
 * 13：「恢复默认」以前只重置 AppearanceState，天空引擎自己存的地点 / 天气快照（hark-wallpaper-v1）留着，
 *     下次加载还是之前搜过的城市。
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

describe("10) haze slider range matches storage", () => {
  test("the range constants are the stored 5–55", () => {
    expect([GLASS_OPACITY_MIN, GLASS_OPACITY_MAX]).toEqual([5, 55]);
    setGlassOpacity(55);
    expect(getAppearanceState().glassOpacity).toBe(55);
    setGlassOpacity(80);
    expect(getAppearanceState().glassOpacity).toBe(55);
    setGlassOpacity(1);
    expect(getAppearanceState().glassOpacity).toBe(5);
  });

  test("the settings slider is 5–55 and shows a stored 50 as 50", async () => {
    window.localStorage.setItem(GLASS_OPACITY_STORAGE_KEY, "50");
    reloadAppearanceFromStorage();
    expect(getAppearanceState().glassOpacity).toBe(50);

    const view = render(<AppearancePreferences />);
    const slider = view.getByLabelText("玻璃面板不透明度") as HTMLInputElement;
    expect(slider.type).toBe("range");
    expect(slider.min).toBe(String(GLASS_OPACITY_MIN));
    expect(slider.max).toBe(String(GLASS_OPACITY_MAX));
    expect(slider.value).toBe("50");
    expect(view.container.textContent).toContain("50%（透光率 50%）");
  });
});

describe("13) reset clears the sky engine's keys", () => {
  test("hark-wallpaper-v1 is one of the engine keys", () => {
    expect(HARK_WEATHER_SNAPSHOT_STORAGE_KEY).toBe("hark-wallpaper-v1");
    expect(HARK_ENGINE_STORAGE_KEYS).toContain("hark-wallpaper-v1");
  });

  test("resetAppearanceDefaults removes the weather / place snapshot and the scene", () => {
    setHarkSkyScene("2");
    flushAppearanceWrites();
    window.localStorage.setItem(
      HARK_WEATHER_SNAPSHOT_STORAGE_KEY,
      JSON.stringify({
        place: { name: "Reykjavík", lat: 64.1, lon: -21.9 },
        weather: { code: 61 },
      }),
    );
    window.localStorage.setItem("unrelated-key", "keep");

    resetAppearanceDefaults();
    flushAppearanceWrites();

    for (const key of HARK_ENGINE_STORAGE_KEYS) {
      expect(window.localStorage.getItem(key)).toBeNull();
    }
    expect(getAppearanceState().harkScene).toBe("auto");
    const scene = window.localStorage.getItem(HARK_SCENE_STORAGE_KEY);
    expect(scene === null || scene === "auto").toBe(true);
    expect(window.localStorage.getItem("unrelated-key")).toBe("keep");
  });

  test("reset still works when localStorage throws", () => {
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = () => {
      throw new Error("SecurityError");
    };
    try {
      expect(() => resetAppearanceDefaults()).not.toThrow();
    } finally {
      Storage.prototype.removeItem = original;
    }
  });
});

test("the sky engine still uses hark-wallpaper-v1 as its only localStorage key", async () => {
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
    ].map((m) => m[1].trim()),
  );
  expect([...keys]).toEqual(["SAVE_KEY"]);
});

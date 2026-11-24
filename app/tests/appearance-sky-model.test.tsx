import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { resolveSkyTarget } from "../src/components/sky-background";
import {
  flushAppearanceWrites,
  getAppearanceConfig,
  reloadAppearanceFromStorage,
  resetAppearance,
  resolveAutoSkyHour,
  SKY_SCENE_TO_HARK_INDEX,
  setCanvas,
  setMaterial,
  setSkyScene,
  setSkyWeather,
  setTheme,
  setWallpaperSource,
  shouldFetchLiveWeather,
} from "../src/lib/appearance";
import { settleReactWork } from "./settle-react-work";

/**
 * V2 四轴正交背景画布与天空天气引擎契约：
 *  - 背景三选一严格互斥（pure / sky / wallpaper），切主题或材质绝不改变画布类型；
 *  - 4 个固定天空时刻（dawn=11 / day=0 / dusk=6 / night=4）严格还原用户所选，绝不做静默昼夜调包；
 *  - 默认 `sky / auto` 关闭实时天气（0 Open-Meteo 网络请求），仅按本机时间沿柔和弧线演化；
 *  - 开启实时天气才允许拉取 Open-Meteo，切到固定时刻或其他画布立即关闭天气请求。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
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

describe("四轴正交与背景画布互斥三选一", () => {
  test("旧存档迁移：sky-source=theme → pure；hark-scene=live → sky/auto + 开启天气", async () => {
    window.localStorage.setItem("chisabot-sky-source", "theme");
    await reloadAppearanceFromStorage();
    expect(getAppearanceConfig().canvas).toEqual({ kind: "pure" });

    window.localStorage.clear();
    window.localStorage.setItem("chisabot-sky-source", "hark");
    window.localStorage.setItem("chisabot-hark-scene", "live");
    await reloadAppearanceFromStorage();
    expect(getAppearanceConfig().canvas).toEqual({
      kind: "sky",
      scene: "auto",
      weather: { enabled: true, city: null },
    });
    expect(shouldFetchLiveWeather(getAppearanceConfig())).toBe(true);
  });

  test("切换色彩主题或界面材质不会劫持或改变当前背景画布", () => {
    setCanvas({ kind: "pure" });
    setTheme("claude");
    setMaterial("clear");
    expect(getAppearanceConfig().canvas).toEqual({ kind: "pure" });

    setWallpaperSource("waterlily-pond");
    setTheme("porcelain");
    setMaterial("solid");
    const afterWallpaper = getAppearanceConfig();
    expect(afterWallpaper.canvas.kind).toBe("wallpaper");
    if (afterWallpaper.canvas.kind === "wallpaper") {
      expect(afterWallpaper.canvas.source).toBe("waterlily-pond");
    }

    setSkyScene("dusk");
    setTheme("aurora");
    expect(getAppearanceConfig().canvas).toEqual({
      kind: "sky",
      scene: "dusk",
      weather: { enabled: false, city: null },
    });
  });

  test("切换壁纸 / 天空 / 净色严格互斥，恢复默认回到动态天空 auto 且关闭天气", () => {
    setWallpaperSource("fuji-sakura");
    expect(getAppearanceConfig().canvas.kind).toBe("wallpaper");

    setSkyScene("dawn");
    expect(getAppearanceConfig().canvas).toEqual({
      kind: "sky",
      scene: "dawn",
      weather: { enabled: false, city: null },
    });

    setCanvas({ kind: "pure" });
    expect(getAppearanceConfig().canvas).toEqual({ kind: "pure" });

    resetAppearance();
    expect(getAppearanceConfig().canvas).toEqual({
      kind: "sky",
      scene: "auto",
      weather: { enabled: false, city: null },
    });
    expect(shouldFetchLiveWeather(getAppearanceConfig())).toBe(false);
  });
});

describe("4 固定时刻精确映射（零静默昼夜调包）与实时天气守门", () => {
  test("dawn / day / dusk / night 在浅色与深色下都精确映射到 11 / 0 / 6 / 4", () => {
    for (const [scene, harkIndex] of Object.entries(SKY_SCENE_TO_HARK_INDEX) as [
      "dawn" | "day" | "dusk" | "night",
      number,
    ][]) {
      setSkyScene(scene);
      const cfg = getAppearanceConfig();
      expect(resolveSkyTarget(cfg, false)).toEqual({
        kind: "fixed",
        scene,
        harkIndex,
      });
      expect(resolveSkyTarget(cfg, true)).toEqual({
        kind: "fixed",
        scene,
        harkIndex,
      });
      expect(shouldFetchLiveWeather(cfg)).toBe(false);
    }
  });

  test("auto 关闭天气时按本机时间沿浅色昼弧线 / 深色夜弧线演化，严格 0 天气请求", () => {
    setSkyScene("auto");
    const cfg = getAppearanceConfig();
    expect(shouldFetchLiveWeather(cfg)).toBe(false);

    // 浅色：任何本机时刻都保持在明亮昼/晨昏区间 [6, 18.5]
    for (const h of [0, 3, 9, 14, 21, 23.5]) {
      const resolved = resolveAutoSkyHour(h, false);
      expect(resolved).toBeGreaterThanOrEqual(6);
      expect(resolved).toBeLessThanOrEqual(18.5);
    }

    // 深色：任何本机时刻都保持在暮/星夜区间 [18.5..24) ∪ [0..6)
    for (const h of [0, 3, 9, 14, 19, 23]) {
      const resolved = resolveAutoSkyHour(h, true);
      expect(resolved >= 18.5 || resolved < 6).toBe(true);
    }

    const noon = new Date(2026, 5, 1, 12, 0, 0);
    expect(resolveSkyTarget(cfg, false, noon)).toEqual({
      kind: "auto-time",
      hour: 12,
    });
    const darkNoon = resolveSkyTarget(cfg, true, noon);
    expect(darkNoon.kind).toBe("auto-time");
  });

  test("开启实时天气仅在 sky/auto 生效，支持保存城市；切固定时刻或非天空画布自动停用天气请求", () => {
    setSkyWeather({ enabled: true, city: "杭州" });
    let cfg = getAppearanceConfig();
    expect(shouldFetchLiveWeather(cfg)).toBe(true);
    expect(resolveSkyTarget(cfg, false)).toEqual({
      kind: "weather",
      city: "杭州",
    });

    // 切固定时刻自动停用天气
    setSkyScene("night");
    cfg = getAppearanceConfig();
    expect(shouldFetchLiveWeather(cfg)).toBe(false);
    expect(resolveSkyTarget(cfg, false)).toEqual({
      kind: "fixed",
      scene: "night",
      harkIndex: 4,
    });

    // 非天空画布返回 off
    setCanvas({ kind: "pure" });
    expect(resolveSkyTarget(getAppearanceConfig(), false)).toEqual({
      kind: "off",
    });
    setWallpaperSource("snow-river");
    expect(resolveSkyTarget(getAppearanceConfig(), false)).toEqual({
      kind: "off",
    });
  });
});

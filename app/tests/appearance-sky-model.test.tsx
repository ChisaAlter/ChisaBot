import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  flushAppearanceWrites,
  getAppearanceState,
  HARK_SCENE_INFO,
  PALETTE_STORAGE_KEY,
  reloadAppearanceFromStorage,
  resetAppearanceDefaults,
  resolveEffectiveHarkScene,
  resolveSkyReadability,
  setHarkSkyScene,
  setSkySource,
  setThemeHalf,
  setWallpaperPreset,
  SKY_SOURCE_STORAGE_KEY,
  usesThemeGradientSky,
} from "../src/lib/appearance";
import { settleReactWork } from "./settle-react-work";

/**
 * CB-134 → CB-137 外观模型（模式 × 主题族 × 背景）的契约测试：
 * - 主题族与天空解耦，背景三选一互斥；点族卡的半边只写对应族槽、不碰天空；
 * - 昼 / 夜场景按外观明暗自动配对（任何存储路径都造不出错配天空）；
 * - --sky-lift / --sky-muted 由有效天空明暗真实驱动。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  resetAppearanceDefaults();
  flushAppearanceWrites();
  window.localStorage.clear();
});

describe("天空来源（skySource）", () => {
  test("老存档迁移：皮肤非 default 且没有来源键 → 主题渐变；default → Hark 引擎", () => {
    window.localStorage.setItem(PALETTE_STORAGE_KEY, "aurora");
    window.localStorage.removeItem(SKY_SOURCE_STORAGE_KEY);
    void reloadAppearanceFromStorage();
    expect(getAppearanceState().skySource).toBe("theme");
    expect(usesThemeGradientSky(getAppearanceState())).toBe(true);

    window.localStorage.setItem(PALETTE_STORAGE_KEY, "default");
    window.localStorage.removeItem(SKY_SOURCE_STORAGE_KEY);
    void reloadAppearanceFromStorage();
    expect(getAppearanceState().skySource).toBe("hark");
    expect(usesThemeGradientSky(getAppearanceState())).toBe(false);
  });

  test("已存来源键时按存的读，不再按皮肤推", () => {
    window.localStorage.setItem(PALETTE_STORAGE_KEY, "aurora");
    window.localStorage.setItem(SKY_SOURCE_STORAGE_KEY, "hark");
    void reloadAppearanceFromStorage();
    expect(getAppearanceState().skySource).toBe("hark");
  });

  test("点族卡半边：只写对应族槽，天空来源与壁纸都不动", () => {
    setHarkSkyScene("0");
    expect(getAppearanceState().skySource).toBe("hark");
    setThemeHalf("light", "sakura");
    expect(getAppearanceState().familyLight).toBe("sakura");
    expect(getAppearanceState().familyDark).toBe("azure");
    // 选族不再劫持天空：hark 引擎照常跑，主题渐变只是备选
    expect(getAppearanceState().skySource).toBe("hark");

    setWallpaperPreset("waterlily-pond");
    setThemeHalf("dark", "celadon");
    expect(getAppearanceState().familyDark).toBe("celadon");
    expect(getAppearanceState().wallpaperId).toBe("waterlily-pond");
    expect(getAppearanceState().skySource).toBe("hark");
  });

  test("点天象卡：切到 Hark 引擎并退出壁纸", () => {
    setWallpaperPreset("fuji-sakura");
    setHarkSkyScene("6");
    expect(getAppearanceState().skySource).toBe("hark");
    expect(getAppearanceState().wallpaperId).toBe("none");
  });

  test("主题天空卡：切回主题渐变并退出壁纸", () => {
    setWallpaperPreset("red-maple");
    setSkySource("theme");
    expect(getAppearanceState().skySource).toBe("theme");
    expect(getAppearanceState().wallpaperId).toBe("none");
  });

  test("恢复默认 → Hark 引擎 + auto", () => {
    setSkySource("theme");
    resetAppearanceDefaults();
    expect(getAppearanceState().skySource).toBe("hark");
    expect(getAppearanceState().harkScene).toBe("auto");
  });
});

describe("昼夜场景配对", () => {
  test("浅色外观下夜景自动落到黄昏 / 雨景配对", () => {
    setHarkSkyScene("4"); // 柏林夜
    expect(resolveEffectiveHarkScene(getAppearanceState(), false)).toBe(11);
    expect(resolveEffectiveHarkScene(getAppearanceState(), true)).toBe(4);

    setHarkSkyScene("2"); // 雷克雅未克午夜
    expect(resolveEffectiveHarkScene(getAppearanceState(), false)).toBe(1);

    setHarkSkyScene("10"); // 迈阿密风暴
    expect(resolveEffectiveHarkScene(getAppearanceState(), false)).toBe(3);
  });

  test("深色外观下日景自动落到夜景配对", () => {
    setHarkSkyScene("0"); // Palo Alto 正午
    expect(resolveEffectiveHarkScene(getAppearanceState(), true)).toBe(4);
    expect(resolveEffectiveHarkScene(getAppearanceState(), false)).toBe(0);

    setHarkSkyScene("5"); // 太浩湖雪霁
    expect(resolveEffectiveHarkScene(getAppearanceState(), true)).toBe(2);
  });

  test("晨昏场景两种外观都直接呈现，live 不配对", () => {
    for (const scene of ["1", "6", "8", "11"] as const) {
      setHarkSkyScene(scene);
      expect(resolveEffectiveHarkScene(getAppearanceState(), false)).toBe(
        Number(scene),
      );
      expect(resolveEffectiveHarkScene(getAppearanceState(), true)).toBe(
        Number(scene),
      );
    }
    setHarkSkyScene("live");
    expect(resolveEffectiveHarkScene(getAppearanceState(), false)).toBe("live");
    expect(resolveEffectiveHarkScene(getAppearanceState(), true)).toBe("live");
  });

  test("配对目标本身不触发二次配对（配对图无环）", () => {
    for (const [i, info] of HARK_SCENE_INFO.entries()) {
      if (info.lightPair !== null) {
        expect(HARK_SCENE_INFO[info.lightPair].daylight).not.toBe("night");
      }
      if (info.darkPair !== null) {
        expect(HARK_SCENE_INFO[info.darkPair].daylight).not.toBe("day");
      }
      expect(info.lightPair).not.toBe(i);
      expect(info.darkPair).not.toBe(i);
    }
  });
});

describe("主题族不绑定外观模式", () => {
  test("选族不切外观模式（CB-134 的明暗绑定皮肤已被双槽独立族取代）", () => {
    // 任何族两个模式的 seed 都成立，选谁都不会强制翻转 dark——
    // 「mono 深色半边的黑夜观感」用「深色槽选 mono」表达，不再靠 boundMode。
    const darkBefore = document.documentElement.classList.contains("dark");
    setThemeHalf("light", "mono");
    setThemeHalf("dark", "mono");
    expect(document.documentElement.classList.contains("dark")).toBe(
      darkBefore,
    );
    expect(getAppearanceState().familyLight).toBe("mono");
    expect(getAppearanceState().familyDark).toBe("mono");
  });

  test("auto 场景跟随当前族 seed：seed.scene 经昼夜配对后呈现", () => {
    setHarkSkyScene("auto");
    // azure 浅色 seed.scene = 0（昼景）→ 浅外观直接呈现
    expect(resolveEffectiveHarkScene(getAppearanceState(), false)).toBe(0);
    // azure 深色 seed.scene = 4（夜景）→ 深外观直接呈现
    expect(resolveEffectiveHarkScene(getAppearanceState(), true)).toBe(4);
    setThemeHalf("dark", "celadon");
    // celadon 深色 seed.scene = 5（太浩湖雪霁）→ 日景在深外观下配对到 2（雷克雅未克夜）
    expect(resolveEffectiveHarkScene(getAppearanceState(), true)).toBe(2);
    setThemeHalf("light", "violet");
    // violet 浅色 seed.scene = 2 → 夜景在浅外观下配对到 1（纽约日落）
    expect(resolveEffectiveHarkScene(getAppearanceState(), false)).toBe(1);
  });
});

describe("浅色可读性旋钮（--sky-lift / --sky-muted）", () => {
  test("深色 / 壁纸 / 主题渐变下不需要旋钮（返回 null）", () => {
    setHarkSkyScene("6");
    expect(resolveSkyReadability(getAppearanceState(), true)).toBeNull();

    setWallpaperPreset("snow-river");
    expect(resolveSkyReadability(getAppearanceState(), false)).toBeNull();

    setWallpaperPreset("none");
    setSkySource("theme");
    expect(resolveSkyReadability(getAppearanceState(), false)).toBeNull();
  });

  test("浅色 + 昼景：旋钮为 0；浅色 + 晨昏：加厚且次要文字加深", () => {
    setHarkSkyScene("0"); // Palo Alto 正午，darkness 0.15
    const day = resolveSkyReadability(getAppearanceState(), false);
    expect(day).not.toBeNull();
    expect(day?.lift).toBe(0);
    expect(day?.muted).toBe("#5f6673");

    setHarkSkyScene("6"); // 凤凰城黄金时刻，darkness 0.45
    const dusk = resolveSkyReadability(getAppearanceState(), false);
    expect(dusk).not.toBeNull();
    expect(dusk?.lift).toBeGreaterThan(0);
    expect(dusk?.lift).toBeLessThanOrEqual(0.14);
    expect(dusk?.muted).not.toBe("#5f6673");
  });

  test("浅色 + live：按本机时间给出旋钮值", () => {
    setHarkSkyScene("live");
    const live = resolveSkyReadability(getAppearanceState(), false);
    expect(live).not.toBeNull();
    expect(live?.lift).toBeGreaterThanOrEqual(0);
    expect(live?.lift).toBeLessThanOrEqual(0.14);
    // computeSky 在分钟刻度间插值，muted 可能是 hex 或 rgba()，只要是有效颜色值即可
    expect(live?.muted).toMatch(/^(#[0-9a-f]{6}|rgba?\([\d.,\s]+\))$/i);
  });
});

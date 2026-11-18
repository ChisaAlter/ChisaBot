/**
 * CB-137 主题族模型：seed → 整套 CSS 变量的纯派生、旧 palette 键迁移、
 * 浅 / 深两槽独立选择（混搭）、自定义族持久化与解析回落。
 */
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

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import {
  applyAppearanceToDocument,
  CUSTOM_FAMILIES_STORAGE_KEY,
  deriveSeed,
  FAMILY_DARK_STORAGE_KEY,
  FAMILY_LIGHT_STORAGE_KEY,
  familySeed,
  familySkyStops,
  getAppearanceState,
  isValidFamily,
  listThemeFamilies,
  migrateLegacyPalette,
  PALETTE_STORAGE_KEY,
  parseCustomFamilies,
  reloadAppearanceFromStorage,
  resolveThemeFamily,
  saveCustomFamily,
  type Seed,
  setThemeHalf,
  THEME_FAMILIES,
  updateAppearance,
} from "../src/lib/appearance";
import { luminance, parseColor } from "./contrast-model";

function hexLuminance(hex: string): number {
  const [r, g, b] = parseColor(hex);
  return luminance([r, g, b, 1]);
}
function hexContrast(a: string, b: string): number {
  const x = hexLuminance(a);
  const y = hexLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const azure = THEME_FAMILIES.find((f) => f.id === "azure")!;

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-theme-family");
});

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme-family");
  document.body.removeAttribute("style");
});

describe("THEME_FAMILIES 内置族", () => {
  test("八个内置族，id / 双色 seed / 对比度齐全", () => {
    expect(THEME_FAMILIES.map((f) => f.id)).toEqual([
      "azure",
      "mist",
      "celadon",
      "sakura",
      "amber",
      "violet",
      "london",
      "mono",
    ]);
    for (const f of THEME_FAMILIES) {
      expect(isValidFamily(f)).toBe(true);
      for (const s of [f.light, f.dark]) {
        expect(s.c).toBeGreaterThanOrEqual(30);
        expect(s.c).toBeLessThanOrEqual(70);
      }
    }
  });
});

describe("deriveSeed 纯派生", () => {
  test("强调色系令牌：--accent-blue/--accent-color = seed.ac，软色 / 聚焦是 rgba", () => {
    const v = deriveSeed(azure.light, false).root;
    expect(v["--accent-blue"]).toBe("#4176e6");
    expect(v["--accent-color"]).toBe("#4176e6");
    expect(v["--accent-blue-soft"]).toMatch(/^rgba\(65, 118, 230, 0\.14\)$/);
    expect(v["--accent-soft"]).toBe(v["--accent-blue-soft"]);
    expect(v["--glass-tint"]).toBe("rgba(65, 118, 230, 0.08)");
    expect(v["--focus"]).toBe("rgba(65, 118, 230, 0.24)");
    expect(v["--focus-line"]).toBe("rgba(65, 118, 230, 0.6)");
    // 主按钮底色 = 深色 ink 化，hover 更深一档。
    expect(v["--ink-primary"]).not.toBe(azure.light.ac);
    expect(v["--ink-primary"]).toBe(v["--accent-blue-ink"]);
    expect(v["--ink-primary-hover"]).not.toBe(v["--ink-primary"]);
  });

  test("--on-primary 按 WCAG 对比度在 #fff / #0f1115 之间取更高者", () => {
    // azure 蓝：白字对比更高
    expect(deriveSeed(azure.light, false).root["--on-primary"]).toBe("#ffffff");
    // mono 浅色 ac=#111111：白字
    const monoLight = THEME_FAMILIES.find((f) => f.id === "mono")!.light;
    expect(deriveSeed(monoLight, false).root["--on-primary"]).toBe("#ffffff");
    // celadon 深色 ac=#3dd6b5（亮色）：深字
    const celadonDark = THEME_FAMILIES.find((f) => f.id === "celadon")!.dark;
    const onDark = deriveSeed(celadonDark, true).root["--on-primary"];
    expect(onDark).toBe("#0f1115");
    // 所有内置 seed：选出的 on-primary 与该模式 ink-primary 保持 ≥ 3:1（AA 大文字）
    for (const f of THEME_FAMILIES)
      for (const dark of [false, true]) {
        const seed = familySeed(f, dark);
        const v = deriveSeed(seed, dark).root;
        expect(
          hexContrast(v["--ink-primary"]!, v["--on-primary"]!),
        ).toBeGreaterThanOrEqual(3);
      }
  });

  test("天空四段：浅色自上而下降回 bg，深色以 bg 为基、顶部更暗", () => {
    const light = familySkyStops(azure.light, false);
    expect(light).toHaveLength(4);
    // 末段 = 底色本身
    expect(light[3]).toBe("#f3f7fc");
    // 顶段比 bg 暗且带 accent 色味
    expect(hexLuminance(light[0])).toBeLessThan(hexLuminance("#f3f7fc"));
    const darkStops = familySkyStops(azure.dark, true);
    expect(darkStops).toHaveLength(4);
    for (const stop of darkStops) expect(hexLuminance(stop)).toBeLessThan(0.2);
  });

  test("对比度 c 驱动边框 alpha / 玻璃不透明度（高 c 更大）", () => {
    const lo = deriveSeed({ ...azure.light, c: 30 }, false).root;
    const hi = deriveSeed({ ...azure.light, c: 70 }, false).root;
    const alpha = (v: string) => Number(v.match(/,\s*([\d.]+)\)$/)?.[1] ?? 0);
    expect(alpha(hi["--stroke-primary"]!)).toBeGreaterThan(
      alpha(lo["--stroke-primary"]!),
    );
    expect(alpha(hi["--glass-bg"]!)).toBeGreaterThan(alpha(lo["--glass-bg"]!));
  });

  test("body 天空变量（--sky-1..4 注册变量）也一并给出", () => {
    const body = deriveSeed(azure.light, false).body;
    for (const k of ["--sky-1", "--sky-2", "--sky-3", "--sky-4", "--sky-glow"])
      expect(body[k]).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("migrateLegacyPalette 旧键迁移", () => {
  test("映射表：default/ocean→azure、aurora/nocturne→violet、emerald→celadon、sakura/ruby→sakura、sunset/gold→amber、stardust→mist", () => {
    expect(migrateLegacyPalette("default")).toBe("azure");
    expect(migrateLegacyPalette("ocean")).toBe("azure");
    expect(migrateLegacyPalette("aurora")).toBe("violet");
    expect(migrateLegacyPalette("nocturne")).toBe("violet");
    expect(migrateLegacyPalette("emerald")).toBe("celadon");
    expect(migrateLegacyPalette("sakura")).toBe("sakura");
    expect(migrateLegacyPalette("ruby")).toBe("sakura");
    expect(migrateLegacyPalette("sunset")).toBe("amber");
    expect(migrateLegacyPalette("gold")).toBe("amber");
    expect(migrateLegacyPalette("stardust")).toBe("mist");
    expect(migrateLegacyPalette("bogus")).toBeNull();
    expect(migrateLegacyPalette(null)).toBeNull();
  });

  test("老键有值且新键没有：两槽都写映射结果；老键不删、之后不再读", async () => {
    window.localStorage.setItem(PALETTE_STORAGE_KEY, "nocturne");
    await reloadAppearanceFromStorage();
    const state = getAppearanceState();
    expect(state.familyLight).toBe("violet");
    expect(state.familyDark).toBe("violet");
    // 老键还在
    expect(window.localStorage.getItem(PALETTE_STORAGE_KEY)).toBe("nocturne");
  });

  test("新键已有时忽略老键", async () => {
    window.localStorage.setItem(PALETTE_STORAGE_KEY, "nocturne");
    window.localStorage.setItem(FAMILY_LIGHT_STORAGE_KEY, "sakura");
    await reloadAppearanceFromStorage();
    expect(getAppearanceState().familyLight).toBe("sakura");
    expect(getAppearanceState().familyDark).toBe("violet");
  });

  test("全新用户：两槽 azure", async () => {
    await reloadAppearanceFromStorage();
    const state = getAppearanceState();
    expect(state.familyLight).toBe("azure");
    expect(state.familyDark).toBe("azure");
  });
});

describe("setThemeHalf 双槽独立", () => {
  test("点深色半边只改 familyDark，浅色槽不动（混搭成立）", async () => {
    await reloadAppearanceFromStorage();
    setThemeHalf("dark", "amber");
    let state = getAppearanceState();
    expect(state.familyDark).toBe("amber");
    expect(state.familyLight).toBe("azure");
    expect(window.localStorage.getItem(FAMILY_DARK_STORAGE_KEY)).toBe("amber");
    expect(window.localStorage.getItem(FAMILY_LIGHT_STORAGE_KEY)).toBeNull();
    setThemeHalf("light", "sakura");
    state = getAppearanceState();
    expect(state.familyLight).toBe("sakura");
    expect(state.familyDark).toBe("amber");
    expect(window.localStorage.getItem(FAMILY_LIGHT_STORAGE_KEY)).toBe(
      "sakura",
    );
  });

  test("applyAppearanceToDocument 写 data-theme-family + 内联派生变量", async () => {
    await reloadAppearanceFromStorage();
    setThemeHalf("dark", "sakura");
    document.documentElement.classList.add("dark");
    applyAppearanceToDocument();
    const de = document.documentElement;
    expect(de.getAttribute("data-theme-family")).toBe("sakura");
    expect(de.style.getPropertyValue("--accent-blue")).toBe("#e0789c");
    expect(de.style.getPropertyValue("--ink-1")).toBe("#f2dfe8");
    expect(de.style.getPropertyValue("--fam-sky-0")).toMatch(/^#[0-9a-f]{6}$/);
    expect(document.body.style.getPropertyValue("--sky-1")).toMatch(
      /^#[0-9a-f]{6}$/,
    );
    document.documentElement.classList.remove("dark");
  });
});

describe("saveCustomFamily / resolveThemeFamily", () => {
  const custom: Parameters<typeof saveCustomFamily>[0] = {
    id: "custom-mint",
    name: "薄荷",
    light: { ac: "#0d9488", bg: "#f0fdfa", fg: "#134e4a", c: 50 },
    dark: { ac: "#5eead4", bg: "#042f2e", fg: "#ccfbf1", c: 52 },
  };

  test("保存后两个族槽都指向它，且写进 chisabot-theme-families", async () => {
    await reloadAppearanceFromStorage();
    saveCustomFamily(custom);
    const state = getAppearanceState();
    expect(state.familyLight).toBe("custom-mint");
    expect(state.familyDark).toBe("custom-mint");
    const stored = parseCustomFamilies(
      window.localStorage.getItem(CUSTOM_FAMILIES_STORAGE_KEY),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]!.name).toBe("薄荷");
    // 重新加载后仍在，且能解析出这个族
    await reloadAppearanceFromStorage();
    const again = getAppearanceState();
    expect(again.customFamilies).toHaveLength(1);
    expect(resolveThemeFamily("custom-mint", again.customFamilies).name).toBe(
      "薄荷",
    );
    expect(listThemeFamilies(again.customFamilies).map((f) => f.id)).toContain(
      "custom-mint",
    );
  });

  test("resolveThemeFamily 回落：未知 id → azure", () => {
    expect(resolveThemeFamily("nope").id).toBe("azure");
    expect(resolveThemeFamily(null).id).toBe("azure");
    expect(resolveThemeFamily("mono").id).toBe("mono");
    expect(resolveThemeFamily("custom-mint", [custom]).name).toBe("薄荷");
    // 自定义 id 撞上内置 id 时不生效（内置优先）
    expect(resolveThemeFamily("azure", [custom]).id).toBe("azure");
  });

  test("parseCustomFamilies 丢弃坏条目 / 内置 id / 重复 id", () => {
    const parsed = parseCustomFamilies(
      JSON.stringify([
        custom,
        { ...custom, id: "custom-mint" }, // 重复 id
        { ...custom, id: "azure" }, // 撞内置
        { id: "custom-bad", name: "坏", light: { ac: "red" }, dark: {} },
        "not-an-object",
      ]),
    );
    expect(parsed.map((f) => f.id)).toEqual(["custom-mint"]);
  });

  test("存的族槽值解析不到时回 azure（自定义族被删的情况）", async () => {
    window.localStorage.setItem(FAMILY_DARK_STORAGE_KEY, "custom-gone");
    await reloadAppearanceFromStorage();
    expect(getAppearanceState().familyDark).toBe("azure");
  });
});

describe("updateAppearance 族校验", () => {
  test("非法族 id 写不进去", async () => {
    await reloadAppearanceFromStorage();
    updateAppearance({ familyLight: "no-such-family" });
    expect(getAppearanceState().familyLight).toBe("azure");
    expect(window.localStorage.getItem(FAMILY_LIGHT_STORAGE_KEY)).toBeNull();
  });
});

// 保持 Seed 类型在测试里可用来校验种子形态
const _seedTypeCheck: Seed = {
  ac: "#000000",
  bg: "#ffffff",
  fg: "#111111",
  c: 46,
};
void _seedTypeCheck;

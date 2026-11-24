/**
 * V2 色彩主题模型：6 套内置主题元数据、自定义强调色纯函数对比度派生、
 * 旧主题族/palette ID 无损映射、DOM 应用与非法值拦截。
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
import {
  applyAppearanceToDocument,
  CUSTOM_ACCENT_CSS_PROPS,
  DEFAULT_THEME_ID,
  deriveCustomAccentVars,
  flushAppearanceWrites,
  getAppearanceConfig,
  getThemeMeta,
  isThemeId,
  mapLegacyThemeId,
  normalizeHexColor,
  reloadAppearanceFromStorage,
  resetAppearance,
  setAppearanceConfig,
  setCustomAccent,
  setTheme,
  THEMES,
  themeMetaColor,
  VALID_THEME_IDS,
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

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

beforeEach(async () => {
  window.localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
  for (const attr of [
    "data-theme",
    "data-material",
    "data-canvas",
    "data-theme-family",
  ]) {
    document.documentElement.removeAttribute(attr);
  }
  resetAppearance();
  flushAppearanceWrites();
  window.localStorage.clear();
  await reloadAppearanceFromStorage();
});

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("style");
  document.documentElement.className = "";
});

describe("THEMES 内置 6 套主题元数据", () => {
  test("id 顺序、浅/深色元信息、themeColor 与校验函数齐全", () => {
    expect(DEFAULT_THEME_ID).toBe("sky");
    expect(VALID_THEME_IDS).toEqual([
      "sky",
      "aurora",
      "porcelain",
      "deepseek",
      "claude",
      "cossui",
    ]);
    expect(THEMES.map((t) => t.id)).toEqual([...VALID_THEME_IDS]);

    for (const theme of THEMES) {
      expect(isThemeId(theme.id)).toBe(true);
      expect(theme.tagline.length).toBeGreaterThan(0);
      expect(getThemeMeta(theme.id)).toBe(theme);
      for (const dark of [false, true]) {
        const variant = dark ? theme.dark : theme.light;
        expect(variant.accent).toMatch(/^#[0-9a-f]{6}$/);
        expect(variant.onAccent).toMatch(/^#[0-9a-f]{6}$/);
        expect(variant.bg).toMatch(/^#[0-9a-f]{6}$/);
        expect(variant.fg).toMatch(/^#[0-9a-f]{6}$/);
        expect(variant.surface).toMatch(/^#[0-9a-f]{6}$/);
        expect(themeMetaColor(theme.id, dark)).toBe(variant.themeColor);
        expect(variant.canvasStops).toHaveLength(3);
      }
    }

    for (const retired of [
      "azure",
      "london",
      "mist",
      "celadon",
      "sakura",
      "amber",
      "violet",
      "mono",
      null,
    ]) {
      expect(isThemeId(retired)).toBe(false);
    }
  });

  test("normalizeHexColor 规整 3/6 位 hex 并拒绝非法值", () => {
    expect(normalizeHexColor("#ABC")).toBe("#aabbcc");
    expect(normalizeHexColor("  #2563EB ")).toBe("#2563eb");
    expect(normalizeHexColor("rgb(1,2,3)")).toBeNull();
    expect(normalizeHexColor("#12345")).toBeNull();
    expect(normalizeHexColor(null)).toBeNull();
  });
});

describe("deriveCustomAccentVars 纯函数派生与 WCAG AA 对比度保障", () => {
  test("任意极端色在浅/深模式下派生的 --accent 满足图形 ≥ 3:1、--accent-ink 满足文本 ≥ 4.5:1", () => {
    const samples = [
      "#ffffff",
      "#f7f7f7",
      "#000000",
      "#18181b",
      "#facc15",
      "#22c55e",
      "#06b6d4",
      "#ec4899",
      "#94a3b8",
      "#111111",
    ];
    for (const hex of samples) {
      const lightVars = deriveCustomAccentVars(hex, false);
      expect(lightVars["--accent"]).toMatch(/^#[0-9a-f]{6}$/);
      expect(hexContrast(lightVars["--accent"], "#eef2f7")).toBeGreaterThanOrEqual(3.0);
      expect(hexContrast(lightVars["--accent"], "#ffffff")).toBeGreaterThanOrEqual(3.0);
      expect(hexContrast(lightVars["--accent-ink"], "#eef2f7")).toBeGreaterThanOrEqual(4.5);
      expect(hexContrast(lightVars["--accent-ink"], "#ffffff")).toBeGreaterThanOrEqual(4.5);
      expect(lightVars["--accent-soft"]).toMatch(/^rgba\(/);
      expect(lightVars["--accent-ring"]).toMatch(/^rgba\(/);

      const darkVars = deriveCustomAccentVars(hex, true);
      expect(darkVars["--accent"]).toMatch(/^#[0-9a-f]{6}$/);
      expect(hexContrast(darkVars["--accent"], "#1c222e")).toBeGreaterThanOrEqual(3.0);
      expect(hexContrast(darkVars["--accent"], "#10141c")).toBeGreaterThanOrEqual(3.0);
      expect(hexContrast(darkVars["--accent-ink"], "#1c222e")).toBeGreaterThanOrEqual(4.5);
      expect(hexContrast(darkVars["--accent-ink"], "#10141c")).toBeGreaterThanOrEqual(4.5);

      // --ink-on-accent 在 #ffffff 和 #0f1115 中选相对最终 --accent 对比度更高者
      const onLight = lightVars["--ink-on-accent"];
      const other = onLight === "#ffffff" ? "#0f1115" : "#ffffff";
      expect(hexContrast(onLight, lightVars["--accent"])).toBeGreaterThanOrEqual(
        hexContrast(other, lightVars["--accent"]) - 0.001,
      );
    }
  });

  test("浅色近白（#f7f7f7）与深色近黑（#18181b）自动压深/提亮防 Ring 弧线消失，已达标色原样保留", () => {
    const nearWhiteLight = deriveCustomAccentVars("#f7f7f7", false);
    expect(nearWhiteLight["--accent"]).not.toBe("#f7f7f7");
    expect(hexContrast(nearWhiteLight["--accent"], "#eef2f7")).toBeGreaterThanOrEqual(3.0);

    const nearBlackDark = deriveCustomAccentVars("#18181b", true);
    expect(nearBlackDark["--accent"]).not.toBe("#18181b");
    expect(hexContrast(nearBlackDark["--accent"], "#1c222e")).toBeGreaterThanOrEqual(3.0);

    expect(deriveCustomAccentVars("#2563eb", false)["--accent"]).toBe("#2563eb");
    expect(deriveCustomAccentVars("#74aeff", true)["--accent"]).toBe("#74aeff");
  });
});

describe("mapLegacyThemeId 旧主题族与旧 palette 无损映射", () => {
  test("覆盖全部历史 id 映射并拒绝未知值", () => {
    expect(mapLegacyThemeId("sky")).toBe("sky");
    expect(mapLegacyThemeId("default")).toBe("sky");
    expect(mapLegacyThemeId("azure")).toBe("sky");
    expect(mapLegacyThemeId("ocean")).toBe("sky");
    expect(mapLegacyThemeId("aurora")).toBe("aurora");
    expect(mapLegacyThemeId("violet")).toBe("aurora");
    expect(mapLegacyThemeId("nocturne")).toBe("aurora");
    expect(mapLegacyThemeId("emerald")).toBe("aurora");
    expect(mapLegacyThemeId("porcelain")).toBe("porcelain");
    expect(mapLegacyThemeId("celadon")).toBe("porcelain");
    expect(mapLegacyThemeId("deepseek")).toBe("deepseek");
    expect(mapLegacyThemeId("mist")).toBe("deepseek");
    expect(mapLegacyThemeId("london")).toBe("deepseek");
    expect(mapLegacyThemeId("stardust")).toBe("deepseek");
    expect(mapLegacyThemeId("claude")).toBe("claude");
    expect(mapLegacyThemeId("amber")).toBe("claude");
    expect(mapLegacyThemeId("sunset")).toBe("claude");
    expect(mapLegacyThemeId("gold")).toBe("claude");
    expect(mapLegacyThemeId("sakura")).toBe("claude");
    expect(mapLegacyThemeId("ruby")).toBe("claude");
    expect(mapLegacyThemeId("cossui")).toBe("cossui");
    expect(mapLegacyThemeId("coss")).toBe("cossui");
    expect(mapLegacyThemeId("mono")).toBe("cossui");
    expect(mapLegacyThemeId("bogus")).toBeNull();
    expect(mapLegacyThemeId(null)).toBeNull();
  });
});

describe("DOM 根契约与非法主题值拦截", () => {
  test("applyAppearanceToDocument 写 data-theme，仅在设置 customAccent 时内联写 5 个强调变量，置空即清", () => {
    setTheme("claude");
    applyAppearanceToDocument(getAppearanceConfig(), false);
    const de = document.documentElement;
    expect(de.getAttribute("data-theme")).toBe("claude");
    expect(de.getAttribute("data-theme-family")).toBeNull();
    for (const prop of CUSTOM_ACCENT_CSS_PROPS) {
      expect(de.style.getPropertyValue(prop)).toBe("");
    }

    setCustomAccent("#f59e0b");
    for (const prop of CUSTOM_ACCENT_CSS_PROPS) {
      expect(de.style.getPropertyValue(prop)).not.toBe("");
    }

    setCustomAccent(null);
    for (const prop of CUSTOM_ACCENT_CSS_PROPS) {
      expect(de.style.getPropertyValue(prop)).toBe("");
    }
  });

  test("非法主题 id 无法写入配置", () => {
    setAppearanceConfig({
      theme: "no-such-theme" as unknown as "sky",
    });
    expect(getAppearanceConfig().theme).toBe("sky");
  });
});

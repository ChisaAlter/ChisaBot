/**
 * V2 色彩主题模型：7 套内置主题元数据、自定义强调色纯函数对比度派生、
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

describe("THEMES 内置 7 套主题元数据", () => {
  test("id 顺序、浅/深色元信息、themeColor 与校验函数齐全", () => {
    expect(DEFAULT_THEME_ID).toBe("sky");
    expect(VALID_THEME_IDS).toEqual([
      "sky",
      "mist",
      "celadon",
      "sakura",
      "amber",
      "violet",
      "mono",
    ]);
    expect(THEMES.map((t) => t.id)).toEqual([...VALID_THEME_IDS]);

    for (const theme of THEMES) {
      expect(isThemeId(theme.id)).toBe(true);
      expect(getThemeMeta(theme.id)).toBe(theme);
      for (const dark of [false, true]) {
        const variant = dark ? theme.dark : theme.light;
        expect(variant.accent).toMatch(/^#[0-9a-f]{6}$/);
        expect(variant.bg).toMatch(/^#[0-9a-f]{6}$/);
        expect(variant.fg).toMatch(/^#[0-9a-f]{6}$/);
        expect(themeMetaColor(theme.id, dark)).toBe(variant.themeColor);
        expect(variant.canvasStops).toHaveLength(3);
      }
    }

    expect(isThemeId("azure")).toBe(false);
    expect(isThemeId("london")).toBe(false);
    expect(isThemeId(null)).toBe(false);
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
  test("任意极端色在浅/深模式下派生的 --accent-ink 均满足 ≥ 4.5:1", () => {
    const samples = [
      "#ffffff",
      "#000000",
      "#facc15",
      "#22c55e",
      "#06b6d4",
      "#ec4899",
      "#94a3b8",
      "#111111",
    ];
    for (const hex of samples) {
      const lightVars = deriveCustomAccentVars(hex, false);
      expect(lightVars["--accent"]).toBe(hex);
      expect(hexContrast(lightVars["--accent-ink"], "#eef2f7")).toBeGreaterThanOrEqual(4.5);
      expect(hexContrast(lightVars["--accent-ink"], "#ffffff")).toBeGreaterThanOrEqual(4.5);
      expect(lightVars["--accent-soft"]).toMatch(/^rgba\(/);
      expect(lightVars["--accent-ring"]).toMatch(/^rgba\(/);

      const darkVars = deriveCustomAccentVars(hex, true);
      expect(darkVars["--accent"]).toBe(hex);
      expect(hexContrast(darkVars["--accent-ink"], "#1c222e")).toBeGreaterThanOrEqual(4.5);
      expect(hexContrast(darkVars["--accent-ink"], "#10141c")).toBeGreaterThanOrEqual(4.5);

      // --ink-on-accent 在 #ffffff 和 #0f1115 中选对比度更高者
      const onLight = lightVars["--ink-on-accent"];
      const other = onLight === "#ffffff" ? "#0f1115" : "#ffffff";
      expect(hexContrast(onLight, hex)).toBeGreaterThanOrEqual(
        hexContrast(other, hex) - 0.001,
      );
    }
  });
});

describe("mapLegacyThemeId 旧主题族与旧 palette 无损映射", () => {
  test("覆盖全部历史 id 映射并拒绝未知值", () => {
    expect(mapLegacyThemeId("default")).toBe("sky");
    expect(mapLegacyThemeId("azure")).toBe("sky");
    expect(mapLegacyThemeId("ocean")).toBe("sky");
    expect(mapLegacyThemeId("mist")).toBe("mist");
    expect(mapLegacyThemeId("stardust")).toBe("mist");
    expect(mapLegacyThemeId("london")).toBe("mist");
    expect(mapLegacyThemeId("celadon")).toBe("celadon");
    expect(mapLegacyThemeId("emerald")).toBe("celadon");
    expect(mapLegacyThemeId("sakura")).toBe("sakura");
    expect(mapLegacyThemeId("ruby")).toBe("sakura");
    expect(mapLegacyThemeId("amber")).toBe("amber");
    expect(mapLegacyThemeId("sunset")).toBe("amber");
    expect(mapLegacyThemeId("gold")).toBe("amber");
    expect(mapLegacyThemeId("violet")).toBe("violet");
    expect(mapLegacyThemeId("aurora")).toBe("violet");
    expect(mapLegacyThemeId("nocturne")).toBe("violet");
    expect(mapLegacyThemeId("mono")).toBe("mono");
    expect(mapLegacyThemeId("bogus")).toBeNull();
    expect(mapLegacyThemeId(null)).toBeNull();
  });
});

describe("DOM 根契约与非法主题值拦截", () => {
  test("applyAppearanceToDocument 写 data-theme，仅在设置 customAccent 时内联写 5 个强调变量，置空即清", () => {
    setTheme("sakura");
    applyAppearanceToDocument(getAppearanceConfig(), false);
    const de = document.documentElement;
    expect(de.getAttribute("data-theme")).toBe("sakura");
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

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  ARTISTIC_WALLPAPER_PRESETS,
  DEFAULT_APPEARANCE_CONFIG,
  deriveCustomAccentVars,
  getAppearanceConfig,
  isDefaultAppearance,
  LEGACY_WALLPAPER_ID_MAP,
  MATERIALS,
  reloadAppearanceFromStorage,
  resetAppearance,
  resolveWallpaperCssFromConfig,
  SKY_SCENE_TO_HARK_INDEX,
  SKY_SCENES,
  setMaterial,
  setSkyScene,
  setTheme,
  setWallpaperAdjustments,
  setWallpaperSource,
  shouldFetchLiveWeather,
  THEMES,
  WALLPAPER_CATEGORIES,
  WALLPAPER_ID_STORAGE_KEY,
} from "../src/lib/appearance";

const srcDir = path.join(import.meta.dir, "../src");
const readCss = (rel: string) => readFileSync(path.join(srcDir, rel), "utf8");
const tokensCss = readCss("styles/tokens.css");
const canvasCss = readCss("styles/canvas.css");
const materialsCss = readCss("styles/materials.css");
const stylesCss = readCss("styles.css");

describe("V2 外观核心模型：6 套主题、5 档动态天空、15 幅艺术壁纸与 3 档纯 CSS 材质", () => {
  test("提供 6 套精选主题且每套浅/深元数据与 tokens.css 声明对齐，自定义强调色可派生完整 5 令牌", () => {
    expect(THEMES).toHaveLength(6);
    expect(THEMES.map((t) => t.id)).toEqual([
      "sky",
      "aurora",
      "porcelain",
      "deepseek",
      "claude",
      "cossui",
    ]);
    for (const theme of THEMES) {
      expect(tokensCss).toContain(`html[data-theme="${theme.id}"]`);
      expect(tokensCss).toContain(`html.dark[data-theme="${theme.id}"]`);
      for (const dark of [false, true]) {
        const accent = dark ? theme.dark.accent : theme.light.accent;
        const derived = deriveCustomAccentVars(accent, dark);
        expect(derived["--accent"]).toMatch(/^#[0-9a-f]{6}$/);
        expect(derived["--accent-ink"]).toMatch(/^#[0-9a-f]{6}$/);
        expect(derived["--accent-soft"]).toMatch(/^rgba\(/);
        expect(derived["--accent-ring"]).toMatch(/^rgba\(/);
        expect(["#ffffff", "#0f1115"]).toContain(derived["--ink-on-accent"]);
      }
    }
  });

  test("Hark WebGL wallpaper_core.html 与 5 档天空时刻（4 固定时刻精确映射，默认关闭实时天气 0 请求）", () => {
    const wallpaperHtmlPath = path.join(
      import.meta.dir,
      "../public/wallpaper_core.html",
    );
    expect(existsSync(wallpaperHtmlPath)).toBe(true);
    const wallpaperHtml = readFileSync(wallpaperHtmlPath, "utf8");
    expect(wallpaperHtml).toContain("window.hark");
    expect(wallpaperHtml).toContain("const SCENES = [");

    expect(SKY_SCENES).toHaveLength(5);
    expect(SKY_SCENE_TO_HARK_INDEX).toEqual({
      dawn: 11,
      day: 0,
      dusk: 6,
      night: 4,
    });

    resetAppearance();
    expect(getAppearanceConfig()).toEqual(DEFAULT_APPEARANCE_CONFIG);
    expect(shouldFetchLiveWeather(getAppearanceConfig())).toBe(false);

    setSkyScene("dusk");
    expect(getAppearanceConfig().canvas).toEqual({
      kind: "sky",
      scene: "dusk",
      weather: { enabled: false, city: null },
    });
    expect(shouldFetchLiveWeather(getAppearanceConfig())).toBe(false);
  });

  test("15 幅艺术壁纸 WebP 原图与缩略图均真实存在，支持 4 分类、自定义 URL 转义、旧预设迁移与重置", async () => {
    resetAppearance();
    expect(getAppearanceConfig().theme).toBe("sky");
    expect(getAppearanceConfig().material).toBe("glass");
    expect(resolveWallpaperCssFromConfig(getAppearanceConfig())).toBeNull();

    expect(ARTISTIC_WALLPAPER_PRESETS).toHaveLength(15);
    expect(WALLPAPER_CATEGORIES.map((c) => c.id)).toEqual([
      "all",
      "impression",
      "eastern",
      "modern",
    ]);
    for (const cat of ["impression", "eastern", "modern"] as const) {
      expect(
        ARTISTIC_WALLPAPER_PRESETS.filter((w) => w.category === cat),
      ).toHaveLength(5);
    }

    const publicDir = path.join(import.meta.dir, "../public");
    for (const art of ARTISTIC_WALLPAPER_PRESETS) {
      const fullPath = path.join(publicDir, art.imageUrl);
      const thumbPath = path.join(publicDir, art.thumbUrl);
      expect(existsSync(fullPath)).toBe(true);
      expect(existsSync(thumbPath)).toBe(true);
      expect(statSync(fullPath).size).toBeGreaterThan(20_000);
      expect(statSync(thumbPath).size).toBeGreaterThan(4_000);
    }

    for (const art of ARTISTIC_WALLPAPER_PRESETS) {
      setWallpaperSource(art.id);
      expect(resolveWallpaperCssFromConfig(getAppearanceConfig())).toBe(
        `url("/wallpapers/${art.id}.webp")`,
      );
    }

    if (typeof window !== "undefined" && window.localStorage) {
      for (const [legacyId, mappedId] of Object.entries(
        LEGACY_WALLPAPER_ID_MAP,
      )) {
        window.localStorage.clear();
        window.localStorage.setItem(WALLPAPER_ID_STORAGE_KEY, legacyId);
        await reloadAppearanceFromStorage();
        const cfg = getAppearanceConfig();
        expect(cfg.canvas.kind).toBe("wallpaper");
        if (cfg.canvas.kind === "wallpaper") {
          expect(cfg.canvas.source).toBe(mappedId);
        }
      }
    }

    setTheme("claude");
    setMaterial("clear");
    setWallpaperSource("starry-rhone");
    setWallpaperAdjustments({ blur: 14, scrim: 45 });
    const modified = getAppearanceConfig();
    expect(modified.theme).toBe("claude");
    expect(modified.material).toBe("clear");
    expect(modified.canvas).toEqual({
      kind: "wallpaper",
      source: "starry-rhone",
      blur: 14,
      scrim: 45,
    });

    resetAppearance();
    expect(isDefaultAppearance(getAppearanceConfig())).toBe(true);
  });

  test("5 层 CSS 文件定义 #sky-root、3 档纯 CSS 材质与单层壁纸薄幕，且 0 -webkit-backdrop-filter", () => {
    expect(MATERIALS.map((m) => m.id)).toEqual(["glass", "clear", "solid"]);
    expect(canvasCss).toContain("#sky-root");
    expect(canvasCss).toContain('html[data-canvas="sky"] #sky-root::after');
    expect(canvasCss).toContain(
      'html[data-canvas="wallpaper"] #sky-root::after',
    );
    expect(canvasCss).toContain(".chisabot-wallpaper");
    expect(materialsCss).toContain('html[data-material="glass"]');
    expect(materialsCss).toContain('html[data-material="clear"]');
    expect(materialsCss).toContain('html[data-material="solid"]');
    expect(tokensCss).toMatch(/@property --surface-bg \{[^}]*inherits: false;/);
    expect(tokensCss).toMatch(
      /@property --surface-blur \{[^}]*inherits: false;/,
    );
    for (const css of [tokensCss, canvasCss, materialsCss, stylesCss]) {
      expect(css).not.toContain("-webkit-backdrop-filter:");
    }
    expect(canvasCss).toContain(
      'html:not(.dark)[data-theme="sky"][data-canvas="pure"] #sky-root #skyph::before',
    );
    expect(canvasCss).toContain(
      'html.dark[data-theme="sky"][data-canvas="pure"] #sky-root #skyph::before',
    );
    expect(canvasCss).toContain(
      'html:not(.dark)[data-theme="aurora"][data-canvas="pure"] #sky-root #skyph::before',
    );
    expect(canvasCss).toContain(
      'html.dark[data-theme="aurora"][data-canvas="pure"] #sky-root #skyph::before',
    );
  });
});

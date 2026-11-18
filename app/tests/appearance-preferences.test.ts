import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  ARTISTIC_WALLPAPER_PRESETS,
  deriveSeed,
  familySeed,
  getAppearanceState,
  HARK_SKY_SCENES,
  LEGACY_WALLPAPER_ID_MAP,
  reloadAppearanceFromStorage,
  resetAppearanceDefaults,
  resolveActiveWallpaperCss,
  resolveEffectiveHarkScene,
  setCustomWallpaperUrl,
  setGlassOpacity,
  setGlassStyle,
  setHarkSkyScene,
  setThemeHalf,
  setWallpaperBlur,
  setWallpaperDim,
  setWallpaperPreset,
  THEME_FAMILIES,
  WALLPAPER_CATEGORIES,
  WALLPAPER_ID_STORAGE_KEY,
  WALLPAPER_PRESETS,
} from "../src/lib/appearance";

const css = readFileSync(
  path.join(import.meta.dir, "../src/styles.css"),
  "utf8",
);

describe("appearance theme families, Hark WebGL sky scenes, wallpapers & glass", () => {
  test("provides 8 curated theme families and derives sky variables for every family", () => {
    expect(THEME_FAMILIES.length).toBe(8);
    for (const f of THEME_FAMILIES) {
      // 每个族的深浅两个 seed 都能派生出完整的四段天空与 accent 令牌
      for (const dark of [false, true]) {
        const vars = deriveSeed(familySeed(f, dark), dark);
        expect(vars.body["--sky-1"]).toBeTruthy();
        expect(vars.root["--fam-sky-3"]).toBeTruthy();
        expect(vars.root["--accent-blue"]).toBe(familySeed(f, dark).ac);
      }
    }
  });

  test("provides Hark WebGL wallpaper_core.html and 8 curated sky scene options plus backward-compatible scene resolution", () => {
    const wallpaperHtmlPath = path.join(
      import.meta.dir,
      "../public/wallpaper_core.html",
    );
    expect(existsSync(wallpaperHtmlPath)).toBe(true);
    const wallpaperHtml = readFileSync(wallpaperHtmlPath, "utf8");
    expect(wallpaperHtml).toContain("window.hark");
    expect(wallpaperHtml).toContain("const SCENES = [");

    expect(HARK_SKY_SCENES.length).toBe(8);
    resetAppearanceDefaults();
    expect(getAppearanceState().harkScene).toBe("auto");
    expect(resolveEffectiveHarkScene(getAppearanceState(), false)).toBe(0);
    expect(resolveEffectiveHarkScene(getAppearanceState(), true)).toBe(4);

    setHarkSkyScene("1");
    expect(getAppearanceState().harkScene).toBe("1");
    expect(resolveEffectiveHarkScene(getAppearanceState(), false)).toBe(1);
    expect(resolveEffectiveHarkScene(getAppearanceState(), true)).toBe(1);

    setHarkSkyScene("live");
    expect(resolveEffectiveHarkScene(getAppearanceState(), false)).toBe("live");
  });

  test("resolves curated artistic gallery wallpapers (with verified WebP assets), custom URLs, legacy IDs, and resets cleanly", () => {
    resetAppearanceDefaults();
    expect(getAppearanceState().familyLight).toBe("azure");
    expect(getAppearanceState().familyDark).toBe("azure");
    expect(getAppearanceState().glassStyle).toBe("mist");
    expect(getAppearanceState().glassOpacity).toBe(16);
    expect(resolveActiveWallpaperCss(getAppearanceState())).toBeNull();

    expect(ARTISTIC_WALLPAPER_PRESETS.length).toBe(15);
    expect(WALLPAPER_CATEGORIES.map((c) => c.id)).toEqual([
      "all",
      "impression",
      "eastern",
      "modern",
    ]);
    for (const cat of ["impression", "eastern", "modern"] as const) {
      expect(
        ARTISTIC_WALLPAPER_PRESETS.filter((w) => w.category === cat).length,
      ).toBe(5);
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

    for (const wp of WALLPAPER_PRESETS) {
      setWallpaperPreset(wp.id);
      const resolved = resolveActiveWallpaperCss(getAppearanceState());
      if (wp.id === "none") {
        expect(resolved).toBeNull();
      } else {
        expect(resolved).toBe(`url("/wallpapers/${wp.id}.webp")`);
      }
    }

    if (typeof window !== "undefined" && window.localStorage) {
      for (const [legacyId, mappedId] of Object.entries(
        LEGACY_WALLPAPER_ID_MAP,
      )) {
        window.localStorage.setItem(WALLPAPER_ID_STORAGE_KEY, legacyId);
        void reloadAppearanceFromStorage();
        expect(getAppearanceState().wallpaperId).toBe(mappedId);
      }
    }

    setCustomWallpaperUrl("https://example.com/wall.jpg");
    expect(getAppearanceState().wallpaperId).toBe("custom");
    expect(resolveActiveWallpaperCss(getAppearanceState())).toBe(
      'url("https://example.com/wall.jpg")',
    );

    setThemeHalf("light", "sakura");
    setGlassStyle("crystal");
    setGlassOpacity(10);
    setWallpaperBlur(14);
    setWallpaperDim(28);
    expect(getAppearanceState().familyLight).toBe("sakura");
    expect(getAppearanceState().familyDark).toBe("azure");
    expect(getAppearanceState().glassStyle).toBe("crystal");
    expect(getAppearanceState().glassOpacity).toBe(10);
    expect(getAppearanceState().wallpaperBlur).toBe(14);
    expect(getAppearanceState().wallpaperDim).toBe(28);

    resetAppearanceDefaults();
    expect(getAppearanceState().familyLight).toBe("azure");
    expect(getAppearanceState().familyDark).toBe("azure");
    expect(getAppearanceState().glassStyle).toBe("mist");
    expect(getAppearanceState().glassOpacity).toBe(16);
    expect(getAppearanceState().harkScene).toBe("auto");
    expect(getAppearanceState().wallpaperId).toBe("none");
  });

  test("styles.css defines Hark #sky-root, 4 translucent borderless glass modes, light/dark sky contrast veils, and zero -webkit-backdrop-filter minifier traps", () => {
    expect(css).toContain("#sky-root");
    expect(css).toContain("html:not(.dark) #sky-root::after");
    expect(css).toContain("html.dark #sky-root::after");
    expect(css).toContain('html[data-glass="liquid"]');
    expect(css).toContain('html[data-glass="mist"]');
    expect(css).toContain('html[data-glass="crystal"]');
    expect(css).toContain('html[data-glass="frosted"]');
    expect(css).toMatch(
      /@property --lg-alpha \{[^}]*inherits: false; initial-value: 0\.16;/,
    );
    expect(css).toContain("--lg-border: transparent");
    expect(css).toContain("border: 0 !important");
    expect(css).toContain(".chisabot-wallpaper");
    expect(css).toContain(
      ":is(.glass-side-card, .acct-card, .acct-mini-card, .glass-mini-card, .rail-card)",
    );
    expect(css).not.toContain("-webkit-backdrop-filter:");
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  computePaletteSky,
  getAppearanceState,
  HARK_SKY_SCENES,
  resetAppearanceDefaults,
  resolveActiveWallpaperCss,
  resolveEffectiveHarkScene,
  setCustomWallpaperUrl,
  setGlassOpacity,
  setGlassStyle,
  setHarkSkyScene,
  setThemePalette,
  setWallpaperBlur,
  setWallpaperDim,
  setWallpaperPreset,
  THEME_PALETTES,
  WALLPAPER_PRESETS,
} from "../src/lib/appearance";

const css = readFileSync(path.join(import.meta.dir, "../src/styles.css"), "utf8");

describe("appearance palettes, Hark WebGL sky scenes, wallpapers & glass", () => {
  test("provides 6 curated high-contrast theme palettes and computes sky variables for non-default palettes", () => {
    expect(THEME_PALETTES.length).toBe(6);
    expect(computePaletteSky("default", false)).toBeNull();
    for (const p of THEME_PALETTES) {
      // Every theme's dark sky scene is a deep night scene (2 or 4) for dark mode legibility
      expect([2, 4]).toContain(p.harkSceneDark);
      if (p.id === "default") continue;
      const light = computePaletteSky(p.id, false);
      const dark = computePaletteSky(p.id, true);
      expect(light).not.toBeNull();
      expect(dark).not.toBeNull();
      expect(light?.body["--sky-1"]).toBeTruthy();
      expect(dark?.body["--sky-1"]).toBeTruthy();
    }
  });

  test("provides Hark WebGL wallpaper_core.html and 6 curated sky scene options plus backward-compatible scene resolution", () => {
    const wallpaperHtmlPath = path.join(import.meta.dir, "../public/wallpaper_core.html");
    expect(existsSync(wallpaperHtmlPath)).toBe(true);
    const wallpaperHtml = readFileSync(wallpaperHtmlPath, "utf8");
    expect(wallpaperHtml).toContain("window.hark");
    expect(wallpaperHtml).toContain("const SCENES = [");

    expect(HARK_SKY_SCENES.length).toBe(6);
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

  test("resolves built-in and custom wallpaper CSS backgrounds, glass opacity, and resets cleanly", () => {
    resetAppearanceDefaults();
    expect(getAppearanceState().palette).toBe("default");
    expect(getAppearanceState().glassStyle).toBe("liquid");
    expect(getAppearanceState().glassOpacity).toBe(16);
    expect(resolveActiveWallpaperCss(getAppearanceState())).toBeNull();

    for (const wp of WALLPAPER_PRESETS) {
      setWallpaperPreset(wp.id);
      const resolved = resolveActiveWallpaperCss(getAppearanceState());
      if (wp.id === "none") {
        expect(resolved).toBeNull();
      } else {
        expect(resolved).toContain("data:image/svg+xml");
      }
    }

    setCustomWallpaperUrl("https://example.com/wall.jpg");
    expect(getAppearanceState().wallpaperId).toBe("custom");
    expect(resolveActiveWallpaperCss(getAppearanceState())).toBe(
      'url("https://example.com/wall.jpg")',
    );

    setThemePalette("sakura");
    setGlassStyle("crystal");
    setGlassOpacity(10);
    setWallpaperBlur(14);
    setWallpaperDim(28);
    expect(getAppearanceState().palette).toBe("sakura");
    expect(getAppearanceState().glassStyle).toBe("crystal");
    expect(getAppearanceState().glassOpacity).toBe(10);
    expect(getAppearanceState().wallpaperBlur).toBe(14);
    expect(getAppearanceState().wallpaperDim).toBe(28);

    resetAppearanceDefaults();
    expect(getAppearanceState().palette).toBe("default");
    expect(getAppearanceState().glassStyle).toBe("liquid");
    expect(getAppearanceState().glassOpacity).toBe(16);
    expect(getAppearanceState().harkScene).toBe("auto");
    expect(getAppearanceState().wallpaperId).toBe("none");
  });

  test("styles.css defines Hark #sky-root, 3 translucent borderless glass modes, light/dark sky contrast veils, and zero -webkit-backdrop-filter minifier traps", () => {
    expect(css).toContain("#sky-root");
    expect(css).toContain("html:not(.dark) #sky-root::after");
    expect(css).toContain("html.dark #sky-root::after");
    expect(css).toContain('html[data-glass="liquid"]');
    expect(css).toContain('html[data-glass="crystal"]');
    expect(css).toContain('html[data-glass="frosted"]');
    expect(css).toMatch(/@property --lg-alpha \{[^}]*inherits: false; initial-value: 0\.16;/);
    expect(css).toContain("--lg-border: transparent");
    expect(css).toContain("border: 0 !important");
    expect(css).toContain(".chisabot-wallpaper");
    expect(css).toContain(":is(.glass-side-card, .acct-card, .acct-mini-card, .glass-mini-card, .rail-card)");
    expect(css).not.toContain("-webkit-backdrop-filter:");
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  computePaletteSky,
  getAppearanceState,
  resetAppearanceDefaults,
  resolveActiveWallpaperCss,
  setCustomWallpaperUrl,
  setGlassStyle,
  setThemePalette,
  setWallpaperBlur,
  setWallpaperDim,
  setWallpaperPreset,
  THEME_PALETTES,
  WALLPAPER_PRESETS,
} from "../src/lib/appearance";

const css = readFileSync(path.join(import.meta.dir, "../src/styles.css"), "utf8");

describe("appearance palettes, wallpapers & liquid glass", () => {
  test("provides 8 curated theme palettes and computes sky variables for non-default palettes", () => {
    expect(THEME_PALETTES.length).toBe(8);
    expect(computePaletteSky("default", false)).toBeNull();
    for (const p of THEME_PALETTES) {
      if (p.id === "default") continue;
      const light = computePaletteSky(p.id, false);
      const dark = computePaletteSky(p.id, true);
      expect(light).not.toBeNull();
      expect(dark).not.toBeNull();
      expect(light?.body["--sky-1"]).toBeTruthy();
      expect(dark?.body["--sky-1"]).toBeTruthy();
    }
  });

  test("resolves built-in and custom wallpaper CSS backgrounds and resets cleanly", () => {
    resetAppearanceDefaults();
    expect(getAppearanceState().palette).toBe("default");
    expect(getAppearanceState().glassStyle).toBe("liquid");
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
    setWallpaperBlur(14);
    setWallpaperDim(28);
    expect(getAppearanceState().palette).toBe("sakura");
    expect(getAppearanceState().glassStyle).toBe("crystal");
    expect(getAppearanceState().wallpaperBlur).toBe(14);
    expect(getAppearanceState().wallpaperDim).toBe(28);

    resetAppearanceDefaults();
    expect(getAppearanceState().palette).toBe("default");
    expect(getAppearanceState().glassStyle).toBe("liquid");
    expect(getAppearanceState().wallpaperId).toBe("none");
  });

  test("styles.css defines liquid glass surface tokens and applies them to core workspace panels", () => {
    expect(css).toContain('html[data-glass="liquid"]');
    expect(css).toContain('html[data-glass="crystal"]');
    expect(css).toContain(".chisabot-wallpaper");
    expect(css).toContain(":is(.glass-side-card, .acct-card, .acct-mini-card, .glass-mini-card, .rail-card)");
  });
});

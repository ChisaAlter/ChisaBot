import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { AppearancePreferences } from "@/components/settings/appearance-preferences";
import {
  DEFAULT_GLASS_OPACITY,
  DEFAULT_GLASS_STYLE,
  flushAppearanceWrites,
  GLASS_OPACITY_DARK_STORAGE_KEY,
  GLASS_OPACITY_STORAGE_KEY,
  GLASS_STYLE_STORAGE_KEY,
  getAppearanceState,
  HARK_SCENE_STORAGE_KEY,
  LEGACY_DEFAULT_GLASS_STYLE,
  PALETTE_STORAGE_KEY,
  PRIOR_APPEARANCE_STORAGE_KEYS,
  reloadAppearanceFromStorage,
  resetAppearanceDefaults,
  setGlassOpacity,
  setGlassStyle,
  WALLPAPER_BLUR_STORAGE_KEY,
  WALLPAPER_CUSTOM_URL_STORAGE_KEY,
  WALLPAPER_DIM_STORAGE_KEY,
  WALLPAPER_ID_STORAGE_KEY,
} from "@/lib/appearance";
import { paletteBootScript } from "@/lib/palette";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  window.localStorage.clear();
  reloadAppearanceFromStorage();
});

describe("default glass is mist", () => {
  test("fresh storage reads mist at 16/16 haze", () => {
    expect(getAppearanceState().glassStyle).toBe("mist");
    expect(getAppearanceState().glassOpacity).toBe(16);
    expect(getAppearanceState().glassOpacityDark).toBe(16);
  });

  test("resetAppearanceDefaults returns to mist, not liquid", () => {
    setGlassStyle("liquid");
    flushAppearanceWrites();
    resetAppearanceDefaults();
    flushAppearanceWrites();
    expect(getAppearanceState().glassStyle).toBe("mist");
    expect(getAppearanceState().glassOpacity).toBe(16);
    expect(getAppearanceState().glassOpacityDark).toBe(16);
    expect(window.localStorage.getItem(GLASS_STYLE_STORAGE_KEY)).toBe("mist");
  });

  test("a stored liquid preference is kept (no migration overwrite)", () => {
    window.localStorage.setItem(GLASS_STYLE_STORAGE_KEY, "liquid");
    reloadAppearanceFromStorage();
    expect(getAppearanceState().glassStyle).toBe("liquid");
  });

  test("boot script writes mist when localStorage has no glass style", () => {
    const boot = paletteBootScript();
    expect(boot).toContain('"mist"');
    // Evaluate the boot snippet against an empty storage.
    document.documentElement.removeAttribute("data-glass");
    Function(boot)();
    expect(document.documentElement.getAttribute("data-glass")).toBe("mist");
  });

  test("settings dirty check treats mist+16 as default (no reset button)", async () => {
    resetAppearanceDefaults();
    flushAppearanceWrites();
    const view = render(<AppearancePreferences />);
    expect(view.queryByRole("button", { name: "恢复默认" })).toBeNull();
    act(() => {
      setGlassStyle("liquid");
      flushAppearanceWrites();
    });
    view.rerender(<AppearancePreferences />);
    expect(view.getByRole("button", { name: "恢复默认" })).toBeTruthy();
  });
});

/** 在空 <html> 上跑一遍启动脚本，返回它写的 data-glass。 */
function bootGlass(): string | null {
  document.documentElement.removeAttribute("data-glass");
  Function(paletteBootScript())();
  return document.documentElement.getAttribute("data-glass");
}

describe("existing users keep the old default (liquid)", () => {
  test("the prior-appearance key list is every appearance key except the glass style and the auto-written theme", () => {
    expect([...PRIOR_APPEARANCE_STORAGE_KEYS].sort()).toEqual(
      [
        PALETTE_STORAGE_KEY,
        WALLPAPER_ID_STORAGE_KEY,
        WALLPAPER_CUSTOM_URL_STORAGE_KEY,
        WALLPAPER_BLUR_STORAGE_KEY,
        WALLPAPER_DIM_STORAGE_KEY,
        GLASS_OPACITY_STORAGE_KEY,
        GLASS_OPACITY_DARK_STORAGE_KEY,
        HARK_SCENE_STORAGE_KEY,
      ].sort(),
    );
    expect(PRIOR_APPEARANCE_STORAGE_KEYS).not.toContain(THEME_STORAGE_KEY);
    expect(DEFAULT_GLASS_STYLE).toBe("mist");
    expect(LEGACY_DEFAULT_GLASS_STYLE).toBe("liquid");
  });

  for (const key of PRIOR_APPEARANCE_STORAGE_KEYS) {
    test(`only ${key} saved (no glass style) → liquid, in the app and in the boot script`, () => {
      window.localStorage.clear();
      window.localStorage.setItem(key, key.includes("opacity") ? "21" : "x");
      reloadAppearanceFromStorage();
      expect(getAppearanceState().glassStyle).toBe("liquid");
      expect(window.localStorage.getItem(GLASS_STYLE_STORAGE_KEY)).toBe(
        "liquid",
      );
      expect(bootGlass()).toBe("liquid");
    });
  }

  test("only an auto-written light/dark theme (no glass style) → mist, then stays mist after reload", () => {
    for (const theme of ["dark", "light"]) {
      window.localStorage.clear();
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
      reloadAppearanceFromStorage();
      expect(getAppearanceState().glassStyle).toBe("mist");
      expect(window.localStorage.getItem(GLASS_STYLE_STORAGE_KEY)).toBe("mist");
      expect(bootGlass()).toBe("mist");
      reloadAppearanceFromStorage();
      expect(getAppearanceState().glassStyle).toBe("mist");
      expect(bootGlass()).toBe("mist");
    }
  });

  test("a new user stays mist across three loads, even after the theme key is auto-written", () => {
    for (const load of [1, 2, 3]) {
      if (load === 2) {
        // 模拟 ThemeProvider 挂载时自动写入 chisabot-theme。
        window.localStorage.setItem(THEME_STORAGE_KEY, "light");
      }
      expect(bootGlass()).toBe("mist");
      reloadAppearanceFromStorage();
      expect(getAppearanceState().glassStyle).toBe("mist");
      expect(window.localStorage.getItem(GLASS_STYLE_STORAGE_KEY)).toBe("mist");
    }
  });

  test("a prior appearance key (no glass style) → liquid, persisted, and kept after reload", () => {
    window.localStorage.clear();
    window.localStorage.setItem(HARK_SCENE_STORAGE_KEY, "7");
    expect(bootGlass()).toBe("liquid");
    expect(window.localStorage.getItem(GLASS_STYLE_STORAGE_KEY)).toBe("liquid");
    reloadAppearanceFromStorage();
    expect(getAppearanceState().glassStyle).toBe("liquid");
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    reloadAppearanceFromStorage();
    expect(getAppearanceState().glassStyle).toBe("liquid");
    expect(bootGlass()).toBe("liquid");
  });

  test("an already stored glass style is left alone (mist / crystal / liquid)", () => {
    for (const style of ["mist", "crystal", "liquid"] as const) {
      window.localStorage.clear();
      window.localStorage.setItem(HARK_SCENE_STORAGE_KEY, "7");
      window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
      window.localStorage.setItem(GLASS_STYLE_STORAGE_KEY, style);
      reloadAppearanceFromStorage();
      expect(getAppearanceState().glassStyle).toBe(style);
      expect(bootGlass()).toBe(style);
      expect(window.localStorage.getItem(GLASS_STYLE_STORAGE_KEY)).toBe(style);
    }
  });

  test("only the haze slider saved: keeps liquid and the saved haze (QA U sliderOnly)", () => {
    window.localStorage.clear();
    window.localStorage.setItem(GLASS_OPACITY_STORAGE_KEY, "21");
    reloadAppearanceFromStorage();
    expect(getAppearanceState().glassStyle).toBe("liquid");
    expect(getAppearanceState().glassOpacity).toBe(21);
    expect(getAppearanceState().glassOpacityDark).toBe(21);
  });

  test("nothing saved at all → mist in both; an explicit saved style always wins", () => {
    reloadAppearanceFromStorage();
    expect(getAppearanceState().glassStyle).toBe("mist");
    expect(bootGlass()).toBe("mist");
    window.localStorage.setItem(GLASS_OPACITY_STORAGE_KEY, "21");
    window.localStorage.setItem(GLASS_STYLE_STORAGE_KEY, "mist");
    reloadAppearanceFromStorage();
    expect(getAppearanceState().glassStyle).toBe("mist");
    expect(bootGlass()).toBe("mist");
  });

  test("a new (mist) user who then saves any setting stays mist on the next load", () => {
    reloadAppearanceFromStorage();
    expect(getAppearanceState().glassStyle).toBe("mist");
    setGlassOpacity(30);
    flushAppearanceWrites();
    expect(window.localStorage.getItem(GLASS_STYLE_STORAGE_KEY)).toBe("mist");
    reloadAppearanceFromStorage();
    expect(getAppearanceState().glassStyle).toBe("mist");
    expect(bootGlass()).toBe("mist");
  });

  test("an old (liquid) user who saves another setting stays liquid; reset still goes to mist", () => {
    window.localStorage.clear();
    window.localStorage.setItem(HARK_SCENE_STORAGE_KEY, "7");
    reloadAppearanceFromStorage();
    setGlassOpacity(30);
    flushAppearanceWrites();
    reloadAppearanceFromStorage();
    expect(getAppearanceState().glassStyle).toBe("liquid");
    resetAppearanceDefaults();
    flushAppearanceWrites();
    reloadAppearanceFromStorage();
    expect(getAppearanceState().glassStyle).toBe("mist");
    expect(bootGlass()).toBe("mist");
  });
});

describe("haze default lives in one constant", () => {
  test("empty / blank stored haze falls back to DEFAULT_GLASS_OPACITY, not the 5% floor", () => {
    for (const raw of ["", "  "]) {
      window.localStorage.clear();
      window.localStorage.setItem(GLASS_STYLE_STORAGE_KEY, "mist");
      window.localStorage.setItem(GLASS_OPACITY_STORAGE_KEY, raw);
      window.localStorage.setItem(GLASS_OPACITY_DARK_STORAGE_KEY, raw);
      reloadAppearanceFromStorage();
      expect(getAppearanceState().glassOpacity).toBe(DEFAULT_GLASS_OPACITY);
      expect(getAppearanceState().glassOpacityDark).toBe(DEFAULT_GLASS_OPACITY);
    }
  });

  test("blank dark haze follows the saved light haze", () => {
    window.localStorage.setItem(GLASS_OPACITY_STORAGE_KEY, "30");
    window.localStorage.setItem(GLASS_OPACITY_DARK_STORAGE_KEY, "");
    reloadAppearanceFromStorage();
    expect(getAppearanceState().glassOpacityDark).toBe(30);
  });

  test("fresh state, reset and the settings dirty check all use the constant (no stray 16)", async () => {
    reloadAppearanceFromStorage();
    expect(getAppearanceState().glassOpacity).toBe(DEFAULT_GLASS_OPACITY);
    setGlassOpacity(DEFAULT_GLASS_OPACITY + 9);
    resetAppearanceDefaults();
    flushAppearanceWrites();
    expect(getAppearanceState().glassOpacity).toBe(DEFAULT_GLASS_OPACITY);
    expect(getAppearanceState().glassOpacityDark).toBe(DEFAULT_GLASS_OPACITY);
    const root = path.join(import.meta.dir, "..");
    const appearance = readFileSync(
      path.join(root, "src/lib/appearance.ts"),
      "utf8",
    );
    const prefs = readFileSync(
      path.join(root, "src/components/settings/appearance-preferences.tsx"),
      "utf8",
    );
    expect(appearance).toMatch(/export const DEFAULT_GLASS_OPACITY = \d+;/);
    expect(appearance).not.toMatch(/glassOpacity(Dark)?: 16\b/);
    expect(appearance).not.toMatch(/GLASS_OPACITY_MAX,\s*16,/);
    expect(prefs).not.toMatch(/glassOpacity(Dark)? !== 16/);
  });
});

describe("CHANGELOG", () => {
  test("glass entries stay adjacent in their release list after newer unreleased changes", () => {
    const log = readFileSync(
      path.join(import.meta.dir, "../../CHANGELOG.md"),
      "utf8",
    );
    const sections = log
      .split(/^## /m)
      .slice(1)
      .map((section) => section.slice(section.indexOf("\n") + 1).trim());
    // New Unreleased entries must not require copying already-released glass notes back.
    // Locate the unique list owning this change, then keep the same adjacency/continuity checks.
    const glassSections = sections.filter((section) =>
      section.includes("新用户与「恢复默认」的玻璃材质改为「薄雾玻璃」"),
    );
    expect(glassSections).toHaveLength(1);
    const section = glassSections[0] ?? "";
    const lines = section.split("\n");
    const firstEntry = lines.findIndex((line) => line.startsWith("- "));
    const mist = lines.findIndex((l) => l.includes("薄雾玻璃"));
    const liquid = lines.findIndex((l) => l.startsWith("- 液态玻璃"));
    expect(mist).toBeGreaterThanOrEqual(0);
    expect(liquid).toBe(mist + 1);
    expect(
      lines
        .slice(firstEntry, liquid + 1)
        .every((line) => line.startsWith("- ")),
    ).toBe(true);
  });
});

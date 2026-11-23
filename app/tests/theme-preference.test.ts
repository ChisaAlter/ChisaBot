import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  APPEARANCE_STORAGE_KEY,
  appearanceBootScript,
} from "../src/lib/palette";
import {
  applyDarkTheme,
  parseAppearanceMode,
  parseStoredDarkTheme,
  resolveDarkTheme,
  THEME_STORAGE_KEY,
} from "../src/lib/theme";

describe("theme preference", () => {
  test("only the stored dark value enables dark theme", () => {
    expect(parseStoredDarkTheme("dark")).toBe(true);
    expect(parseStoredDarkTheme("light")).toBe(false);
    expect(parseStoredDarkTheme(null)).toBe(false);
  });

  test("parses and resolves system/light/dark appearance modes", () => {
    expect(parseAppearanceMode("system")).toBe("system");
    expect(parseAppearanceMode("light")).toBe("light");
    expect(parseAppearanceMode("dark")).toBe("dark");
    expect(parseAppearanceMode(null)).toBe("system");
    expect(resolveDarkTheme("dark", false)).toBe(true);
    expect(resolveDarkTheme("light", true)).toBe(false);
    expect(resolveDarkTheme("system", true)).toBe(true);
    expect(resolveDarkTheme("system", false)).toBe(false);
  });

  test("persists and applies the selected theme", () => {
    const writes: Array<[string, string]> = [];
    const toggles: Array<[string, boolean]> = [];
    const schemes: Array<string> = [];

    applyDarkTheme(true, {
      setStoredValue: (key, value) => writes.push([key, value]),
      toggleRootClass: (name, force) => toggles.push([name, force]),
      setRootColorScheme: (scheme) => schemes.push(scheme),
    });

    expect(writes).toEqual([[THEME_STORAGE_KEY, "dark"]]);
    expect(toggles).toEqual([["dark", true]]);
    expect(schemes).toEqual(["dark"]);
  });
});

describe("pre-paint theme boot", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const boot = appearanceBootScript();

  test("index.html reserves the single pre-paint appearance boot slot in <head>", () => {
    const headEnd = html.indexOf("</head>");
    const markerIdx = html.indexOf("<!-- chisabot-appearance-boot -->");
    expect(markerIdx).toBeGreaterThan(-1);
    expect(markerIdx).toBeLessThan(headEnd);
  });

  test("the boot script reads V2 storage key and supports legacy theme key", () => {
    expect(boot).toContain(APPEARANCE_STORAGE_KEY);
    expect(boot).toContain(THEME_STORAGE_KEY);
  });

  test("the boot script applies the dark class and color scheme synchronously", () => {
    expect(boot).toContain("documentElement");
    expect(boot).toMatch(/classList\.toggle\("dark"/);
    expect(boot).toContain("colorScheme");
    expect(boot).toContain("data-theme");
    expect(boot).toContain("data-material");
    expect(boot).toContain("data-canvas");
  });
});

describe("color scheme", () => {
  const styles =
    readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8") +
    "\n" +
    readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

  test("both themes tell the browser which one they are", () => {
    expect(styles).toMatch(/:root\s*\{[\s\S]*?color-scheme:\s*light/);
    expect(styles).toMatch(/\.dark\s*\{[\s\S]*?color-scheme:\s*dark/);
  });
});

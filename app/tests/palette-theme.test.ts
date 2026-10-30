import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  computePaletteSky,
  THEME_PALETTES,
  usesPaletteGradientSky,
} from "../src/lib/appearance";

/*
 * 主题配色要真的看得出来（fix/palette-theme）：每个非 default 配色的亮色和暗色，
 * 强调色、强调浅底、毛玻璃色调、主按钮颜色、天空渐变都要和 default 不同，主按钮文字对比度 ≥ 4.5。
 */
const css = readFileSync(
  path.join(import.meta.dir, "../src/styles.css"),
  "utf8",
);

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing ${selector}`);
  const body = css.slice(start + selector.length + 2, css.indexOf("}", start));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g))
    vars[m[1]] = m[2].trim();
  return vars;
}

// default 的值（文件开头的令牌；主按钮在 :root / .dark 的 ink 令牌里，--glass-tint 在文件末尾）
const DEFAULT = {
  light: {
    "--accent-color": "#2f74f0",
    "--accent-soft": "rgba(47, 116, 240, 0.14)",
    "--ink-primary": "#15203a",
    "--glass-tint": "transparent",
  },
  dark: {
    "--accent-color": "#a1d0ff",
    "--accent-soft": "rgba(161, 208, 255, 0.16)",
    "--ink-primary": "#e9eff9",
    "--glass-tint": "transparent",
  },
} as const;

function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe("theme palettes visibly change the UI", () => {
  test("default values in the stylesheet are what this test compares against", () => {
    expect(css).toContain("--accent-color: #2f74f0;");
    expect(css).toContain("--accent-color: #a1d0ff;");
    expect(css).toContain("--ink-primary: #15203a;");
    expect(css).toContain("--ink-primary: #e9eff9;");
    expect(block(":root,\nhtml.dark")["--glass-tint"]).toBe("transparent");
  });

  for (const p of THEME_PALETTES) {
    if (p.id === "default") continue;
    for (const mode of ["light", "dark"] as const) {
      test(`${p.id} · ${mode}: key tokens differ from default and stay legible`, () => {
        const sel =
          mode === "dark"
            ? `html.dark[data-palette="${p.id}"]`
            : `html[data-palette="${p.id}"]`;
        const vars = block(sel);
        for (const key of [
          "--accent-color",
          "--accent-soft",
          "--glass-tint",
          "--ink-primary",
        ] as const) {
          expect(vars[key]).toBeTruthy();
          expect(vars[key]).not.toBe(DEFAULT[mode][key]);
        }
        // 主按钮底色 vs 按钮文字
        expect(
          contrast(vars["--ink-primary"], vars["--on-primary"]),
        ).toBeGreaterThanOrEqual(4.5);
        // 强调色当文字用：亮色在白底、暗色在深色玻璃底上
        expect(
          contrast(
            vars["--accent-color"],
            mode === "dark" ? "#141a2a" : "#ffffff",
          ),
        ).toBeGreaterThanOrEqual(4.5);
        // 和旧 token 同名的强调色也跟着变
        expect(vars["--accent-blue"]).toBe(vars["--accent-color"]);

        const sky = computePaletteSky(p.id, mode === "dark");
        expect(sky).not.toBeNull();
        const stops = [0, 1, 2, 3].map((i) => sky?.body[`--sky-${i}`]);
        // default 没有主题渐变（null，走 WebGL / #skyph 的蓝色兜底），这里每一段都是带主题色相的 hsl
        for (const s of stops) expect(s).toMatch(/^hsl\(/);
        // #skyph 读的是 <html> 上不继承限制的 --palette-sky-*
        for (let i = 0; i < 4; i++)
          expect(sky?.root[`--palette-sky-${i}`]).toBe(stops[i]);
        const hues = mode === "dark" ? p.skyHueDark : p.skyHueLight;
        const defaultMeta = THEME_PALETTES[0];
        const defaultHues =
          mode === "dark" ? defaultMeta.skyHueDark : defaultMeta.skyHueLight;
        expect(hues.some((h, i) => Math.abs(h - defaultHues[i]) >= 10)).toBe(
          true,
        );
      });
    }
  }

  test("any non-default palette uses the gradient sky instead of WebGL, smart follow on or off", () => {
    expect(computePaletteSky("default", false)).toBeNull();
    expect(usesPaletteGradientSky({ palette: "default" })).toBe(false);
    for (const p of THEME_PALETTES) {
      if (p.id === "default") continue;
      // 智能跟随（auto）、手动场景、背景随时间变化（live）都不启动 WebGL
      for (const harkScene of ["auto", "3", "live"] as const) {
        expect(
          usesPaletteGradientSky({ harkScene, palette: p.id } as {
            harkScene: string;
            palette: typeof p.id;
          }),
        ).toBe(true);
      }
    }
  });

  test("scene picker tells the user colour themes use the theme sky", () => {
    const tsx = readFileSync(
      path.join(
        import.meta.dir,
        "../src/components/settings/appearance-preferences.tsx",
      ),
      "utf8",
    );
    expect(tsx).toContain("彩色主题下使用主题天空");
  });

  test("sakura: pink dusk by day, deep purple-red night", () => {
    const sakura = THEME_PALETTES.find((p) => p.id === "sakura");
    expect(sakura).toBeTruthy();
    for (const h of sakura?.skyHueDark ?? [])
      expect(h).toBeGreaterThanOrEqual(290);
    for (const h of (sakura?.skyHueLight ?? []).slice(0, 3))
      expect(h).toBeGreaterThanOrEqual(320);
  });

  test("palette tint layer adds no blur and no :has()", () => {
    const from = css.indexOf("主题配色落到大面上");
    const tail = css.slice(css.indexOf("*/", from) + 2);
    expect(tail).not.toMatch(/blur\(/);
    expect(tail).not.toContain(":has(");
    // 大板块（左栏、右栏、输入框）的强调色是叠在 --lg-surface 上的一层 background，--lg-shadow 保持原值
    expect(tail).not.toContain("100vmax");
    expect(tail).not.toMatch(/--lg-shadow\s*:/);
    expect(css).toContain(
      "background: var(--pal-tint-layer,) var(--lg-surface) !important;",
    );
    expect(css).toContain(
      "background: var(--pal-tint-layer,) var(--lg-surface-strong) !important;",
    );
    // 叠色层只在非 default 主题下定义，default 与 main 完全相同
    expect(css).toContain(
      "--pal-tint-layer: linear-gradient(var(--glass-tint), var(--glass-tint)),;",
    );
  });
  test("default palette keeps main's hard-coded blues (fallbacks of --pal-accent)", () => {
    for (const old of [
      "var(--pal-accent, #4c8dff)",
      "var(--pal-accent, #2f7cf6)",
      "var(--pal-accent, #3b82f6)",
      "var(--pal-accent, #60a5fa)",
      "var(--pal-accent-soft, rgba(59, 130, 246, 0.14))",
      "color-mix(in srgb, var(--pal-accent, rgb(47, 124, 246)) 55%, transparent)",
      "color-mix(in srgb, var(--pal-accent, rgb(47, 124, 246)) 35%, transparent)",
    ]) {
      expect(css).toContain(old);
    }
    // --pal-accent 只在非 default 配色下定义：default / 没有 data-palette 时走回退值
    const defs = [
      ...css
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .matchAll(/([^{}]+)\{[^{}]*--pal-accent:/g),
    ].map((m) => m[1].trim());
    expect(defs).toEqual(['html[data-palette]:not([data-palette="default"])']);
    const bubbles = readFileSync(
      path.join(import.meta.dir, "../src/components/chat/bot-bubbles.tsx"),
      "utf8",
    );
    expect(bubbles.match(/text-\[var\(--pal-accent,#2563eb\)\]/g)?.length).toBe(
      2,
    );
  });
});

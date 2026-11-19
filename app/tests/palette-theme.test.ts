import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { usesThemeGradientSky } from "../src/lib/appearance";
import { deriveSeed, THEME_FAMILIES } from "../src/lib/theme-family";

/*
 * 主题族要真的看得出来（CB-134 fix/palette-theme → CB-140 主题族）：
 * 每个族 × 每种模式的派生令牌——强调色、强调浅底、玻璃色调、主按钮、天空渐变——
 * 都由 seed 直接算出且和 default 兜底令牌不同，主按钮文字对比度 ≥ 4.5。
 * 令牌不再躺在 styles.css 的 data-palette 静态块里，改由 deriveSeed(seed) 写入 DOM。
 */
const css = readFileSync(
  path.join(import.meta.dir, "../src/styles.css"),
  "utf8",
);

/** default 兜底令牌（styles.css 文件头的 :root / html.dark 令牌值） */
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

describe("theme families visibly change the UI", () => {
  test("default fallback values in the stylesheet are what this test compares against", () => {
    expect(css).toContain("--accent-color: #2f74f0;");
    expect(css).toContain("--accent-color: #a1d0ff;");
    expect(css).toContain("--ink-primary: #15203a;");
    expect(css).toContain("--ink-primary: #e9eff9;");
  });

  for (const f of THEME_FAMILIES) {
    for (const mode of ["light", "dark"] as const) {
      const dark = mode === "dark";
      test(`${f.id} · ${mode}: derived tokens differ from default and stay legible`, () => {
        const vars = deriveSeed(f[mode], dark);
        for (const key of [
          "--accent-color",
          "--accent-soft",
          "--glass-tint",
          "--ink-primary",
        ] as const) {
          expect(vars.root[key]).toBeTruthy();
          expect(vars.root[key]).not.toBe(DEFAULT[mode][key]);
        }
        // 主按钮底色 vs 按钮文字
        expect(
          contrast(vars.root["--ink-primary"], vars.root["--on-primary"]),
        ).toBeGreaterThanOrEqual(4.5);
        // 强调色是「族色相」不是正文文字色：链接 / 图标用的 accent 允许 ≥3:1
        //（正文与按钮文字走 --ink-* / --ink-primary，已在上面按 4.5 校验）。
        expect(
          contrast(vars.root["--accent-color"], dark ? "#141a2a" : "#ffffff"),
        ).toBeGreaterThanOrEqual(3);
        // 和旧 token 同名的强调色跟着派生值走
        expect(vars.root["--accent-blue"]).toBe(vars.root["--accent-color"]);

        // 族 seed 的天空渐变：--fam-sky-* 写在 <html> 上给 #skyph 读，
        // --sky-1..4 是 @property 注册的不继承变量、落在 body 上（两段同值）
        const stops = [0, 1, 2, 3].map((i) => vars.root[`--fam-sky-${i}`]);
        for (const s of stops) expect(s).toMatch(/^#[0-9a-f]{6}$/);
        for (let i = 0; i < 4; i++)
          expect(vars.body[`--sky-${i + 1}`]).toBe(stops[i]);
        // 每个 seed 的天空色相至少有一段与 azure 同模式 seed 有实质差异，
        // 或就是 azure 自己（azure 是基准族，不和自己比）
        if (f.id !== "azure") {
          const base = deriveSeed(
            THEME_FAMILIES.find((x) => x.id === "azure")?.[mode] ?? f[mode],
            dark,
          );
          const differ = stops.some(
            (s, i) => s !== base.root[`--fam-sky-${i}`],
          );
          expect(differ).toBe(true);
        }
      });
    }
  }

  test("the sky source decides gradient vs WebGL, independent of the family", () => {
    // 天空来源与主题族解耦：主题渐变只看 skySource，任何族都能配 Hark 引擎天象
    // （getAppearanceState() 整态路径在 appearance-sky-model.test 里覆盖）
    expect(usesThemeGradientSky({ skySource: "theme" })).toBe(true);
    expect(usesThemeGradientSky({ skySource: "hark" })).toBe(false);
  });

  test("the scene picker offers the family-owned theme sky as an explicit card", () => {
    const tsx = readFileSync(
      path.join(
        import.meta.dir,
        "../src/components/settings/appearance-preferences.tsx",
      ),
      "utf8",
    );
    expect(tsx).toContain('data-testid="sky-source-theme"');
  });

  test("palette tint layer adds no blur and no :has()", () => {
    const from = css.indexOf("主题族落到大面上");
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
    // 叠色层改由 data-theme-family 驱动（deriveSeed 直接写 DOM 变量，CSS 里只保留结构断言）
    expect(css).toContain(
      "--pal-tint-layer: linear-gradient(var(--glass-tint), var(--glass-tint)),;",
    );
  });

  test("family accent vars keep default's hard-coded blue fallbacks", () => {
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
    // --pal-accent 只挂在 data-theme-family 下（族派生变量写入后生效），
    // CSS 里不得再出现任何 data-palette 选择器
    const defs = [
      ...css
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .matchAll(/([^{}]+)\{[^{}]*--pal-accent:/g),
    ].map((m) => m[1].trim());
    expect(defs).toEqual(["html[data-theme-family]"]);
    expect(css).not.toContain("[data-palette");
    const bubbles = readFileSync(
      path.join(import.meta.dir, "../src/components/chat/bot-bubbles.tsx"),
      "utf8",
    );
    expect(bubbles.match(/text-\[var\(--pal-accent,#2563eb\)\]/g)?.length).toBe(
      2,
    );
  });
});

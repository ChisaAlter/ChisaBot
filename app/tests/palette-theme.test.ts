import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  deriveCustomAccentVars,
  THEMES,
} from "../src/lib/theme-family";
import {
  contrast,
  materialsCss,
  parseColor,
  SCHEMES,
  stylesCss,
  themeTokenMap,
  tokenColor,
  tokensCss,
} from "./contrast-model";

/*
 * V2 色彩主题可见性与单通道契约：
 *  - 7 套精调主题静态定义在 `app/src/styles/tokens.css`（`html[data-theme="<id>"]` + `html.dark[data-theme="<id>"]`），
 *    每套非 sky 主题的强调色、净色底色、实面底色均与默认 sky 明显区分；
 *  - 主按钮（--ink-primary vs --on-primary）与强调字色（--accent-ink）均满足 WCAG AA ≥ 4.5:1；
 *  - 自定义强调色通过 `deriveCustomAccentVars` 派生且保证浅/深均 ≥ 4.5:1；
 *  - 彻底清除历史 `[data-palette]` 与 `[data-theme-family]` 选择器，零 `:has()`。
 */

describe("7 套色彩主题在 tokens.css 中可见且可读", () => {
  test("tokens.css 保留单通道薄别名桥接且不再残留 data-palette / data-theme-family", () => {
    expect(tokensCss).toContain("--accent-color: var(--accent);");
    expect(tokensCss).toContain("--accent-blue: var(--accent);");
    expect(tokensCss).toContain("--pal-accent: var(--accent);");
    expect(tokensCss).toContain("--foreground: var(--ink-1);");
    expect(tokensCss).not.toContain("[data-palette");
    expect(tokensCss).not.toContain("data-theme-family");
    expect(materialsCss).not.toContain("[data-palette");
    expect(materialsCss).not.toContain("data-theme-family");
    expect(stylesCss).not.toContain("[data-palette");
    expect(stylesCss).not.toContain("data-theme-family");
  });

  for (const theme of THEMES) {
    for (const scheme of SCHEMES) {
      const dark = scheme === "dark";
      test(`${theme.id} · ${scheme}：主题令牌有效、主按钮与强调字 ≥ 4.5:1，且非 sky 主题可辨识`, () => {
        const tokens = themeTokenMap(theme.id, scheme, "pure");
        const skyTokens = themeTokenMap("sky", scheme, "pure");

        expect(tokens["--accent"]).toBeTruthy();
        expect(tokens["--accent-ink"]).toBeTruthy();
        expect(tokens["--canvas-pure-bg"]).toBeTruthy();
        expect(tokens["--surface-solid-panel"]).toBeTruthy();

        if (theme.id !== "sky") {
          expect(tokens["--accent"]).not.toBe(skyTokens["--accent"]);
          expect(tokens["--canvas-pure-bg"]).not.toBe(
            skyTokens["--canvas-pure-bg"],
          );
          expect(tokens["--surface-solid-panel"]).not.toBe(
            skyTokens["--surface-solid-panel"],
          );
        }

        const primaryBg = tokenColor(theme.id, scheme, "--ink-primary");
        const onPrimary = tokenColor(theme.id, scheme, "--on-primary");
        expect(contrast(primaryBg, onPrimary)).toBeGreaterThanOrEqual(4.5);

        const accentInk = tokenColor(theme.id, scheme, "--accent-ink");
        const panelSolid = tokenColor(theme.id, scheme, "--surface-solid-panel");
        expect(contrast(accentInk, panelSolid)).toBeGreaterThanOrEqual(4.5);

        // 自定义强调色派生与浅/深对比度保障
        const derived = deriveCustomAccentVars(
          dark ? theme.dark.accent : theme.light.accent,
          dark,
        );
        const surfaceRef = parseColor(dark ? "#1c222e" : "#eef2f7");
        expect(
          contrast(parseColor(derived["--accent-ink"]), surfaceRef),
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  test("外观设置页提供净色 / 动态天空 / 壁纸三选一画布切换，并保留 bot-bubbles 强调色桥接", () => {
    const prefs = readFileSync(
      path.join(
        import.meta.dir,
        "../src/components/settings/appearance-preferences.tsx",
      ),
      "utf8",
    );
    expect(prefs).toMatch(/data-testid=\{`canvas-kind-\$\{value\}`\}/);
    expect(prefs).toContain('{ value: "pure", label: "净色" }');
    expect(prefs).toContain('{ value: "sky", label: "动态天空" }');
    expect(prefs).toContain('{ value: "wallpaper", label: "壁纸" }');

    const bubbles = readFileSync(
      path.join(import.meta.dir, "../src/components/chat/bot-bubbles.tsx"),
      "utf8",
    );
    expect(bubbles.match(/text-\[var\(--pal-accent,#2563eb\)\]/g)?.length).toBe(
      2,
    );
  });

  test("materials.css 表面层零 :has()、零 !important 且无大半径 100vmax 阴影", () => {
    expect(materialsCss).not.toContain(":has(");
    expect(materialsCss).not.toContain("!important");
    expect(materialsCss).not.toContain("100vmax");
  });
});

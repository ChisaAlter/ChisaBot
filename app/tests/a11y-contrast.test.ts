import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  backdropsFor,
  blocks,
  decl,
  type ElementId,
  lastDecl,
  opaqueSurface,
  PALETTE_IDS,
  parseColor,
  range,
  SCHEMES,
  type Scheme,
  SURFACES,
  type SurfaceId,
  scrimLayers,
  scrimPainters,
  stylesCss,
  surfaceInk,
  wallpaperSurfaceBackdrops,
} from "./contrast-model";

/**
 * 模块 11 第 6 条：左栏「主机器人」分组标题、字母头像、左栏副标题，
 * 在 6 套配色 × 浅色 / 深色的每一种组合下都要 ≥ 4.5:1（WCAG AA 正文）。
 * 背景怎么叠出来见 contrast-model.ts。
 */
const AA = 4.5;

const TOKENS: Record<ElementId, { token: string; selector: string }> = {
  "sec-main": { token: "--side-sec-main-ink", selector: ".glass-sec-main" },
  sub: { token: "--side-sub-ink", selector: ".glass-item-s" },
  avatar: { token: "--avatar-ink", selector: ".glass-avatar" },
};

const TOKEN_BLOCK: Record<Scheme, string> = {
  light: ':root, [data-theme="light"]',
  dark: '.dark, [data-theme="dark"]',
};

function ink(element: ElementId, scheme: Scheme) {
  const value = lastDecl(stylesCss, TOKEN_BLOCK[scheme], TOKENS[element].token);
  if (!value) throw new Error(`${TOKENS[element].token} missing for ${scheme}`);
  return parseColor(value);
}

describe("sidebar small text and letter avatars meet WCAG AA in every palette × scheme", () => {
  test("the three elements read their color from the tokens", () => {
    for (const { token, selector } of Object.values(TOKENS)) {
      const bodies = blocks(stylesCss, selector);
      expect(bodies.length).toBeGreaterThan(0);
      expect(bodies.some((b) => decl(b, "color") === `var(${token})`)).toBe(
        true,
      );
      // 没有别的规则再给它们写死颜色（主题 / 深色变体都走令牌）。
      for (const m of stylesCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const sel = m[1].trim().replace(/\s+/g, " ");
        const subject = sel.split(",").map(
          (s) =>
            s
              .trim()
              .split(/[\s>+~]+/)
              .pop() ?? "",
        );
        if (
          !subject.some((s) => s === selector || s.startsWith(`${selector}:`))
        )
          continue;
        const color = decl(m[2], "color");
        if (color !== undefined) expect(color).toBe(`var(${token})`);
      }
      // 令牌只在浅 / 深两块里定义（增加对比度的覆盖在 a11y-modes.css）。
      const defs = [...stylesCss.matchAll(new RegExp(`${token}\\s*:`, "g"))];
      expect(defs.length).toBe(2);
    }
  });

  for (const scheme of SCHEMES)
    for (const palette of PALETTE_IDS)
      test(`${palette} / ${scheme}`, () => {
        for (const element of Object.keys(TOKENS) as ElementId[]) {
          const { min } = range(
            ink(element, scheme),
            backdropsFor(element, palette, scheme),
          );
          if (!(min >= AA))
            throw new Error(
              `${element} ${palette}/${scheme}: ${min.toFixed(2)} < ${AA}`,
            );
          expect(min).toBeGreaterThanOrEqual(AA);
        }
      });
});

describe("custom / preset wallpapers: worst case still meets WCAG AA", () => {
  for (const scheme of SCHEMES)
    for (const palette of PALETTE_IDS)
      test(`wallpaper ${palette} / ${scheme}`, () => {
        for (const element of Object.keys(TOKENS) as ElementId[]) {
          const { min } = range(
            ink(element, scheme),
            backdropsFor(element, palette, scheme, "wallpaper"),
          );
          if (!(min >= AA))
            throw new Error(
              `${element} wallpaper ${palette}/${scheme}: ${min.toFixed(2)} < ${AA}`,
            );
          expect(min).toBeGreaterThanOrEqual(AA);
        }
      });
});

describe("wallpapers: one scrim under everything", () => {
  test("only .chisabot-wallpaper::after paints a scrim; no card, bubble or composer adds its own", () => {
    expect(scrimPainters()).toEqual([".chisabot-wallpaper::after"]);
  });
  for (const id of Object.keys(SURFACES) as SurfaceId[])
    test(`${id}: exactly one scrim layer between the wallpaper and the text`, () => {
      expect(scrimLayers(id)).toBe(1);
    });
  test("a .jr-card nested in a bubble stacks glass on glass, not a second scrim", () => {
    expect(SURFACES["jr-card-in-bubble"].layers).toEqual([
      "--lg-surface-strong",
      "--lg-surface-strong",
    ]);
    expect(scrimLayers("jr-card-in-bubble")).toBe(1);
  });
  test("composer placeholder is --glass-ink-4, which wallpapers raise to --glass-ink-3", () => {
    expect(
      lastDecl(
        stylesCss,
        ".glass-composer [data-placeholder]::before, .glass-composer .is-empty::before, .glass-composer textarea::placeholder",
        "color",
      ),
    ).toBe("var(--glass-ink-4) !important");
    expect(
      lastDecl(stylesCss, 'html[data-wallpaper="on"]', "--glass-ink-4"),
    ).toBe("var(--glass-ink-3)");
    expect(lastDecl(stylesCss, 'html[data-wallpaper="on"]', "--ink-4")).toBe(
      "var(--ink-3)",
    );
  });
});

describe("wallpapers: text on the wallpaper, cards, chat bubbles, nested cards and composer meet WCAG AA", () => {
  for (const scheme of SCHEMES)
    for (const id of Object.keys(SURFACES) as SurfaceId[])
      test(`${id} / ${scheme}`, () => {
        const backdrops = wallpaperSurfaceBackdrops(id, scheme);
        for (const ink of SURFACES[id].inks) {
          const { min } = range(surfaceInk(scheme, ink), backdrops);
          if (!(min >= AA))
            throw new Error(
              `${id} ${ink} wallpaper/${scheme}: ${min.toFixed(2)} < ${AA}`,
            );
          expect(min).toBeGreaterThanOrEqual(AA);
        }
      });
});

describe("prefers-contrast: more", () => {
  const css = readFileSync(
    path.join(import.meta.dir, "../src/a11y-modes.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const block =
    css.match(/@media \(prefers-contrast: more\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const light = lastDecl(
    block,
    "html:not(#chisabot-no-blur)",
    "--side-sec-main-ink",
  );
  test("raises the sidebar heading and subtitle to ≥ 7:1 on the opaque surface", () => {
    expect(block.length).toBeGreaterThan(0);
    expect(light).toBeDefined();
    for (const scheme of SCHEMES) {
      const sel =
        scheme === "dark"
          ? "html.dark:not(#chisabot-no-blur)"
          : "html:not(#chisabot-no-blur)";
      for (const token of [
        "--side-sec-main-ink",
        "--side-sub-ink",
        "--glass-ink-3",
        "--glass-ink-4",
      ]) {
        const value = lastDecl(block, sel, token);
        expect(value).toBeDefined();
        const ratio = range(parseColor(value ?? ""), [
          opaqueSurface(scheme),
        ]).min;
        if (ratio < 7)
          throw new Error(`${token} ${scheme}: ${ratio.toFixed(2)} < 7`);
      }
    }
  });
});

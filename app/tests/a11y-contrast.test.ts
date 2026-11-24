import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  a11yModesCss,
  avatarStops,
  blocks,
  contrast,
  contrastRange,
  decl,
  extractMediaBlock,
  lastDecl,
  MATERIAL_IDS,
  parseColor,
  rowFills,
  SCHEMES,
  SURFACE_ROLES,
  scrimPainters,
  solidSurfaceColors,
  stylesCss,
  surfaceBackdrops,
  THEME_IDS,
  tokenColor,
  tokensCss,
} from "./contrast-model";

/**
 * V2 全矩阵 WCAG 对比度门禁：
 * - 6 主题 × 浅/深 × 3 材质（glass / clear / solid）× 5 表面 × 净色/极值黑白壁纸，所有墨色 ≥ 4.5:1；
 * - 墨色层级严格单调（--ink-1 > --ink-2 > --ink-3 >= --ink-4）；
 * - 侧栏小字与头像字母 ≥ 4.5:1 且统一走令牌；
 * - 全站仅 `html[data-canvas="wallpaper"] #sky-root::after` 一处画壁纸护眼薄幕；
 * - `prefers-contrast: more` 在全部实底上 ≥ 7:1（WCAG AAA）；
 * - 独立语义色 `--task-info` / `--sem-*` 永不随主题变色（DESIGN.md §127）。
 */
const AA = 4.5;
const AAA = 7.0;

describe("6 主题 × 浅/深 × 3 材质 × 净色/黑白极值壁纸 全矩阵 WCAG AA ≥ 4.5:1", () => {
  for (const themeId of THEME_IDS) {
    for (const scheme of SCHEMES) {
      test(`${themeId} / ${scheme}：全部表面与墨色在净色与黑白极值壁纸下均 ≥ 4.5:1`, () => {
        for (const material of MATERIAL_IDS) {
          for (const role of SURFACE_ROLES) {
            for (const canvas of ["pure", "wallpaper"] as const) {
              const backdrops = surfaceBackdrops(
                themeId,
                scheme,
                material,
                role,
                canvas,
              );
              expect(backdrops.length).toBeGreaterThan(0);

              // 主/次/辅/占位墨色与强调文字色全部校验
              const inkTokens =
                canvas === "wallpaper"
                  ? [
                      "--ink-1",
                      "--ink-2",
                      "--ink-3",
                      "--ink-4",
                      "--accent-ink",
                      "--side-sub-ink",
                    ]
                  : [
                      "--ink-1",
                      "--ink-2",
                      "--ink-3",
                      "--ink-4",
                      "--accent-ink",
                      "--side-sub-ink",
                    ];

              for (const tok of inkTokens) {
                const fg = tokenColor(themeId, scheme, tok, canvas);
                const { min } = contrastRange(fg, backdrops);
                if (min < AA) {
                  throw new Error(
                    `${themeId}/${scheme}/${material}/${role}/${canvas} ${tok}: ${min.toFixed(2)} < ${AA}`,
                  );
                }
                expect(min).toBeGreaterThanOrEqual(AA);
              }
            }
          }
        }
      });

      test(`${themeId} / ${scheme}：墨色层级严格单调（ink-1 > ink-2 > ink-3 >= ink-4）且主按钮 ≥ 4.5:1`, () => {
        const panelSolid = solidSurfaceColors(themeId, scheme)[0];
        expect(panelSolid).toBeDefined();
        if (!panelSolid) return;
        const c1 = contrast(tokenColor(themeId, scheme, "--ink-1"), panelSolid);
        const c2 = contrast(tokenColor(themeId, scheme, "--ink-2"), panelSolid);
        const c3 = contrast(tokenColor(themeId, scheme, "--ink-3"), panelSolid);
        const c4 = contrast(tokenColor(themeId, scheme, "--ink-4"), panelSolid);
        expect(c1).toBeGreaterThan(c2);
        expect(c2).toBeGreaterThan(c3);
        expect(c3).toBeGreaterThanOrEqual(c4);

        const primaryBg = tokenColor(themeId, scheme, "--ink-primary");
        const onPrimary = tokenColor(themeId, scheme, "--on-primary");
        expect(contrast(primaryBg, onPrimary)).toBeGreaterThanOrEqual(AA);
      });
    }
  }
});

describe("侧栏小字与字母头像令牌化及全矩阵 ≥ 4.5:1", () => {
  const SIDE_TOKENS = {
    "sec-main": { token: "--side-sec-main-ink", selector: ".glass-sec-main" },
    sub: { token: "--side-sub-ink", selector: ".glass-item-s" },
    avatar: { token: "--avatar-ink", selector: ".glass-avatar" },
  } as const;

  test("三处元素统一读取令牌且无硬编码颜色覆写", () => {
    for (const { token, selector } of Object.values(SIDE_TOKENS)) {
      const bodies = blocks(stylesCss, selector);
      expect(bodies.length).toBeGreaterThan(0);
      expect(bodies.some((b) => decl(b, "color") === `var(${token})`)).toBe(
        true,
      );
      for (const m of stylesCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const sel = (m[1] ?? "").trim().replace(/\s+/g, " ");
        const subjects = sel.split(",").map(
          (s) =>
            s
              .trim()
              .split(/[\s>+~]+/)
              .pop() ?? "",
        );
        if (
          !subjects.some((s) => s === selector || s.startsWith(`${selector}:`))
        ) {
          continue;
        }
        const color = decl(m[2] ?? "", "color");
        if (color !== undefined) expect(color).toBe(`var(${token})`);
      }
      // 在 tokens.css 中定义浅/深两版
      const defs = [...tokensCss.matchAll(new RegExp(`${token}\\s*:`, "g"))];
      expect(defs.length).toBe(2);
    }
  });

  for (const themeId of THEME_IDS) {
    for (const scheme of SCHEMES) {
      test(`${themeId} / ${scheme}：侧栏分组标题、副标题（含悬停/选中行）与头像字母 ≥ 4.5:1`, () => {
        const avatarFg = tokenColor(themeId, scheme, "--avatar-ink");
        expect(contrastRange(avatarFg, avatarStops()).min).toBeGreaterThanOrEqual(
          AA,
        );

        const secMainFg = tokenColor(themeId, scheme, "--side-sec-main-ink");
        const subFg = tokenColor(themeId, scheme, "--side-sub-ink");
        const fills = rowFills(scheme);

        for (const material of MATERIAL_IDS) {
          for (const canvas of ["pure", "wallpaper"] as const) {
            const panelBgs = surfaceBackdrops(
              themeId,
              scheme,
              material,
              "panel",
              canvas,
            );
            expect(
              contrastRange(secMainFg, panelBgs).min,
            ).toBeGreaterThanOrEqual(AA);

            const subBgs = [
              ...panelBgs,
              ...panelBgs.flatMap((bg) =>
                fills.map((r) => {
                  const a = r[3];
                  return [
                    r[0] * a + bg[0] * (1 - a),
                    r[1] * a + bg[1] * (1 - a),
                    r[2] * a + bg[2] * (1 - a),
                    1,
                  ] as [number, number, number, number];
                }),
              ),
            ];
            expect(contrastRange(subFg, subBgs).min).toBeGreaterThanOrEqual(AA);
          }
        }
      });
    }
  }
});

describe("全站唯一壁纸薄幕与壁纸下辅助字提级", () => {
  test("全站只有 html[data-canvas=\"wallpaper\"] #sky-root::after 一处画薄幕，无双层叠幕", () => {
    expect(scrimPainters()).toEqual([
      'html[data-canvas="wallpaper"] #sky-root::after',
    ]);
  });

  test("壁纸模式下 --ink-4 自动抬高到 --ink-3，输入框占位符走 --glass-ink-4 别名链", () => {
    expect(
      lastDecl(tokensCss, 'html[data-canvas="wallpaper"]', "--ink-4"),
    ).toBe("var(--ink-3)");
    expect(lastDecl(tokensCss, ":root", "--glass-ink-4")).toBe("var(--ink-4)");
    expect(
      lastDecl(
        stylesCss,
        ".glass-composer [data-placeholder]::before, .glass-composer .is-empty::before, .glass-composer textarea::placeholder",
        "color",
      ),
    ).toBe("var(--glass-ink-4) !important");
  });

  test("tasks-rail-card.css 不覆盖 .rail-sheet 背景且不含 :has()", () => {
    const tasksCss = readFileSync(
      path.join(
        import.meta.dir,
        "../src/components/panels/tasks-rail-card.css",
      ),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(tasksCss).not.toContain(".rail-sheet");
    expect(tasksCss).not.toContain(":has(");
  });
});

describe("prefers-contrast: more（高对比度模式实底全线 AAA ≥ 7:1）", () => {
  const moreBlock = extractMediaBlock(a11yModesCss, "(prefers-contrast: more)");

  test("6 主题 × 浅/深 全部实底表面下 --ink-1..4 与侧栏小字均 ≥ 7:1", () => {
    expect(moreBlock.length).toBeGreaterThan(0);
    for (const scheme of SCHEMES) {
      const sel =
        scheme === "dark"
          ? "html.dark:not(#chisabot-no-blur)"
          : "html:not(#chisabot-no-blur)";
      for (const token of [
        "--ink-1",
        "--ink-2",
        "--ink-3",
        "--ink-4",
        "--side-sec-main-ink",
        "--side-sub-ink",
      ]) {
        const raw = lastDecl(moreBlock, sel, token);
        expect(raw).toBeDefined();
        const fg = parseColor(raw ?? "");
        for (const themeId of THEME_IDS) {
          const solids = solidSurfaceColors(themeId, scheme);
          const { min } = contrastRange(fg, solids);
          if (min < AAA) {
            throw new Error(
              `prefers-contrast:more ${themeId}/${scheme} ${token}: ${min.toFixed(2)} < ${AAA}`,
            );
          }
          expect(min).toBeGreaterThanOrEqual(AAA);
        }
      }
    }
  });
});

describe("独立语义色不随色彩主题漂移（DESIGN.md §127）", () => {
  const SEMANTIC_TOKENS = [
    "--task-info",
    "--sem-success",
    "--sem-warn",
    "--sem-danger",
  ] as const;

  test("--task-info 与 --sem-* 在 6 套主题的浅/深色下保持完全一致，绝不被主题块改写", () => {
    for (const scheme of SCHEMES) {
      for (const tok of SEMANTIC_TOKENS) {
        const baseline = tokenColor("sky", scheme, tok);
        for (const themeId of THEME_IDS) {
          expect(tokenColor(themeId, scheme, tok)).toEqual(baseline);
          // 显式确认 tokens.css 里任何主题覆写块都没有声明语义色
          const themeSel =
            scheme === "dark"
              ? `html.dark[data-theme="${themeId}"]`
              : `html[data-theme="${themeId}"]`;
          expect(lastDecl(tokensCss, themeSel, tok)).toBeUndefined();
        }
      }
    }
  });
});

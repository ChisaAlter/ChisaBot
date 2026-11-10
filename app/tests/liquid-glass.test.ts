import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  alphaForContrast,
  buildDisplacementMap,
  contrast,
  decideInk,
  densityKOf,
  densityOf,
  displacementScale,
  glassComposite,
  LG_BEND_GAIN,
  LG_INK_LINE,
  LG_MAP_NEUTRAL,
  LG_MIN_SIDE,
  LG_RIM_DIV,
  LG_RIM_MAX,
  LG_RIM_MIN,
  LG_SPLIT_B,
  LG_SPLIT_R,
  LG_WORST_INK,
  over,
  rasterMeanLum,
  rimBend,
  rimWidthPx,
  sampleStats,
  satKeepOf,
  panelInkForWallpaper,
  type RGBA,
} from "../src/lib/liquid-glass";

const css = readFileSync(path.join(import.meta.dir, "../src/styles.css"), "utf8");

const flat = (v: number): RGBA => [v, v, v, 1];

describe("rim lens geometry (spec §3)", () => {
  test("rim width is min(44, short side / 3.5), never under 4px", () => {
    expect(rimWidthPx(400)).toBe(LG_RIM_MAX);
    expect(rimWidthPx(140)).toBeCloseTo(140 / LG_RIM_DIV);
    expect(rimWidthPx(10)).toBe(LG_RIM_MIN);
    expect(rimWidthPx(0)).toBe(LG_RIM_MIN);
  });

  test("bend is 1.1 × rim at the edge and eases to 0 at the rim's inner edge", () => {
    const rim = 44;
    expect(rimBend(0, rim)).toBe(0);
    expect(rimBend(rim, rim)).toBe(0);
    const nearEdge = rimBend(1, rim);
    expect(nearEdge).toBeGreaterThan(LG_BEND_GAIN * rim * 0.8);
    expect(rimBend(rim / 2, rim)).toBeLessThan(nearEdge);
    expect(displacementScale(rim)).toBe(2 * LG_BEND_GAIN * rim);
  });

  test("displacement map bends only in the rim; the middle stays neutral", () => {
    const w = 96;
    const h = 64;
    const rim = rimWidthPx(Math.min(w, h));
    const map = buildDisplacementMap(w, h, 12, rim);
    const px = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      return [map[i], map[i + 1], map[i + 2]];
    };
    // 中心平坦：R/G/B 都是 128（不动）。
    expect(px(w / 2, h / 2)).toEqual([
      LG_MAP_NEUTRAL,
      LG_MAP_NEUTRAL,
      LG_MAP_NEUTRAL,
    ]);
    // 上缘中部有弯折（向心 = 绿通道向下弯），不是 128。
    const rimPx = px(w / 2, 2);
    expect(rimPx[1]).not.toBe(LG_MAP_NEUTRAL);
    // 缘外（超出圆角矩形）不弯。
    expect(px(0, 0)).toEqual([
      LG_MAP_NEUTRAL,
      LG_MAP_NEUTRAL,
      LG_MAP_NEUTRAL,
    ]);
  });

  test("chroma split constants: red 15% further, blue 15% less", () => {
    expect(LG_SPLIT_R).toBeCloseTo(1.15);
    expect(LG_SPLIT_B).toBeCloseTo(0.85);
    expect(LG_MIN_SIDE).toBe(32);
  });
});

describe("background adaptation (spec §4)", () => {
  test("5×3 sample: drops the two darkest and two brightest, averages the rest", () => {
    const pts: RGBA[] = [
      flat(0), flat(10), // 最暗两个被丢
      flat(100), flat(110), flat(120), flat(130), flat(140), flat(150), flat(160), flat(170), flat(180), flat(190), flat(200),
      flat(250), flat(255), // 最亮两个被丢
    ];
    const s = sampleStats(pts);
    const keptMean = (100 + 110 + 120 + 130 + 140 + 150 + 160 + 170 + 180 + 190 + 200) / 11;
    expect(s.lum).toBeCloseTo(keptMean / 255, 2);
    expect(s.texture).toBeCloseTo((255 - 0) / 255, 2);
  });

  test("chroma is the mean channel spread; flat gray is 0", () => {
    expect(sampleStats([flat(128), flat(128)]).chroma).toBe(0);
    const s = sampleStats([[255, 0, 0, 1], [0, 0, 255, 1]]);
    expect(s.chroma).toBeCloseTo(1);
  });

  test("raster mean luminance averages every pixel with the same weights as sampleStats", () => {
    const black = new Uint8ClampedArray(400);
    expect(rasterMeanLum(black)).toBe(0);
    const white = new Uint8ClampedArray(400).fill(255);
    expect(rasterMeanLum(white)).toBeCloseTo(1);
    // 半黑半白 → ~0.5（半深半浅的壁纸整体算亮背景，不该触发深釉）。
    const mixed = new Uint8ClampedArray(800);
    for (let px = 0; px < 200; px++) {
      const i = px * 4;
      if (px >= 100) mixed[i] = mixed[i + 1] = mixed[i + 2] = 255;
    }
    expect(rasterMeanLum(mixed)).toBeCloseTo(0.5, 1);
    expect(rasterMeanLum(new Uint8ClampedArray(0))).toBe(0.5);
  });

  test("ink decision: light mode flips under the LG_INK_LINE boundary with ±0.05 hysteresis, dark always light-ink", () => {
    expect(decideInk("dark", 0.9, null)).toBe("dark");
    expect(decideInk("light", LG_INK_LINE - 0.06, null)).toBe("dark");
    expect(decideInk("light", 0.8, null)).toBe("light");
    // 迟滞带内保持上一次的墨，跨出迟滞带才换。
    expect(decideInk("light", LG_INK_LINE, "dark")).toBe("dark");
    expect(decideInk("light", LG_INK_LINE, "light")).toBe("light");
    expect(decideInk("light", LG_INK_LINE + 0.06, "dark")).toBe("light");
  });

  test("density and saturation keepers stay in range", () => {
    const busy = { lum: 0.5, texture: 1, chroma: 1 };
    const calm = { lum: 0.5, texture: 0, chroma: 0 };
    expect(densityOf("dark", busy)).toBeCloseTo(1);
    expect(densityOf("dark", calm)).toBeCloseTo(0.55 * 0.5);
    expect(densityKOf(0)).toBeCloseTo(0.7);
    expect(densityKOf(1)).toBeCloseTo(1.3);
    expect(satKeepOf(0)).toBe(1);
    expect(satKeepOf(1)).toBeCloseTo(0.45);
  });
});

describe("density boost keeps text at AA (spec §6)", () => {
  test("alphaForContrast returns base when it already passes, else the minimal alpha that reaches 4.5", () => {
    // 深釉档实际会遇到的亮度（lum≈0.47，decideInk 判 dark-under）：能升到 4.5。
    const midBg = flat(120);
    const opts = {
      bg: midBg,
      tintRGB: [16, 18, 22] as [number, number, number],
      hlAlpha: 0.08,
      ink: "dark" as const,
      inkColor: LG_WORST_INK.dark,
    };
    // 中亮底色上低 alpha 的暗釉不够 → 升到 4.5 达标的最小值（深釉档上限 0.95）。
    const needed = alphaForContrast({ ...opts, base: 0.1, max: 0.95 });
    expect(needed).toBeGreaterThan(0.1);
    const surface = glassComposite([16, 18, 22, needed], 0.08, midBg);
    expect(
      contrast(over(LG_WORST_INK.dark, surface), surface),
    ).toBeGreaterThanOrEqual(4.5 - 0.02);
    // 已经够 → 原样返回。
    expect(alphaForContrast({ ...opts, base: 0.9 })).toBe(0.9);
  });

  test("on a mid-luminance background the boost still lands the dimmest ink at AA", () => {
    const midBg = flat(140);
    const a = alphaForContrast({
      bg: midBg,
      tintRGB: [255, 255, 255],
      hlAlpha: 0.3,
      ink: "light",
      base: 0.16,
      inkColor: LG_WORST_INK.light,
    });
    const surface = glassComposite([255, 255, 255, a], 0.3, midBg);
    expect(contrast(over(LG_WORST_INK.light, surface), surface)).toBeGreaterThanOrEqual(
      4.5 - 0.02,
    );
  });

  test("impossible backgrounds cap at max instead of looping", () => {
    const a = alphaForContrast({
      bg: flat(128),
      tintRGB: [128, 128, 128],
      hlAlpha: 0,
      ink: "dark",
      base: 0.2,
      max: 0.5,
      inkColor: LG_WORST_INK.dark,
    });
    expect(a).toBeLessThanOrEqual(0.5);
  });
});

describe("material tokens in styles.css", () => {
  test("the lens URL sits at the end of the liquid filter chain", () => {
    expect(css).toMatch(
      /--lg-blur:\s*blur\(2px\) saturate\(calc\(180% \* var\(--lg-sat-keep\)\)\) brightness\(var\(--lg-bright\)\) var\(--lg-lens-url,/,
    );
  });

  test("ink, tint and edge tokens are registered as animatable properties", () => {
    for (const name of [
      "--lg-tint-a",
      "--lg-density-k",
      "--lg-aa-boost",
      "--lg-hover-a",
      "--lg-hl",
      "--lg-bright",
      "--lg-sat-keep",
      "--lg-ink",
      "--lg-ink-2",
    ]) {
      expect(css).toMatch(
        new RegExp(`@property ${name.replace("-", "\\-")} \\{[^}]*inherits: false;`),
      );
    }
  });

  test("the dark-under state flip rule exists for every glass surface", () => {
    expect(css).toContain('[data-lg-ink="dark"]');
    expect(css).toMatch(/data-lg-ink="dark"\]\s*\{[\s\S]*--lg-tint-rgb: 16 18 22/);
  });
});

describe("uniform panel ink (no mixed light/dark modules)", () => {
  test("light scheme stays light on a bright wallpaper", () => {
    expect(panelInkForWallpaper("light", false)).toBe("light");
  });
  test("light scheme flips the whole screen together on a dark wallpaper", () => {
    expect(panelInkForWallpaper("light", true)).toBe("dark");
  });
  test("dark scheme is always dark glaze", () => {
    expect(panelInkForWallpaper("dark", false)).toBe("dark");
    expect(panelInkForWallpaper("dark", true)).toBe("dark");
  });
  test("liquid CSS no longer treats unset data-glass as liquid", () => {
    expect(css).not.toMatch(
      /:where\(html\[data-glass="liquid"\],\s*html:not\(\[data-glass\]\)\)/,
    );
    expect(css).toMatch(
      /:where\(html\[data-glass="mist"\],\s*html:not\(\[data-glass\]\)\)/,
    );
  });
  test("liquidActive source only matches liquid, not null", () => {
    const src = readFileSync(
      path.join(import.meta.dir, "../src/lib/liquid-glass.ts"),
      "utf8",
    );
    expect(src).toMatch(
      /function liquidActive\(\)[^{]*\{[^}]*getAttribute\("data-glass"\) === "liquid"/s,
    );
    expect(src).not.toMatch(/glass === null \|\| glass === "liquid"/);
  });
});

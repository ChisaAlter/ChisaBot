/**
 * 左栏小字和头像字母的 WCAG 对比度模型（模块 11 第 6 条，tests/a11y-contrast.test.ts 用）。
 *
 * 不跑浏览器，只用 styles.css / perf-noblur.css 里的真实令牌和 lib/appearance.ts 的配色天空，
 * 把文字背后的每一层按 alpha 叠出来，再算 WCAG 2.x 对比度：
 *
 *   天空（默认配色读 #skyph 的回落色，其他配色读 computePaletteSky 的 4 个色标）
 *   → 天幕薄纱 #sky-root::after（按同一高度插值）
 *   → 左栏卡片的玻璃 --lg-surface（3 种材质 × 雾度 5% / 55%，取渐变起点：文字在卡片左上）
 *     或不透明底色 --glass-bg-opaque（性能模式 / 减少透明度 / 增加对比度）
 *   → 机器人行的悬停 / 选中底色（只对副标题）
 *
 * 结果是每个元素在每种「配色 × 浅 / 深」下的最小 / 最大对比度。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  computePaletteSky,
  THEME_PALETTES,
  type ThemePaletteId,
} from "../src/lib/appearance";

export type RGBA = [number, number, number, number];

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
export const stylesCss = strip(
  readFileSync(path.join(import.meta.dir, "../src/styles.css"), "utf8"),
);
export const noblurCss = strip(
  readFileSync(path.join(import.meta.dir, "../src/perf-noblur.css"), "utf8"),
);

/** 选择器完全等于 selector 的所有规则体（不在 @media 里的也好、在里面的也好都算）。 */
const norm = (s: string) => s.trim().replace(/\s+/g, " ");
const ruleCache = new Map<string, Map<string, string[]>>();
export function blocks(css: string, selector: string): string[] {
  let bySelector = ruleCache.get(css);
  if (!bySelector) {
    bySelector = new Map();
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const key = norm(m[1]);
      bySelector.set(key, [...(bySelector.get(key) ?? []), m[2]]);
    }
    ruleCache.set(css, bySelector);
  }
  return bySelector.get(norm(selector)) ?? [];
}

/** 规则体里某个声明的值（取最后一个）。 */
export function decl(body: string, name: string): string | undefined {
  const re = new RegExp(
    `(?:^|[;\\s])${name.replace(/[-]/g, "\\-")}\\s*:\\s*([^;]+);`,
    "g",
  );
  let value: string | undefined;
  for (const m of body.matchAll(re)) value = m[1].trim();
  return value;
}

/** 选择器为 selector 的最后一条规则里 name 的值。 */
export function lastDecl(
  css: string,
  selector: string,
  name: string,
): string | undefined {
  let value: string | undefined;
  for (const body of blocks(css, selector)) value = decl(body, name) ?? value;
  return value;
}

function hsl(h: number, s: number, l: number): RGBA {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) =>
    light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255, 1];
}

/** #rrggbb、rgb()/rgba()、hsl(h s% l%)。alpha 里允许是数字。 */
export function parseColor(value: string): RGBA {
  const v = value.trim();
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const h = v.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/);
  if (h) return hsl(Number(h[1]), Number(h[2]), Number(h[3]));
  const rgb = v.match(/^rgba?\(([^)]*)\)$/);
  if (rgb) {
    const parts = rgb[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length >= 3 && parts.every((x) => Number.isFinite(x)))
      return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  throw new Error(`unsupported color: ${value}`);
}

/** top 叠在不透明的 bottom 上。 */
export function over(top: RGBA, bottom: RGBA): RGBA {
  const a = top[3];
  return [
    top[0] * a + bottom[0] * (1 - a),
    top[1] * a + bottom[1] * (1 - a),
    top[2] * a + bottom[2] * (1 - a),
    1,
  ];
}

const mix = (a: RGBA, b: RGBA, t: number): RGBA =>
  a.map((x, i) => x + (b[i] - x) * t) as RGBA;

export function luminance(c: RGBA): number {
  const ch = (x: number) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
}

export function contrast(a: RGBA, b: RGBA): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

type Stop = { at: number; color: RGBA };

/** linear-gradient(...) 里带百分比位置的色标。 */
function gradientStops(value: string): Stop[] {
  const stops: Stop[] = [];
  for (const m of value.matchAll(
    /(rgba?\([^)]*\)|#[0-9a-f]{6}|var\(--[\w-]+,\s*#[0-9a-f]{6}\))\s+([\d.]+)%/gi,
  )) {
    const raw = m[1].startsWith("var(")
      ? (m[1].match(/#[0-9a-f]{6}/i)?.[0] ?? "")
      : m[1];
    stops.push({ at: Number(m[2]), color: parseColor(raw) });
  }
  return stops;
}

function sample(stops: Stop[], at: number): RGBA {
  if (at <= stops[0].at) return stops[0].color;
  for (let i = 1; i < stops.length; i++) {
    if (at <= stops[i].at) {
      const a = stops[i - 1];
      const b = stops[i];
      return mix(a.color, b.color, (at - a.at) / (b.at - a.at));
    }
  }
  return stops[stops.length - 1].color;
}

export type Scheme = "light" | "dark";
export const SCHEMES: Scheme[] = ["light", "dark"];
export const GLASS_STYLES = ["liquid", "crystal", "frosted"] as const;
/** lib/appearance.ts 存储 / 校验的雾度范围（clampNumber(…, 5, 55, …)）。 */
export const HAZE_RANGE = [0.05, 0.55] as const;

/** 天空：带高度位置的 4 个色标。 */
export function skyStops(palette: ThemePaletteId, scheme: Scheme): Stop[] {
  const sel =
    scheme === "dark"
      ? 'html.dark #sky-root #skyph, html[data-theme="dark"] #sky-root #skyph'
      : "#sky-root #skyph";
  const placeholder = gradientStops(
    lastDecl(stylesCss, sel, "background") ?? "",
  );
  if (placeholder.length !== 4) throw new Error(`#skyph stops for ${scheme}`);
  const sky = computePaletteSky(palette, scheme === "dark");
  if (!sky) return placeholder;
  return placeholder.map((p, i) => ({
    at: p.at,
    color: parseColor(sky.body[`--sky-${i}`]),
  }));
}

/** 天幕薄纱 #sky-root::after。 */
export function veilStops(scheme: Scheme): Stop[] {
  const sel =
    scheme === "dark"
      ? 'html.dark #sky-root::after, html[data-theme="dark"] #sky-root::after'
      : "html:not(.dark) #sky-root::after";
  const stops = gradientStops(lastDecl(stylesCss, sel, "background") ?? "");
  if (stops.length < 2) throw new Error(`veil stops for ${scheme}`);
  return stops;
}

/** 玻璃材质 --lg-surface 渐变起点在某个雾度下的颜色。 */
export function glassSurface(
  style: (typeof GLASS_STYLES)[number],
  scheme: Scheme,
  haze: number,
): RGBA {
  const selectors: Record<string, string> = {
    "liquid-light": ':root, html[data-glass="liquid"]',
    "liquid-dark": 'html.dark, html.dark[data-glass="liquid"]',
    "crystal-light": 'html[data-glass="crystal"]',
    "crystal-dark": 'html.dark[data-glass="crystal"]',
    "frosted-light": 'html[data-glass="frosted"]',
    "frosted-dark": 'html.dark[data-glass="frosted"]',
  };
  const value = lastDecl(
    stylesCss,
    selectors[`${style}-${scheme}`],
    "--lg-surface",
  );
  const first = value?.match(
    /rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*clamp\(\s*([\d.]+),\s*calc\(var\(--lg-alpha,\s*[\d.]+\)\s*\*\s*([\d.]+)\),\s*([\d.]+)\)\)/,
  );
  if (!first) throw new Error(`--lg-surface for ${style}/${scheme}`);
  const [, r, g, b, lo, k, hi] = first.map(Number);
  const alpha = Math.min(hi, Math.max(lo, haze * k));
  return [r, g, b, alpha];
}

/** 不透明玻璃底色（perf-noblur.css）。 */
export function opaqueSurface(scheme: Scheme): RGBA {
  const value = lastDecl(
    noblurCss,
    scheme === "dark" ? "html.dark" : "html",
    "--glass-bg-opaque",
  );
  if (!value) throw new Error(`--glass-bg-opaque for ${scheme}`);
  return parseColor(value);
}

/** 机器人行悬停 / 选中的底色（选中是渐变，取所有色标）。 */
export function rowFills(scheme: Scheme): RGBA[] {
  const d = scheme === "dark" ? ".dark " : "";
  const hover = lastDecl(stylesCss, `${d}.glass-bot-row:hover`, "background");
  const on = lastDecl(stylesCss, `${d}.glass-bot-row.is-on`, "background");
  if (!hover || !on) throw new Error(`row fills for ${scheme}`);
  const onStops = [...on.matchAll(/rgba\([^)]*\)/g)].map((m) =>
    parseColor(m[0]),
  );
  return [parseColor(hover), ...onStops];
}

/** 左栏卡片上文字背后所有可能的不透明底色。 */
export function panelBackdrops(
  palette: ThemePaletteId,
  scheme: Scheme,
): RGBA[] {
  const sky = skyStops(palette, scheme);
  const veil = veilStops(scheme);
  const out: RGBA[] = [opaqueSurface(scheme)];
  for (const stop of sky) {
    const base = over(sample(veil, stop.at), stop.color);
    for (const style of GLASS_STYLES)
      for (const haze of HAZE_RANGE)
        out.push(over(glassSurface(style, scheme, haze), base));
  }
  return out;
}

/** 字母头像的渐变底色（不透明）。 */
export function avatarStops(): RGBA[] {
  const bg = lastDecl(stylesCss, ".glass-avatar", "background") ?? "";
  const stops = [...bg.matchAll(/#[0-9a-f]{6}/gi)].map((m) => parseColor(m[0]));
  if (stops.length < 2) throw new Error("avatar gradient");
  // 渐变中点也算（两端之间的颜色）。
  return [...stops, mix(stops[0], stops[stops.length - 1], 0.5)];
}

export type ElementId = "sec-main" | "sub" | "avatar";

export function backdropsFor(
  element: ElementId,
  palette: ThemePaletteId,
  scheme: Scheme,
): RGBA[] {
  if (element === "avatar") return avatarStops();
  const panel = panelBackdrops(palette, scheme);
  if (element === "sec-main") return panel;
  const rows = rowFills(scheme);
  return [...panel, ...panel.flatMap((b) => rows.map((r) => over(r, b)))];
}

export function range(
  text: RGBA,
  backdrops: RGBA[],
): { min: number; max: number } {
  const values = backdrops.map((b) => contrast(over(text, b), b));
  return { min: Math.min(...values), max: Math.max(...values) };
}

export const PALETTE_IDS = THEME_PALETTES.map((p) => p.id);

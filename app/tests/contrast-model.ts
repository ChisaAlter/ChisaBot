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
 * 自定义壁纸 / 预设壁纸时，天空换成壁纸图（.chisabot-wallpaper，z-index 1，在薄纱下面）：
 *   壁纸像素（纯白、纯黑、所有预设 SVG 里出现的色标，按不透明算，偏保守）
 *   → 压暗遮罩 .chisabot-wallpaper-dim（两个色标 × 不透明度 0 / 0.75，即 wallpaperDim 存储范围 0–75）
 *   → 壁纸薄幕 .chisabot-wallpaper::after（--wallpaper-scrim，整个界面只有这一层，卡片 / 气泡 / 输入框不再各自垫）
 *   → 天幕薄纱 → 每层玻璃（或不透明底色）→ 行底色。
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
import {
  alphaForContrast,
  decideInk,
  LG_WORST_INK,
} from "../src/lib/liquid-glass";

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
export const GLASS_STYLES = ["liquid", "mist", "crystal", "frosted"] as const;
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

/**
 * 三档玻璃的材质规则（c74d5567 起）：`--lg-*` 不再挂在根上，而是按「材质 × 深浅」写在
 * `:where(<html 作用域>) :where(<读变量的元素名单>) { --lg-surface: … }` 里。元素名单会跟着
 * 样式表变（theme-glass-perf 守它和 GLASS_SURFACE_SELECTOR 一致），这里只认外层那一节 :where。
 */
const GLASS_SCOPE: Record<string, RegExp> = {
  "liquid-light": /^:where\(html\[data-glass="liquid"\]\)/,
  "liquid-dark": /^:where\(html\.dark\[data-glass="liquid"\]\)/,
  "crystal-light": /^:where\(html\[data-glass="crystal"\]\)/,
  "crystal-dark": /^:where\(html\.dark\[data-glass="crystal"\]\)/,
  "frosted-light": /^:where\(html\[data-glass="frosted"\]\)/,
  "frosted-dark": /^:where\(html\.dark\[data-glass="frosted"\]\)/,
  "mist-light":
    /^:where\(html\[data-glass="mist"\], html:not\(\[data-glass\]\)\)/,
  "mist-dark":
    /^:where\(html\.dark\[data-glass="mist"\], html\.dark:not\(\[data-glass\]\)\)/,
};

/** 某档材质某个 scheme 的材质规则里 token 的值（取最后一条命中的规则）。 */
const glassDeclCache = new Map<string, string | undefined>();
function glassDecl(
  token: string,
  style: (typeof GLASS_STYLES)[number],
  scheme: Scheme,
): string | undefined {
  const key = `${token}|${style}|${scheme}`;
  const hit = glassDeclCache.get(key);
  if (hit !== undefined || glassDeclCache.has(key)) return hit;
  const scope = GLASS_SCOPE[`${style}-${scheme}`];
  let value: string | undefined;
  for (const m of stylesCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (scope.test(norm(m[1]))) value = decl(m[2], token) ?? value;
  }
  glassDeclCache.set(key, value);
  return value;
}

/**
 * 液态玻璃材质规则里解析出来的参数：
 * --lg-tint-rgb 基色 + --lg-tint-a 的 clamp(lo, alpha × 各标量, hi) 公式 + 内光 --lg-hl。
 * data-lg-ink="dark" 的深釉档参数写死在 lib/liquid-glass.ts 的材质规则里，这里同写一份
 * （applyAdapt 的 mul 1.4、lo 0.1、hl 0.08 见 styles.css data-lg-ink 规则）。
 */
interface LiquidMaterial {
  tintRGB: [number, number, number];
  lo: number;
  hi: number;
  mul: number;
  hl: number;
}
const liquidMaterialCache = new Map<Scheme, LiquidMaterial>();
export function liquidMaterial(scheme: Scheme): LiquidMaterial {
  const cached = liquidMaterialCache.get(scheme);
  if (cached) return cached;
  const rgb = (glassDecl("--lg-tint-rgb", "liquid", scheme) ?? "")
    .trim()
    .split(/\s+/)
    .map(Number);
  const ta = glassDecl("--lg-tint-a", "liquid", scheme) ?? "";
  const m =
    /clamp\(\s*var\(--lg-tint-lo\)\s*,\s*calc\(var\(--lg-alpha,\s*([\d.]+)\)((?:\s*\*\s*var\(--[\w-]+(?:,\s*[\d.]+)?\))*)\)\s*,\s*var\(--lg-tint-hi\)\s*\)/.exec(
      ta,
    );
  const lo = Number.parseFloat(
    glassDecl("--lg-tint-lo", "liquid", scheme) ?? "",
  );
  const hi = Number.parseFloat(
    glassDecl("--lg-tint-hi", "liquid", scheme) ?? "",
  );
  if (!m || !Number.isFinite(lo) || !Number.isFinite(hi) || rgb.length < 3 || rgb.some((n) => !Number.isFinite(n)))
    throw new Error(`liquid material for ${scheme}`);
  // 公式里除了 --lg-alpha 以外的标量因子（--lg-tint-mul / --lg-density-k / …）：
  // var 带 fallback 用 fallback，否则读同规则里声明的默认值（都是 1）。
  let mul = 1;
  for (const f of m[2].matchAll(
    /\*\s*var\(--([\w-]+)(?:,\s*([\d.]+))?\)/g,
  )) {
    const fb = Number(f[2]);
    mul *= Number.isFinite(fb)
      ? fb
      : (Number.parseFloat(glassDecl(`--${f[1]}`, "liquid", scheme) ?? "") || 1);
  }
  const hl = Number.parseFloat(glassDecl("--lg-hl", "liquid", scheme) ?? "0");
  const mat = {
    tintRGB: [rgb[0], rgb[1], rgb[2]] as [number, number, number],
    lo,
    hi,
    mul,
    hl: Number.isFinite(hl) ? hl : 0,
  };
  liquidMaterialCache.set(scheme, mat);
  return mat;
}

/** 采样用的亮度（weighted sRGB，与 lib/liquid-glass.ts 的 sampleStats 同公式）。 */
const bgLum = (c: RGBA) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;

/** 一行底色的判定结果：底色合成后的不透明色 + 字该用哪个 scheme 的墨色。 */
export interface Backdrop {
  bg: RGBA;
  inkScheme: Scheme;
}

/**
 * 液态玻璃在某个底色上的自适应合成（和 lib/liquid-glass.ts applyAdapt 同一份判定）：
 * 浅色档按亮度决定浅釉深墨 / 深釉浅墨，密度系数取两端（0.7 / 1.3 覆盖整个密度区间），
 * 釉色不够对比时按「升密度」求到 4.5——alphaForContrast 就是产品里跑的那一份。
 */
function liquidComposite(
  base: RGBA,
  scheme: Scheme,
  haze: number,
  strong: boolean,
): Backdrop[] {
  const mat = liquidMaterial(scheme);
  const ink = decideInk(scheme, bgLum(base), null);
  const under = scheme === "light" && ink === "dark";
  const tintRGB: [number, number, number] = under
    ? [16, 18, 22]
    : mat.tintRGB;
  const lo = under ? 0.1 : mat.lo;
  const mul = under ? 1.4 : mat.mul;
  const hl = under ? 0.08 : mat.hl;
  const hi = under ? 0.95 : mat.hi;
  const out: Backdrop[] = [];
  for (const dk of [0.7, 1.3]) {
    const raw = Math.min(hi, Math.max(lo, haze * mul * dk));
    const boost = alphaForContrast({
      bg: base,
      tintRGB,
      hlAlpha: hl,
      ink,
      base: raw,
      max: hi,
      inkColor: LG_WORST_INK[ink],
    });
    const alpha = Math.min(boost * (strong ? 1.4 : 1), 0.9);
    const surf = over(
      [255, 255, 255, hl],
      [tintRGB[0], tintRGB[1], tintRGB[2], alpha],
    );
    out.push({ bg: over(surf, base), inkScheme: ink === "dark" ? "dark" : "light" });
  }
  return out;
}

/** 非液态材质的玻璃面（mist / crystal / frosted，不自适应）：渐变色标照旧解析。 */
function glassSurface(
  style: (typeof GLASS_STYLES)[number],
  scheme: Scheme,
  haze: number,
): RGBA {
  const value = glassDecl("--lg-surface", style, scheme);
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

/** 左栏卡片上文字背后所有可能的不透明底色（液态玻璃按底色自适应出合成结果）。 */
export function panelBackdrops(
  palette: ThemePaletteId,
  scheme: Scheme,
): Backdrop[] {
  const sky = skyStops(palette, scheme);
  const veil = veilStops(scheme);
  const out: Backdrop[] = [{ bg: opaqueSurface(scheme), inkScheme: scheme }];
  for (const stop of sky) {
    const base = over(sample(veil, stop.at), stop.color);
    for (const style of GLASS_STYLES)
      for (const haze of HAZE_RANGE) {
        if (style === "liquid") {
          out.push(...liquidComposite(base, scheme, haze, false));
        } else {
          out.push({
            bg: over(glassSurface(style, scheme, haze), base),
            inkScheme: scheme,
          });
        }
      }
  }
  return out;
}

/** 壁纸压暗遮罩 .chisabot-wallpaper-dim 的色标。 */
export function wallpaperDimStops(scheme: Scheme): RGBA[] {
  const sel =
    scheme === "dark"
      ? ".chisabot-wallpaper-dim"
      : "html:not(.dark) .chisabot-wallpaper-dim";
  const value = lastDecl(stylesCss, sel, "background") ?? "";
  const stops = [...value.matchAll(/rgba\([^)]*\)/g)].map((m) =>
    parseColor(m[0]),
  );
  if (stops.length < 2) throw new Error(`wallpaper dim stops for ${scheme}`);
  return stops;
}

/** lib/appearance.ts 存储的 wallpaperDim 范围（clampNumber(…, 0, 75, …)），换成遮罩不透明度。 */
export const WALLPAPER_DIM_RANGE = [0, 0.75] as const;

/** 壁纸可能出现的像素：纯白、纯黑（自定义上传的两个极端）+ 预设 SVG 里的所有色标。 */
export function wallpaperPixels(): RGBA[] {
  const src = readFileSync(
    path.join(import.meta.dir, "../src/lib/appearance.ts"),
    "utf8",
  );
  const presets = new Set(
    [...src.matchAll(/stop-color="(#[0-9a-f]{6})"/gi)].map((m) =>
      m[1].toLowerCase(),
    ),
  );
  return [
    [255, 255, 255, 1],
    [0, 0, 0, 1],
    ...[...presets].map((c) => parseColor(c)),
  ];
}

/**
 * 壁纸薄幕：.chisabot-wallpaper::after 画 --wallpaper-scrim，夹在压暗遮罩和天幕薄纱之间，
 * 整个界面只有这一层（卡片、气泡、输入框不再各自垫）。
 */
export function wallpaperScrim(scheme: Scheme): RGBA {
  const paint = lastDecl(stylesCss, ".chisabot-wallpaper::after", "background");
  if (paint !== "var(--wallpaper-scrim)")
    throw new Error(
      ".chisabot-wallpaper::after does not paint --wallpaper-scrim",
    );
  const value = lastDecl(
    stylesCss,
    scheme === "dark" ? 'html.dark, html[data-theme="dark"]' : ":root",
    "--wallpaper-scrim",
  );
  if (!value) throw new Error(`--wallpaper-scrim for ${scheme}`);
  return parseColor(value);
}

/** 壁纸 → 压暗遮罩 → 壁纸薄幕 → 天幕薄纱 叠好后的所有不透明底色（直接落在壁纸上的字就在它上面）。 */
export function wallpaperBases(scheme: Scheme): RGBA[] {
  const veil = veilStops(scheme);
  const scrim = wallpaperScrim(scheme);
  const out: RGBA[] = [];
  for (const px of wallpaperPixels())
    for (const dim of wallpaperDimStops(scheme))
      for (const opacity of WALLPAPER_DIM_RANGE) {
        const dimmed = over([dim[0], dim[1], dim[2], dim[3] * opacity], px);
        const scrimmed = over(scrim, dimmed);
        for (const v of veil) out.push(over(v.color, scrimmed));
      }
  return out;
}

/** 壁纸模式下左栏卡片上文字背后所有可能的不透明底色。 */
export function wallpaperPanelBackdrops(scheme: Scheme): Backdrop[] {
  const out: Backdrop[] = [{ bg: opaqueSurface(scheme), inkScheme: scheme }];
  for (const base of wallpaperBases(scheme))
    for (const style of GLASS_STYLES)
      for (const haze of HAZE_RANGE) {
        if (style === "liquid") {
          out.push(...liquidComposite(base, scheme, haze, false));
        } else {
          out.push({
            bg: over(glassSurface(style, scheme, haze), base),
            inkScheme: scheme,
          });
        }
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
  surface: "sky" | "wallpaper" = "sky",
): Backdrop[] {
  if (element === "avatar")
    return avatarStops().map((bg) => ({ bg, inkScheme: scheme }));
  const panel =
    surface === "wallpaper"
      ? wallpaperPanelBackdrops(scheme)
      : panelBackdrops(palette, scheme);
  if (element === "sec-main") return panel;
  // 行底色跟着墨的档走：深釉浅墨档（inkScheme=dark 的翻转条目）用深色行底。
  return [
    ...panel,
    ...panel.flatMap(({ bg, inkScheme }) =>
      rowFills(inkScheme).map((r) => ({ bg: over(r, bg), inkScheme })),
    ),
  ];
}

export function range(
  text: RGBA,
  backdrops: RGBA[],
): { min: number; max: number } {
  const values = backdrops.map((b) => contrast(over(text, b), b));
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** 自适应底色：每条底色的墨按它自己的 inkScheme 取（深釉档翻成深色墨色）。 */
export function rangeAdaptive(
  textFor: (inkScheme: Scheme) => RGBA,
  backdrops: Backdrop[],
): { min: number; max: number } {
  const values = backdrops.map(({ bg, inkScheme }) => {
    const text = textFor(inkScheme);
    return contrast(over(text, bg), bg);
  });
  return { min: Math.min(...values), max: Math.max(...values) };
}

export const PALETTE_IDS = THEME_PALETTES.map((p) => p.id);

/* ---------- 壁纸下的其他面板和主区（#420 审查第二轮） ---------- */

const ROOT_BLOCK: Record<Scheme, string> = {
  light: ':root, [data-theme="light"]',
  dark: '.dark, [data-theme="dark"]',
};

/** 文字令牌的最终值：先找深 / 浅色令牌块，没有就退回浅色块；var() 递归展开。 */
export function tokenColor(scheme: Scheme, token: string): RGBA {
  const raw =
    lastDecl(stylesCss, ROOT_BLOCK[scheme], token) ??
    lastDecl(stylesCss, ROOT_BLOCK.light, token);
  if (!raw) throw new Error(`${token} missing for ${scheme}`);
  const ref = raw.match(/^var\((--[\w-]+)(?:,\s*([^)]+))?\)$/);
  if (ref) return tokenColor(scheme, ref[1]);
  return parseColor(raw);
}

/** --lg-surface / --lg-surface-strong 渐变的全部色标（文字可能落在任何位置；只用于非液态材质）。 */
export function glassStops(
  token: "--lg-surface" | "--lg-surface-strong",
  style: (typeof GLASS_STYLES)[number],
  scheme: Scheme,
  haze: number,
): RGBA[] {
  if (style === "liquid") throw new Error("liquid uses liquidComposite");
  const value = glassDecl(token, style, scheme);
  const stops = [
    ...(value ?? "").matchAll(
      /rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*clamp\(\s*([\d.]+),\s*calc\(var\(--lg-alpha,\s*[\d.]+\)\s*\*\s*([\d.]+)\),\s*([\d.]+)\)\)/g,
    ),
  ].map((m) => {
    const [, r, g, b, lo, k, hi] = m.map(Number);
    return [r, g, b, Math.min(hi, Math.max(lo, haze * k))] as RGBA;
  });
  if (stops.length < 2) throw new Error(`${token} for ${style}/${scheme}`);
  return stops;
}

/** 某个选择器上的半透明底色令牌（如 --bubble-user-bg）。 */
function fillToken(scheme: Scheme, token: string): RGBA {
  const sel =
    scheme === "dark"
      ? 'html.dark, html[data-theme="dark"]'
      : 'html:root, html[data-theme="light"]';
  const raw =
    lastDecl(stylesCss, sel, token) ??
    lastDecl(stylesCss, ROOT_BLOCK[scheme], token);
  if (!raw) throw new Error(`${token} for ${scheme}`);
  return parseColor(raw);
}

export type SurfaceId =
  | "on-wallpaper"
  | "acct-card"
  | "mini-card"
  | "rail-card"
  | "bubble-assistant"
  | "jr-card"
  | "jr-card-in-bubble"
  | "bubble-user"
  | "composer";

type Layer = "--lg-surface" | "--lg-surface-strong" | "--bubble-user-bg";

/** 左栏 / 账号卡 / 收起态左栏 / 右栏容器共用的那条玻璃规则（styles.css 里原样的选择器）。 */
const SIDE_RULE =
  ":is(.glass-side-card, .acct-card, .acct-mini-card, .glass-mini-card, .rail-card)";
/** 机器人气泡和对话内嵌卡片共用的玻璃规则。 */
const BUBBLE_CARD_RULE =
  '.glass-main [data-slot="message"][data-align="start"] [data-slot="bubble"][data-variant="ghost"] > [data-slot="bubble-content"], .jr-card';
const COMPOSER_RULE =
  ".glass-composer, .dark .glass-composer, .glass-composer:focus-within, .dark .glass-composer:focus-within";

/**
 * 壁纸上的每种文字位置：文字令牌 + 从壁纸往上叠的玻璃层（layers，从下到上）+ 画这些玻璃的规则
 * （rules，和 layers 一一对应，按完整选择器精确查 styles.css，不做子串匹配）。
 */
export const SURFACES: Record<
  SurfaceId,
  { inks: string[]; layers: Layer[]; rules: string[] }
> = {
  // 直接落在壁纸上的字：消息时间 / 耗时、空聊天的名字和简介、步骤行、记忆提示、顶栏、各页面正文。
  "on-wallpaper": {
    inks: [
      "--ink-1",
      "--ink-2",
      "--ink-3",
      "--ink-4",
      "--muted-foreground",
      "--glass-ink",
      "--glass-ink-2",
      "--glass-ink-3",
      "--glass-ink-4",
      "--text-primary",
      "--text-secondary",
      "--text-tertiary",
    ],
    layers: [],
    rules: [],
  },
  // 左下角账号卡：名字 .acct-name（--ink-1）、邮箱 / 状态 .acct-sub（--ink-3）。
  "acct-card": {
    inks: ["--ink-1", "--ink-3"],
    layers: ["--lg-surface"],
    rules: [SIDE_RULE],
  },
  // 收起态左栏：导航图标 .rail-mini-item（--ink-2）；字母头像另算（不透明底）。
  "mini-card": {
    inks: ["--ink-2", "--ink-3"],
    layers: ["--lg-surface"],
    rules: [SIDE_RULE],
  },
  // 右栏面板容器：标题、按钮、空状态。
  "rail-card": {
    inks: ["--ink-1", "--ink-2", "--ink-3"],
    layers: ["--lg-surface"],
    rules: [SIDE_RULE],
  },
  // 机器人气泡：正文继承 --glass-ink。
  "bubble-assistant": {
    inks: ["--glass-ink", "--text-primary", "--ink-3"],
    layers: ["--lg-surface-strong"],
    rules: [BUBBLE_CARD_RULE],
  },
  // 气泡外、直接在对话里的 render_ui 卡片。
  "jr-card": {
    inks: ["--ink-1", "--ink-2", "--ink-3", "--text-primary"],
    layers: ["--lg-surface-strong"],
    rules: [BUBBLE_CARD_RULE],
  },
  // 气泡里的卡片：气泡玻璃上再叠卡片玻璃，薄幕仍然只有壁纸那一层（审查：不能叠两层）。
  "jr-card-in-bubble": {
    inks: ["--ink-1", "--ink-2", "--ink-3", "--text-primary"],
    layers: ["--lg-surface-strong", "--lg-surface-strong"],
    rules: [BUBBLE_CARD_RULE, BUBBLE_CARD_RULE],
  },
  // 我的气泡：--bubble-user-bg + --text-primary。
  "bubble-user": {
    inks: ["--text-primary"],
    layers: ["--bubble-user-bg"],
    rules: [],
  },
  // 输入框：输入的字 --text-primary，占位字 --glass-ink-4（壁纸下提到 --glass-ink-3）。
  composer: {
    inks: ["--text-primary", "--glass-ink-4"],
    layers: ["--lg-surface-strong"],
    rules: [COMPOSER_RULE],
  },
};

/**
 * 这条规则的 background 是不是只有一层 var(layer)（没有额外的薄幕层）。
 * `var(--pal-tint-layer,)` 不算一层：它是非 default 配色才定义的强调色叠加，默认配色下这条 var 解析为空，
 * 画的仍然只有那一层玻璃（也不是薄幕，薄幕是 .chisabot-wallpaper::after 那一层 --wallpaper-scrim）。
 */
export function paintsOnly(rule: string, layer: Layer): boolean {
  const bg = lastDecl(stylesCss, rule, "background");
  return (
    bg
      ?.replace(/\s*!important$/, "")
      .replace(/^var\(--pal-tint-layer,\)\s*/, "") === `var(${layer})`
  );
}

/** styles.css 里所有画薄幕的规则（background 里出现 scrim 变量，或给 *-scrim-layer 变量赋值）。 */
export function scrimPainters(): string[] {
  return [...stylesCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) =>
      /(?:^|[;\s])(?:background(?:-image|-color)?\s*:[^;]*var\(--[\w-]*scrim|--[\w-]*scrim-layer\s*:)/.test(
        m[2],
      ),
    )
    .map((m) => norm(m[1]));
}

/** 一种文字位置从壁纸到字之间一共有几层薄幕：壁纸那层 + 每层玻璃规则自带的（应当是 0）。 */
export function scrimLayers(id: SurfaceId): number {
  const own = SURFACES[id].layers.filter(
    (layer, i) =>
      layer !== "--bubble-user-bg" && !paintsOnly(SURFACES[id].rules[i], layer),
  ).length;
  return (
    scrimPainters().filter((s) => s === ".chisabot-wallpaper::after").length +
    own
  );
}

/** 壁纸下文字令牌的实际颜色：html[data-wallpaper="on"] 改过的（--ink-4 → --ink-3 等）按改过的算。 */
export function surfaceInk(scheme: Scheme, ink: string): RGBA {
  const v = lastDecl(stylesCss, 'html[data-wallpaper="on"]', ink);
  const ref = v?.match(/^var\((--[\w-]+)\)$/)?.[1];
  return tokenColor(scheme, ref ?? ink);
}

/** 壁纸下某种文字位置背后所有可能的不透明底色（含每条的墨色档）。 */
export function wallpaperSurfaceBackdrops(
  id: SurfaceId,
  scheme: Scheme,
): Backdrop[] {
  const { layers } = SURFACES[id];
  const bases = wallpaperBases(scheme);
  if (layers.length === 0)
    return bases.map((bg) => ({ bg, inkScheme: scheme }));
  if (layers[0] === "--bubble-user-bg") {
    // 用户气泡也在玻璃名单里会被采样：深釉档连底色带墨一起翻深（--bubble-user-bg 在
    // [data-lg-ink="dark"] 里被覆盖成深色档的值）。
    return bases.map((b) => {
      const ink = decideInk(scheme, bgLum(b), null);
      const flipped = scheme === "light" && ink === "dark";
      const fill = fillToken(flipped ? "dark" : scheme, "--bubble-user-bg");
      return {
        bg: over(fill, b),
        inkScheme: flipped ? ("dark" as Scheme) : scheme,
      };
    });
  }
  const out: Backdrop[] = [];
  for (const base of bases)
    for (const style of GLASS_STYLES)
      for (const haze of HAZE_RANGE) {
        if (style === "liquid") {
          // 每层都按它下面那层重新判定（嵌套卡第二层还是看同一底色附近）。
          let entries = liquidComposite(
            base,
            scheme,
            haze,
            layers[0] === "--lg-surface-strong",
          );
          for (let i = 1; i < layers.length; i++) {
            entries = entries.flatMap((e) =>
              liquidComposite(
                e.bg,
                scheme,
                haze,
                layers[i] === "--lg-surface-strong",
              ).map((n) => ({ bg: n.bg, inkScheme: n.inkScheme })),
            );
          }
          out.push(...entries);
        } else {
          let stack = [base];
          for (const layer of layers) {
            const stops = glassStops(
              layer as "--lg-surface" | "--lg-surface-strong",
              style,
              scheme,
              haze,
            );
            stack = stack.flatMap((b) => stops.map((stop) => over(stop, b)));
          }
          out.push(...stack.map((bg) => ({ bg, inkScheme: scheme })));
        }
      }
  return out;
}

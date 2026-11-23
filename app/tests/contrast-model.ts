/**
 * V2 单通道 5 层 CSS 对比度模型（供 a11y-contrast.test.ts 等门禁使用）。
 *
 * 直接解析生产样式表：
 *   - `app/src/styles/tokens.css`（7 主题 × 浅/深基础令牌、语义色、--surface-solid-*）
 *   - `app/src/styles/canvas.css`（pure / sky / wallpaper 画布与全站唯一护眼薄幕）
 *   - `app/src/styles/materials.css`（glass / clear / solid × panel / elevated / bubble / control / inset）
 *   - `app/src/styles.css`（侧栏行状态、头像底色、输入框占位等）
 *   - `app/src/perf-noblur.css` / `app/src/a11y-modes.css`（实底降级与高对比度模式）
 *
 * 严格按 CSS Color 5 预乘 sRGB 规则计算 `color-mix(in srgb, ...)`、`rgb(R G B / A)`、
 * `linear-gradient(...)` 与 alpha 合成，无任何硬编码颜色副本。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type MaterialId,
  THEMES,
  type ThemeId,
} from "../src/lib/appearance";

export type RGBA = [number, number, number, number];
export type Scheme = "light" | "dark";
export type SurfaceRole = "panel" | "elevated" | "bubble" | "control" | "inset";

export const SCHEMES: readonly Scheme[] = ["light", "dark"] as const;
export const THEME_IDS: readonly ThemeId[] = THEMES.map((t) => t.id);
/** 兼容 rail-tasks-p3.test.tsx 等历史门禁引用的主题列表名。 */
export const FAMILY_IDS: readonly ThemeId[] = THEME_IDS;
export const MATERIAL_IDS: readonly MaterialId[] = [
  "glass",
  "clear",
  "solid",
] as const;
export const SURFACE_ROLES: readonly SurfaceRole[] = [
  "panel",
  "elevated",
  "bubble",
  "control",
  "inset",
] as const;

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const readCss = (rel: string) =>
  strip(readFileSync(path.join(import.meta.dir, "../src", rel), "utf8"));

export const tokensCss = readCss("styles/tokens.css");
export const canvasCss = readCss("styles/canvas.css");
export const materialsCss = readCss("styles/materials.css");
export const stylesCss = readCss("styles.css");
export const noblurCss = readCss("perf-noblur.css");
export const a11yModesCss = readCss("a11y-modes.css");

const norm = (s: string) => s.trim().replace(/\s+/g, " ");
const ruleCache = new Map<string, Map<string, string[]>>();

/** 选择器规范化后完全等于 selector 的所有最内层规则体（含 @layer / @media 内）。 */
export function blocks(css: string, selector: string): string[] {
  let bySelector = ruleCache.get(css);
  if (!bySelector) {
    bySelector = new Map();
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1];
      const body = m[2];
      if (sel === undefined || body === undefined) continue;
      const key = norm(sel);
      bySelector.set(key, [...(bySelector.get(key) ?? []), body]);
    }
    ruleCache.set(css, bySelector);
  }
  return bySelector.get(norm(selector)) ?? [];
}

/** 规则体里某个声明的最后一个值。 */
export function decl(body: string, name: string): string | undefined {
  const re = new RegExp(
    `(?:^|[;\\s])${name.replace(/[-]/g, "\\-")}\\s*:\\s*([^;]+);`,
    "g",
  );
  let value: string | undefined;
  for (const m of body.matchAll(re)) {
    if (m[1] !== undefined) value = m[1].trim();
  }
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

/** 提取 `@media <query> { ... }` 内的 CSS 正文（按大括号深度精确配对）。 */
export function extractMediaBlock(css: string, query: string): string {
  const target = `@media ${query}`;
  const start = css.indexOf(target);
  if (start < 0) return "";
  const open = css.indexOf("{", start);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) {
      return css.slice(open + 1, i);
    }
  }
  return "";
}

function collectDecls(css: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const body of blocks(css, selector)) {
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      if (m[1] && m[2]) out[m[1]] = m[2].trim();
    }
  }
  return out;
}

const tokenMapCache = new Map<string, Record<string, string>>();

/** 某个「主题 × 浅/深 × 画布类型」组合下 `tokens.css` 计算出的完整自定义属性表。 */
export function themeTokenMap(
  themeId: ThemeId,
  scheme: Scheme,
  canvas: "pure" | "sky" | "wallpaper" = "pure",
): Record<string, string> {
  const cacheKey = `${themeId}|${scheme}|${canvas}`;
  const hit = tokenMapCache.get(cacheKey);
  if (hit) return hit;

  const map: Record<string, string> = {
    ...collectDecls(tokensCss, ":root"),
    ...(scheme === "dark" ? collectDecls(tokensCss, "html.dark") : {}),
    ...collectDecls(tokensCss, `html[data-theme="${themeId}"]`),
    ...(scheme === "dark"
      ? collectDecls(tokensCss, `html.dark[data-theme="${themeId}"]`)
      : {}),
    ...(canvas === "wallpaper"
      ? collectDecls(tokensCss, 'html[data-canvas="wallpaper"]')
      : {}),
  };
  tokenMapCache.set(cacheKey, map);
  return map;
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

/** 递归展开表达式中的所有 `var(--name[, fallback])`。 */
export function expandVars(
  expr: string,
  tokens: Record<string, string>,
  depth = 0,
): string {
  if (depth > 16 || !expr.includes("var(")) return expr;
  let out = "";
  let i = 0;
  while (i < expr.length) {
    if (expr.startsWith("var(", i)) {
      let level = 1;
      let j = i + 4;
      let comma = -1;
      for (; j < expr.length && level > 0; j++) {
        const ch = expr[j];
        if (ch === "(") level++;
        else if (ch === ")") level--;
        else if (ch === "," && level === 1 && comma < 0) comma = j;
      }
      if (level === 0) {
        const name = (
          comma >= 0 ? expr.slice(i + 4, comma) : expr.slice(i + 4, j - 1)
        ).trim();
        const fallback =
          comma >= 0 ? expr.slice(comma + 1, j - 1).trim() : undefined;
        const resolved = tokens[name];
        if (resolved !== undefined) {
          out += expandVars(resolved, tokens, depth + 1);
        } else if (fallback !== undefined) {
          out += expandVars(fallback, tokens, depth + 1);
        } else {
          throw new Error(`unresolved CSS variable: ${name}`);
        }
        i = j;
        continue;
      }
    }
    out += expr[i];
    i++;
  }
  return out;
}

/** 按顶层逗号切分参数（跳过括号内逗号）。 */
function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** 解析 `#rrggbb`、`rgb(r g b / a)`、`rgba(r, g, b, a)`、`hsl(...)` 与 `color-mix(in srgb, ...)`。 */
export function parseColor(
  value: string,
  tokens: Record<string, string> = {},
): RGBA {
  const v = expandVars(value, tokens).trim();
  if (v === "transparent") return [0, 0, 0, 0];

  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }

  const h = v.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/);
  if (h?.[1] && h[2] && h[3]) {
    return hsl(Number(h[1]), Number(h[2]), Number(h[3]));
  }

  if (v.startsWith("color-mix(") && v.endsWith(")")) {
    const inner = v.slice("color-mix(".length, -1).trim();
    const parts = splitTopLevelCommas(inner);
    if (parts.length === 3 && /^in\s+srgb$/i.test(parts[0] ?? "")) {
      const parseArg = (arg: string): { color: RGBA; pct: number } => {
        const m = arg.match(/^(.*)\s+([\d.]+)%$/);
        if (m?.[1] && m[2]) {
          return {
            color: parseColor(m[1].trim(), tokens),
            pct: Number(m[2]) / 100,
          };
        }
        return { color: parseColor(arg, tokens), pct: 0.5 };
      };
      const a = parseArg(parts[1] ?? "");
      const b = parseArg(parts[2] ?? "");
      const sum = a.pct + b.pct || 1;
      const w1 = a.pct / sum;
      const w2 = b.pct / sum;
      const alpha = a.color[3] * w1 + b.color[3] * w2;
      if (alpha <= 0) return [0, 0, 0, 0];
      return [
        (a.color[0] * a.color[3] * w1 + b.color[0] * b.color[3] * w2) / alpha,
        (a.color[1] * a.color[3] * w1 + b.color[1] * b.color[3] * w2) / alpha,
        (a.color[2] * a.color[3] * w1 + b.color[2] * b.color[3] * w2) / alpha,
        alpha,
      ];
    }
  }

  const rgb = v.match(/^rgba?\(([^)]*)\)$/);
  if (rgb?.[1]) {
    const parts = rgb[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length >= 3 && parts.every((x) => Number.isFinite(x))) {
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    }
  }

  throw new Error(`unsupported color: ${value} (expanded: ${v})`);
}

/** `top` 按 alpha 叠在不透明的 `bottom` 上。 */
export function over(top: RGBA, bottom: RGBA): RGBA {
  const a = top[3];
  return [
    top[0] * a + bottom[0] * (1 - a),
    top[1] * a + bottom[1] * (1 - a),
    top[2] * a + bottom[2] * (1 - a),
    1,
  ];
}

const mix = (a: RGBA, b: RGBA, t: number): RGBA => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
  a[3] + (b[3] - a[3]) * t,
];

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

/** 解析单个颜色或 `linear-gradient(...)` 中的全部色标颜色（用于最坏对比度采样）。 */
export function extractPaintColors(
  expr: string,
  tokens: Record<string, string>,
): RGBA[] {
  const expanded = expandVars(expr, tokens).trim();
  if (expanded.startsWith("linear-gradient(") && expanded.endsWith(")")) {
    const inner = expanded.slice("linear-gradient(".length, -1);
    const args = splitTopLevelCommas(inner);
    const startIdx =
      args[0] && (/deg$/i.test(args[0]) || /^to\s+/i.test(args[0])) ? 1 : 0;
    const colors: RGBA[] = [];
    for (let i = startIdx; i < args.length; i++) {
      const stop = (args[i] ?? "").replace(/\s+[\d.]+%$/, "").trim();
      if (stop) colors.push(parseColor(stop, tokens));
    }
    if (colors.length === 0) {
      throw new Error(`empty gradient stops: ${expr}`);
    }
    return colors;
  }
  return [parseColor(expanded, tokens)];
}

/** 从 `materials.css` 中查找「材质 × 深浅 × 表面角色」的 `--surface-bg` 原始声明。 */
function findSurfaceDecl(
  material: MaterialId,
  scheme: Scheme,
  role: SurfaceRole,
  prop: "--surface-bg" | "--surface-bg-solid",
): string {
  const scopePrefix =
    material === "solid"
      ? ':where(html[data-material="solid"])'
      : material === "glass"
        ? scheme === "dark"
          ? ':where(html.dark[data-material="glass"], html.dark:not([data-material]))'
          : ':where(html[data-material="glass"], html:not([data-material]))'
        : scheme === "dark"
          ? ':where(html.dark[data-material="clear"])'
          : ':where(html[data-material="clear"])';

  let found: string | undefined;
  for (const m of materialsCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = norm(m[1] ?? "");
    const body = m[2] ?? "";
    if (!sel.startsWith(scopePrefix)) continue;
    if (!sel.includes(`[data-surface="${role}"]`)) continue;
    const v = decl(body, prop);
    if (v) found = v;
  }
  if (!found) {
    throw new Error(`missing ${prop} for ${material}/${scheme}/${role}`);
  }
  return found;
}

/** 主题净色画布（`--canvas-pure-bg`）的全部色标。 */
export function pureCanvasColors(themeId: ThemeId, scheme: Scheme): RGBA[] {
  const tokens = themeTokenMap(themeId, scheme, "pure");
  const bg = tokens["--canvas-pure-bg"];
  if (!bg) throw new Error(`--canvas-pure-bg missing for ${themeId}/${scheme}`);
  return extractPaintColors(bg, tokens);
}

/** 壁纸画布在极值纯黑 / 纯白像素上叠加 `canvas.css` 唯一护眼薄幕后的背景底色。 */
export function wallpaperCanvasBases(themeId: ThemeId, scheme: Scheme): RGBA[] {
  const tokens = themeTokenMap(themeId, scheme, "wallpaper");
  const scrimDecl = lastDecl(
    canvasCss,
    'html[data-canvas="wallpaper"] #sky-root::after',
    "background",
  );
  if (!scrimDecl) {
    throw new Error("wallpaper scrim rule missing in canvas.css");
  }
  const defaultScrim = lastDecl(canvasCss, "#sky-root", "--canvas-scrim");
  const scrimTokens = {
    ...tokens,
    ...(defaultScrim ? { "--canvas-scrim": defaultScrim } : {}),
  };
  const scrimColor = parseColor(scrimDecl, scrimTokens);
  const extremes: RGBA[] = [
    [0, 0, 0, 1],
    [255, 255, 255, 1],
  ];
  return extremes.map((px) => over(scrimColor, px));
}

/** 某主题 × 浅/深 × 材质 × 表面角色在净色或极值黑白壁纸下的全部不透明合成底色。 */
export function surfaceBackdrops(
  themeId: ThemeId,
  scheme: Scheme,
  material: MaterialId,
  role: SurfaceRole,
  canvas: "pure" | "wallpaper",
): RGBA[] {
  const tokens = themeTokenMap(themeId, scheme, canvas);
  const bgExpr = findSurfaceDecl(material, scheme, role, "--surface-bg");
  const surfaceColors = extractPaintColors(bgExpr, tokens);
  const bases =
    canvas === "wallpaper"
      ? wallpaperCanvasBases(themeId, scheme)
      : pureCanvasColors(themeId, scheme);

  // inset 嵌在 panel 内，因此先将 panel 叠在画布上再叠 inset
  const underLayers =
    role === "inset" && material !== "solid"
      ? surfaceBackdrops(themeId, scheme, material, "panel", canvas)
      : bases;

  const out: RGBA[] = [];
  for (const s of surfaceColors) {
    if (s[3] >= 0.999) {
      out.push([s[0], s[1], s[2], 1]);
    } else {
      for (const b of underLayers) {
        out.push(over(s, b));
      }
    }
  }
  return out;
}

/** 某主题 × 浅/深下的全部不透明实色表面（`solid` / `perf` / `prefers-contrast: more` 共用）。 */
export function solidSurfaceColors(themeId: ThemeId, scheme: Scheme): RGBA[] {
  const tokens = themeTokenMap(themeId, scheme, "pure");
  const keys = [
    "--surface-solid-panel",
    "--surface-solid-elevated",
    "--surface-solid-bubble",
    "--surface-solid-inset",
    "--surface-solid-control",
  ] as const;
  return keys.map((k) => {
    const v = tokens[k];
    if (!v) throw new Error(`${k} missing for ${themeId}/${scheme}`);
    return parseColor(v, tokens);
  });
}

/** 解析某主题 × 浅/深 × 画布下指定文字令牌的最终颜色。 */
export function tokenColor(
  themeId: ThemeId,
  scheme: Scheme,
  token: string,
  canvas: "pure" | "sky" | "wallpaper" = "pure",
): RGBA {
  const tokens = themeTokenMap(themeId, scheme, canvas);
  const raw = tokens[token];
  if (!raw) throw new Error(`${token} missing for ${themeId}/${scheme}`);
  return parseColor(raw, tokens);
}

/** 机器人行悬停 / 选中的底色（从 `styles.css` 解析）。 */
export function rowFills(scheme: Scheme): RGBA[] {
  const hoverSel =
    scheme === "dark" ? ".dark .glass-bot-row:hover" : ".glass-bot-row:hover";
  const onSel =
    scheme === "dark"
      ? "html.dark :is(.glass-bot-row.is-on, .glass-mini-bot.is-on, .nav-row.is-on)"
      : "html :is(.glass-bot-row.is-on, .glass-mini-bot.is-on, .nav-row.is-on)";
  const hover = lastDecl(stylesCss, hoverSel, "background");
  const on = lastDecl(stylesCss, onSel, "background");
  if (!hover || !on) throw new Error(`row fills missing for ${scheme}`);
  return [parseColor(hover), parseColor(on)];
}

/** 字母头像的渐变底色（含中点，不透明）。 */
export function avatarStops(): RGBA[] {
  const bg = lastDecl(stylesCss, ".glass-avatar", "background") ?? "";
  const stops = [...bg.matchAll(/#[0-9a-f]{6}/gi)].map((m) => parseColor(m[0]));
  if (stops.length < 2) throw new Error("avatar gradient missing");
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) throw new Error("avatar gradient incomplete");
  return [...stops, mix(first, last, 0.5)];
}

/** 给定前景色与一组不透明底色的最小/最大对比度。 */
export function contrastRange(
  text: RGBA,
  backdrops: RGBA[],
): { min: number; max: number } {
  const values = backdrops.map((b) => contrast(over(text, b), b));
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** 扫描全站样式表中所有画薄幕的规则选择器。 */
export function scrimPainters(): string[] {
  const combined = [tokensCss, canvasCss, materialsCss, stylesCss].join("\n");
  return [...combined.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) =>
      /(?:^|[;\s])background(?:-image|-color)?\s*:[^;]*var\(--[\w-]*scrim/.test(
        m[2] ?? "",
      ),
    )
    .map((m) => norm(m[1] ?? ""));
}

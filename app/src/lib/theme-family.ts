/**
 * CB-140 主题族（theme family）：外观模型从「模式 × 皮肤」升级为「模式 × 主题族」。
 *
 * ThemeFamily = { id, name, light: Seed, dark: Seed }
 * Seed = { ac, bg, fg, c }（accent / background / foreground / 对比度 30-70）
 *
 * 浅色与深色模式各自独立选择主题族，允许「浅色 = 落樱 + 深色 = 伦敦雨」这类混搭；
 * 每个 seed 通过 deriveSeed 纯函数派生一整套 CSS 变量（强调色、文字层级、边框、
 * 玻璃、天空渐变），不再依赖 styles.css 里的静态 data-palette 轴。
 *
 * 存储：
 *   chisabot-theme-family-light / chisabot-theme-family-dark — 两个模式各自的族 id
 *   chisabot-theme-families — 用户自定义族 JSON 数组
 *   chisabot-theme-palette（旧键，只用于一次性迁移，迁移后不再读取）
 */

/** 种子四件套：accent / background / foreground / contrast(30-70)。 */
export interface Seed {
  /** 强调色（hex，如 #4176e6）。 */
  ac: string;
  /** 底色（hex，如 #f3f7fc）。 */
  bg: string;
  /** 文字主色（hex，如 #1a2233）。 */
  fg: string;
  /** 对比度 30-70：越高派生的边框 alpha / 文字弱化层级 / 玻璃不透明度越大。 */
  c: number;
  /** 「自动」天象场景在此 seed 下解析到的场景编号（0-7），未设时用 default 兜底。 */
  scene?: number;
}

export interface ThemeFamily {
  id: string;
  name: string;
  light: Seed;
  dark: Seed;
}

export const FAMILY_LIGHT_STORAGE_KEY = "chisabot-theme-family-light";
export const FAMILY_DARK_STORAGE_KEY = "chisabot-theme-family-dark";
export const CUSTOM_FAMILIES_STORAGE_KEY = "chisabot-theme-families";
/** 旧皮肤轴的存储键；只用于 readInitialAppearance / boot 脚本里的一次性迁移。 */
export const PALETTE_STORAGE_KEY = "chisabot-theme-palette";

export const DEFAULT_FAMILY_ID = "azure";

/** 八个内置族（CB-140 §143；色值是规格常量，不要重新采样）。 */
export const THEME_FAMILIES: ThemeFamily[] = [
  {
    id: "azure",
    name: "晴空",
    light: { ac: "#4176e6", bg: "#f3f7fc", fg: "#1a2233", c: 46, scene: 0 },
    dark: { ac: "#6ea8ff", bg: "#10141c", fg: "#e8eef9", c: 48, scene: 4 },
  },
  {
    id: "mist",
    name: "晨雾",
    light: { ac: "#64748b", bg: "#f4f5f7", fg: "#26292e", c: 44, scene: 0 },
    dark: { ac: "#94a3b8", bg: "#15181d", fg: "#e2e6ec", c: 46, scene: 4 },
  },
  {
    id: "celadon",
    name: "青瓷",
    light: { ac: "#0f766e", bg: "#f3faf7", fg: "#10211c", c: 44, scene: 1 },
    dark: { ac: "#3dd6b5", bg: "#071411", fg: "#e7f6f1", c: 50, scene: 5 },
  },
  {
    id: "sakura",
    name: "落樱",
    light: { ac: "#d4527e", bg: "#fcf3f6", fg: "#331c26", c: 46, scene: 1 },
    dark: { ac: "#e0789c", bg: "#1e1018", fg: "#f2dfe8", c: 48, scene: 5 },
  },
  {
    id: "amber",
    name: "琥珀",
    light: { ac: "#b45309", bg: "#fbf6ee", fg: "#1c1915", c: 48, scene: 1 },
    dark: { ac: "#e2b15c", bg: "#14100b", fg: "#f6efe4", c: 52, scene: 6 },
  },
  {
    id: "violet",
    name: "暮紫",
    light: { ac: "#7c3aed", bg: "#f7f3fc", fg: "#1c1524", c: 46, scene: 2 },
    dark: { ac: "#c4a1ff", bg: "#120e18", fg: "#f3eefc", c: 50, scene: 5 },
  },
  {
    id: "london",
    name: "伦敦雨",
    light: { ac: "#4a6d8c", bg: "#f0f4f7", fg: "#1c2833", c: 44, scene: 2 },
    dark: { ac: "#7aa4c4", bg: "#101820", fg: "#dde5f0", c: 48, scene: 6 },
  },
  {
    id: "mono",
    name: "对比",
    light: { ac: "#111111", bg: "#ffffff", fg: "#050505", c: 68, scene: 0 },
    dark: { ac: "#ffffff", bg: "#050505", fg: "#f5f5f5", c: 64, scene: 4 },
  },
];

const BUILT_IN_FAMILIES = new Map(THEME_FAMILIES.map((f) => [f.id, f]));

/** 旧 data-palette 轴 → 新主题族的映射（老键有值且新键没有时一次性迁移，两槽同写）。 */
const LEGACY_PALETTE_TO_FAMILY: Record<string, string> = {
  default: "azure",
  ocean: "azure",
  aurora: "violet",
  nocturne: "violet",
  emerald: "celadon",
  sakura: "sakura",
  ruby: "sakura",
  sunset: "amber",
  gold: "amber",
  stardust: "mist",
};

/**
 * 把旧的 palette id 映射成新的主题族 id；未知 / 空值返回 null（调用方回落 azure）。
 * 纯函数，不读存储——调用方自己拿旧键的原始值进来。
 */
export function migrateLegacyPalette(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  return LEGACY_PALETTE_TO_FAMILY[raw.trim()] ?? null;
}

/** id 形态校验：内置 id 或 `custom-*` 等小写短 id。 */
export function isValidFamilyId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/i.test(id);
}

function isHexColor(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}

function isValidSeed(v: unknown): v is Seed {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    isHexColor(s.ac) &&
    isHexColor(s.bg) &&
    isHexColor(s.fg) &&
    typeof s.c === "number" &&
    s.c >= 30 &&
    s.c <= 70
  );
}

/** 自定义族的持久化形态校验；scene 可选。 */
export function isValidFamily(v: unknown): v is ThemeFamily {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return (
    isValidFamilyId(f.id) &&
    typeof f.name === "string" &&
    f.name.trim().length > 0 &&
    isValidSeed(f.light) &&
    isValidSeed(f.dark)
  );
}

/** 解析持久化的自定义族数组；坏条目静默丢弃。 */
export function parseCustomFamilies(raw: string | null): ThemeFamily[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: ThemeFamily[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (
        !isValidFamily(item) ||
        BUILT_IN_FAMILIES.has(item.id) ||
        seen.has(item.id)
      )
        continue;
      seen.add(item.id);
      out.push({ ...item, name: item.name.trim() });
    }
    return out;
  } catch {
    return [];
  }
}

/** 全部可选族 = 内置 8 族 + 校验过的自定义族（同 id 不覆盖内置）。 */
export function listThemeFamilies(custom: ThemeFamily[] = []): ThemeFamily[] {
  return [
    ...THEME_FAMILIES,
    ...custom.filter((f) => isValidFamily(f) && !BUILT_IN_FAMILIES.has(f.id)),
  ];
}

/**
 * 解析一个存储的族 id：先查内置，再查自定义；解析不到回落 azure（永不返回 null）。
 */
export function resolveThemeFamily(
  id: string | null | undefined,
  custom: ThemeFamily[] = [],
): ThemeFamily {
  if (id) {
    const builtIn = BUILT_IN_FAMILIES.get(id);
    if (builtIn) return builtIn;
    const found = custom.find((f) => f.id === id && isValidFamily(f));
    if (found) return found;
  }
  const fallback =
    BUILT_IN_FAMILIES.get(DEFAULT_FAMILY_ID) ?? THEME_FAMILIES[0];
  if (!fallback) throw new Error("THEME_FAMILIES is empty");
  return fallback;
}

export function familySeed(family: ThemeFamily, dark: boolean): Seed {
  return dark ? family.dark : family.light;
}

/**
 * 从 seed 派生整套 CSS 变量。
 *
 * 返回值分两组：
 *  - root：写在 <html> 内联样式上的普通自定义属性（强调色 / 文字 / 边框 / 玻璃 / --fam-sky-*）。
 *  - body：写在 <body> 上的 @property 注册变量（--sky-1..4 等不可继承，必须落在 body 自身）。
 *
 * 注意：此函数会被 `.toString()` 内联进 index.html 启动脚本，函数体内不允许
 * 引用模块级变量——所有颜色工具函数都定义在内部（与 computeSky 同约束）。
 */
export function deriveSeed(
  seed: { ac: string; bg: string; fg: string; c: number },
  dark: boolean,
): { root: Record<string, string>; body: Record<string, string> } {
  const clampN = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v));

  function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace("#", "");
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  function rgbToHex(r: number, g: number, b: number): string {
    const to = (v: number) =>
      clampN(Math.round(v), 0, 255).toString(16).padStart(2, "0");
    return `#${to(r)}${to(g)}${to(b)}`;
  }
  function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
      else if (max === gn) h = ((bn - rn) / d + 2) / 6;
      else h = ((rn - gn) / d + 4) / 6;
    }
    return [h * 360, s * 100, l * 100];
  }
  function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    const hn = (((h % 360) + 360) % 360) / 360;
    const sn = clampN(s, 0, 100) / 100;
    const ln = clampN(l, 0, 100) / 100;
    if (sn === 0) {
      const v = Math.round(ln * 255);
      return [v, v, v];
    }
    const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
    const p = 2 * ln - q;
    const hue = (t: number) => {
      let tn = t;
      if (tn < 0) tn += 1;
      if (tn > 1) tn -= 1;
      if (tn < 1 / 6) return p + (q - p) * 6 * tn;
      if (tn < 1 / 2) return q;
      if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
      return p;
    };
    return [
      Math.round(hue(hn + 1 / 3) * 255),
      Math.round(hue(hn) * 255),
      Math.round(hue(hn - 1 / 3) * 255),
    ];
  }
  function hslHex(h: number, s: number, l: number): string {
    const [r, g, b] = hslToRgb(h, s, l);
    return rgbToHex(r, g, b);
  }
  /** 色相沿最短路径插值（避免绕 360° 远路）。 */
  function hueMix(a: number, b: number, t: number): number {
    let d = (((b - a) % 360) + 360) % 360;
    if (d > 180) d -= 360;
    return (((a + d * t) % 360) + 360) % 360;
  }
  /** mix(a, b, t)：t=0 给 a、t=1 给 b。 */
  function mixHex(a: string, b: string, t: number): string {
    const [ar, ag, ab] = hexToRgb(a);
    const [br, bg2, bb] = hexToRgb(b);
    return rgbToHex(
      ar + (br - ar) * t,
      ag + (bg2 - ag) * t,
      ab + (bb - ab) * t,
    );
  }
  function rgbaHex(hex: string, a: number): string {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
  }
  function luminance(hex: string): number {
    const [r, g, b] = hexToRgb(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrastHex(a: string, b: string): number {
    const l1 = luminance(a);
    const l2 = luminance(b);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  const ac = seed.ac;
  const bg = seed.bg;
  const fg = seed.fg;
  const f = clampN(seed.c, 30, 70) / 100; // 0.3..0.7

  /* ---- 强调色系（CB-134 palette 轴的同款令牌，全部由 seed 派生） ---- */
  const ink = dark ? mixHex(ac, "#ffffff", 0.22) : mixHex(ac, "#000000", 0.16);
  const inkHover = dark
    ? mixHex(ac, "#ffffff", 0.4)
    : mixHex(ac, "#000000", 0.3);
  // 按钮文字坐在 --ink-primary（而非 ac）上：候选色与实际底色的对比要达标，
  // 中亮度 accent（如晨雾 #64748b）对 ac 取深字会在变暗后的 ink 上掉到 2.x。
  const onPrimary =
    contrastHex("#ffffff", ink) >= contrastHex("#0f1115", ink)
      ? "#ffffff"
      : "#0f1115";

  /* ---- 对比度 c 驱动的三个量：边框 alpha / 文字弱化 / 玻璃不透明度 ---- */
  const borderPrimary = 0.08 + f * 0.14; // c=46 → ≈0.14（对齐旧默认）
  const borderSecondary = 0.04 + f * 0.07;
  /* 按 sRGB 亮度衰减分别收紧浅/深色阶，深色磨砂上保持高亮度锐利可读且严格满足 --ink-1 > --ink-2 > --ink-3 > --ink-4；
   * 仅输出 --fam-ink-2..4 供样式表读取，避免内联 --ink-2/--ink-4 压死壁纸提级与 prefers-contrast 护栏。 */
  const ink2 = mixHex(fg, bg, dark ? 0.08 - f * 0.04 : 0.08 - f * 0.04);
  const ink3 = mixHex(fg, bg, dark ? 0.14 - f * 0.05 : 0.14 - f * 0.06);
  const ink4 = mixHex(fg, bg, dark ? 0.21 - f * 0.07 : 0.22 - f * 0.08);
  const glassBase = mixHex(bg, ac, 0.06 + f * 0.04); // 朝 accent 微偏的玻璃底色
  const glassTint = dark
    ? rgbaHex(mixHex(ac, bg, 0.55), 0.12)
    : rgbaHex(ac, 0.08);
  const glassAlpha = 0.48 + f * 0.16;
  const bubbleUser = mixHex(bg, ac, 0.1 + f * 0.08);

  /* ---- 主题天空：从 bg / ac 推的四段渐变（top→bottom） ---- */
  const [bh, bs, bl] = rgbToHsl(
    hexToRgb(bg)[0],
    hexToRgb(bg)[1],
    hexToRgb(bg)[2],
  );
  const [ah, as_] = (() => {
    const [h, s] = rgbToHsl(hexToRgb(ac)[0], hexToRgb(ac)[1], hexToRgb(ac)[2]);
    return [h, s] as const;
  })();
  const stops: string[] = [];
  let glow = "";
  if (!dark) {
    // 浅色：顶部是「bg 的色相 / L 拉向 accent 的 54%」，逐段降回 bg 本身。
    const topH = hueMix(bh, ah, 0.55);
    const topS = clampN(bs + (as_ - bs) * 0.7, 6, 90);
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      stops.push(
        hslHex(hueMix(topH, bh, t), topS + (bs - topS) * t, 54 + (bl - 54) * t),
      );
    }
    const [gh, gs] = rgbToHsl(
      hexToRgb(stops[1] ?? bg)[0],
      hexToRgb(stops[1] ?? bg)[1],
      hexToRgb(stops[1] ?? bg)[2],
    );
    glow = hslHex(gh, clampN(gs + 15, 0, 90), 76);
  } else {
    // 深色：顶部取 bg 的 60% 亮度并染向 accent，底部比 bg 亮一档。
    const topH = hueMix(bh, ah, 0.5);
    const botH = hueMix(bh, ah, 0.25);
    const topS = clampN(bs + (as_ - bs) * 0.6, 3, 60);
    const botS = clampN(bs + (as_ - bs) * 0.35, 3, 55);
    const topL = clampN(bl * 0.6, 3, 12);
    const botL = clampN(bl + 7, 7, 26);
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      stops.push(
        hslHex(
          hueMix(topH, botH, t),
          topS + (botS - topS) * t,
          topL + (botL - topL) * t,
        ),
      );
    }
    const [gh, gs] = rgbToHsl(
      hexToRgb(stops[1] ?? bg)[0],
      hexToRgb(stops[1] ?? bg)[1],
      hexToRgb(stops[1] ?? bg)[2],
    );
    glow = hslHex(gh, clampN(gs + 15, 0, 80), 32);
  }

  return {
    root: {
      "--accent-blue": ac,
      "--accent-color": ac,
      "--accent-blue-ink": ink,
      "--ink-primary": ink,
      "--ink-primary-hover": inkHover,
      "--accent-blue-soft": rgbaHex(ac, 0.14),
      "--accent-soft": rgbaHex(ac, 0.14),
      "--on-primary": onPrimary,
      "--focus": rgbaHex(ac, 0.24),
      "--focus-line": rgbaHex(ac, 0.6),
      "--glass-tint": glassTint,
      "--ink-1": fg,
      "--fam-ink-2": ink2,
      "--fam-ink-3": ink3,
      "--fam-ink-4": ink4,
      "--stroke-primary": rgbaHex(fg, borderPrimary),
      "--stroke-secondary": rgbaHex(fg, borderSecondary),
      "--line": rgbaHex(fg, 0.05 + f * 0.07),
      "--line-strong": rgbaHex(fg, 0.08 + f * 0.12),
      "--bubble-user-bg": bubbleUser,
      "--glass-bg": rgbaHex(glassBase, glassAlpha),
      "--glass-input-bg": rgbaHex(glassBase, glassAlpha - 0.06),
      "--fam-sky-0": stops[0] ?? bg,
      "--fam-sky-1": stops[1] ?? bg,
      "--fam-sky-2": stops[2] ?? bg,
      "--fam-sky-3": stops[3] ?? bg,
    },
    body: {
      "--sky-0": stops[0] ?? bg,
      "--sky-1": stops[0] ?? bg,
      "--sky-2": stops[1] ?? bg,
      "--sky-3": stops[2] ?? bg,
      "--sky-4": stops[3] ?? bg,
      "--sky-glow": glow,
      "--sky-glow-a": dark ? "0.42" : "0.52",
    },
  };
}

/** meta theme-color：取天空顶部段（与 paletteThemeColor 对应）。 */
export function familyThemeColor(
  seed: { ac: string; bg: string; fg: string; c: number },
  dark: boolean,
): string {
  return deriveSeed(seed, dark).root["--fam-sky-0"] ?? seed.bg;
}

/** 天空渐变的四段（供卡片预览等用）。 */
export function familySkyStops(
  seed: { ac: string; bg: string; fg: string; c: number },
  dark: boolean,
): [string, string, string, string] {
  const v = deriveSeed(seed, dark).root;
  return [
    v["--fam-sky-0"] ?? seed.bg,
    v["--fam-sky-1"] ?? seed.bg,
    v["--fam-sky-2"] ?? seed.bg,
    v["--fam-sky-3"] ?? seed.bg,
  ];
}

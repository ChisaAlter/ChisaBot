/**
 * V2 色彩主题元数据与自定义强调色对比度派生（四轴正交架构）。
 *
 * - 内置 6 套精调主题：sky / aurora / porcelain / deepseek / claude / cossui；
 *   每套主题的完整浅/深色令牌定义在 `app/src/styles/tokens.css`（通过 `html[data-theme="<ThemeId>"]` 命中），
 *   JS 不再向 <html> / <body> 批量注入 24 个派生内联变量。
 * - 仅当用户设置了 `customAccent` 时，由纯函数 {@link deriveCustomAccentVars} 按当前浅/深模式算出
 *   过 WCAG AA >= 4.5:1 的 `--accent` / `--accent-ink` / `--accent-soft` / `--accent-ring` / `--ink-on-accent`。
 * - 保持为纯模块（无 React / DOM 依赖），{@link deriveCustomAccentVars} 自包含以便启动脚本序列化内联。
 */

export type ThemeId =
  | "sky"
  | "aurora"
  | "porcelain"
  | "deepseek"
  | "claude"
  | "cossui";

export const DEFAULT_THEME_ID: ThemeId = "sky";

export const VALID_THEME_IDS: readonly ThemeId[] = [
  "sky",
  "aurora",
  "porcelain",
  "deepseek",
  "claude",
  "cossui",
] as const;

export interface ThemeVariantMeta {
  accent: string;
  onAccent: string;
  bg: string;
  fg: string;
  surface: string;
  themeColor: string;
  canvasStops: readonly [string, string, string];
}

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  tagline: string;
  description: string;
  light: ThemeVariantMeta;
  dark: ThemeVariantMeta;
}

/** 6 套精选主题元数据（色值与 tokens.css 对齐）。 */
export const THEMES: readonly ThemeMeta[] = [
  {
    id: "sky",
    name: "默认",
    tagline: "晴空 · 星空",
    description: "鲸屿经典浅色天空与深色静谧星空",
    light: {
      accent: "#2563eb",
      onAccent: "#ffffff",
      bg: "#f2f7fc",
      fg: "#0b1220",
      surface: "#f2f7fc",
      themeColor: "#9dbddc",
      canvasStops: ["#9dbddc", "#c9dbeb", "#e4ecf3"],
    },
    dark: {
      accent: "#74aeff",
      onAccent: "#0b1220",
      bg: "#121c30",
      fg: "#f8fafc",
      surface: "#121c30",
      themeColor: "#070d1c",
      canvasStops: ["#070d1c", "#0c1730", "#13213f"],
    },
  },
  {
    id: "aurora",
    name: "极光",
    tagline: "极地流光",
    description: "极地冰川青绿与幻彩紫罗兰流光",
    light: {
      accent: "#0d9488",
      onAccent: "#ffffff",
      bg: "#eff9f7",
      fg: "#091a1d",
      surface: "#eff9f7",
      themeColor: "#a8e2d8",
      canvasStops: ["#c9f0e8", "#e4f5f5", "#ede8fa"],
    },
    dark: {
      accent: "#2dd4bf",
      onAccent: "#041c1a",
      bg: "#0f222a",
      fg: "#f2fdfb",
      surface: "#0f222a",
      themeColor: "#06151c",
      canvasStops: ["#06151c", "#0b222c", "#181633"],
    },
  },
  {
    id: "porcelain",
    name: "青花瓷",
    tagline: "釉白钴蓝",
    description: "景德镇甜白釉、苏麻离青钴蓝与夜窑霁蓝",
    light: {
      accent: "#1d4ed8",
      onAccent: "#ffffff",
      bg: "#f5f7fc",
      fg: "#0c162b",
      surface: "#f5f7fc",
      themeColor: "#c4d5ee",
      canvasStops: ["#dce6f5", "#edf2fa", "#f8f9fc"],
    },
    dark: {
      accent: "#6ea8ff",
      onAccent: "#081226",
      bg: "#11203d",
      fg: "#f4f8ff",
      surface: "#11203d",
      themeColor: "#081226",
      canvasStops: ["#081226", "#0f1e3b", "#172b4f"],
    },
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    tagline: "DSH 超椭圆",
    description: "DeepSeek Harness 风格：超椭圆圆角、0.5px 发丝边与冷蓝灰层次",
    light: {
      accent: "#4176e6",
      onAccent: "#ffffff",
      bg: "#f9fafb",
      fg: "#0f1115",
      surface: "#f9fafb",
      themeColor: "#e4edfd",
      canvasStops: ["#edf3fe", "#f5f7fa", "#f9fafb"],
    },
    dark: {
      accent: "#5686fe",
      onAccent: "#0f1115",
      bg: "#1b1b1c",
      fg: "#f9fafb",
      surface: "#1b1b1c",
      themeColor: "#151517",
      canvasStops: ["#151517", "#1b1b1c", "#232324"],
    },
  },
  {
    id: "claude",
    name: "Claude",
    tagline: "暖纸陶橙",
    description: "温润羊皮纸、陶土暖橙与书卷人文质感",
    light: {
      accent: "#c6613f",
      onAccent: "#ffffff",
      bg: "#f6f4ec",
      fg: "#1c1b18",
      surface: "#f6f4ec",
      themeColor: "#ece7db",
      canvasStops: ["#eeeae0", "#f5f4ee", "#faf9f5"],
    },
    dark: {
      accent: "#d97757",
      onAccent: "#1a1512",
      bg: "#1c1b18",
      fg: "#faf8f4",
      surface: "#1c1b18",
      themeColor: "#1c1b18",
      canvasStops: ["#181715", "#1f1e1b", "#252420"],
    },
  },
  {
    id: "cossui",
    name: "coss ui",
    tagline: "精密锌灰",
    description: "coss.com/ui 中性锌灰、清晰不透明描边与紧凑几何",
    light: {
      accent: "#18181b",
      onAccent: "#fafafa",
      bg: "#f8f8f9",
      fg: "#09090b",
      surface: "#f8f8f9",
      themeColor: "#e4e4e7",
      canvasStops: ["#ededf0", "#f5f5f7", "#fafafa"],
    },
    dark: {
      accent: "#f4f4f5",
      onAccent: "#09090b",
      bg: "#121215",
      fg: "#fafafa",
      surface: "#121215",
      themeColor: "#09090b",
      canvasStops: ["#09090b", "#0f0f12", "#151519"],
    },
  },
] as const;

const THEME_MAP = new Map<ThemeId, ThemeMeta>(THEMES.map((t) => [t.id, t]));

/** 旧 theme-family / data-palette id → V2 ThemeId 的无损映射表。 */
export const LEGACY_THEME_MAP: Readonly<Record<string, ThemeId>> = {
  sky: "sky",
  default: "sky",
  azure: "sky",
  ocean: "sky",
  aurora: "aurora",
  violet: "aurora",
  nocturne: "aurora",
  emerald: "aurora",
  porcelain: "porcelain",
  celadon: "porcelain",
  deepseek: "deepseek",
  mist: "deepseek",
  london: "deepseek",
  stardust: "deepseek",
  claude: "claude",
  amber: "claude",
  sunset: "claude",
  gold: "claude",
  sakura: "claude",
  ruby: "claude",
  cossui: "cossui",
  coss: "cossui",
  mono: "cossui",
};

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEME_MAP.has(value as ThemeId);
}

export function mapLegacyThemeId(
  raw: string | null | undefined,
): ThemeId | null {
  if (!raw) return null;
  return LEGACY_THEME_MAP[raw.trim().toLowerCase()] ?? null;
}

export function getThemeMeta(id: ThemeId): ThemeMeta {
  const found = THEME_MAP.get(id);
  if (found) return found;
  const fallback = THEMES[0];
  if (!fallback) throw new Error("THEMES is empty");
  return fallback;
}

export function themeMetaColor(id: ThemeId, dark: boolean): string {
  const meta = getThemeMeta(id);
  return dark ? meta.dark.themeColor : meta.light.themeColor;
}

export function normalizeHexColor(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const r = trimmed.charAt(1);
    const g = trimmed.charAt(2);
    const b = trimmed.charAt(3);
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

export interface CustomAccentVars {
  "--accent": string;
  "--accent-ink": string;
  "--accent-soft": string;
  "--accent-ring": string;
  "--ink-on-accent": string;
}

export const CUSTOM_ACCENT_CSS_PROPS: readonly (keyof CustomAccentVars)[] = [
  "--accent",
  "--accent-ink",
  "--accent-soft",
  "--accent-ring",
  "--ink-on-accent",
] as const;

/**
 * 纯函数：按当前浅/深模式从任意合法 hex 派生自定义强调色内联变量，
 * 保证 `--accent-ink` 在最严苛表面底色上满足 WCAG AA >= 4.5:1（目标 >= 4.6:1）。
 *
 * 注意：此函数会被 `.toString()` 内联进 index.html 启动脚本，
 * 函数体内不得引用模块级变量。
 */
export function deriveCustomAccentVars(
  hex: string,
  dark: boolean,
): CustomAccentVars {
  const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const hexToRgb = (input: string): [number, number, number] => {
    const clean = input.replace("#", "");
    const full =
      clean.length === 3
        ? clean.charAt(0) +
          clean.charAt(0) +
          clean.charAt(1) +
          clean.charAt(1) +
          clean.charAt(2) +
          clean.charAt(2)
        : clean;
    return [
      Number.parseInt(full.slice(0, 2), 16) || 0,
      Number.parseInt(full.slice(2, 4), 16) || 0,
      Number.parseInt(full.slice(4, 6), 16) || 0,
    ];
  };
  const rgbToHex = (r: number, g: number, b: number): string =>
    `#${clampByte(r).toString(16).padStart(2, "0")}${clampByte(g).toString(16).padStart(2, "0")}${clampByte(b).toString(16).padStart(2, "0")}`;
  const mixHex = (a: string, b: string, t: number): string => {
    const [ar, ag, ab] = hexToRgb(a);
    const [br, bg, bb] = hexToRgb(b);
    return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
  };
  const luminance = (input: string): number => {
    const [r, g, b] = hexToRgb(input).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string): number => {
    const l1 = luminance(a);
    const l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  const [r, g, b] = hexToRgb(hex);
  const rawAccent = rgbToHex(r, g, b);
  // 浅色检查偏灰面板表面 #eef2f7（比纯白更严格），深色检查较亮面板表面 #1c222e（比纯黑更严格）。
  const surfaceRef = dark ? "#1c222e" : "#eef2f7";
  const targetTone = dark ? "#f8fafc" : "#0b0f17";

  const ensureContrast = (baseHex: string, minRatio: number): string => {
    if (contrast(baseHex, surfaceRef) >= minRatio) return baseHex;
    let lo = 0;
    let hi = 1;
    let best = baseHex;
    for (let step = 0; step < 24; step++) {
      const mid = (lo + hi) / 2;
      const candidate = mixHex(baseHex, targetTone, mid);
      if (contrast(candidate, surfaceRef) >= minRatio) {
        best = candidate;
        hi = mid;
      } else {
        lo = mid;
      }
    }
    return contrast(best, surfaceRef) >= minRatio ? best : targetTone;
  };

  // 非文本图形/控件对比度保底（WCAG 2.1 SC 1.4.11 >= 3.0:1，取 3.1 留余量），避免浅色近白或深色近黑导致弧线不可见。
  const accent = ensureContrast(rawAccent, 3.1);
  const accentInk = ensureContrast(rawAccent, 4.6);
  const [ar, ag, ab] = hexToRgb(accent);

  const inkOnAccent =
    contrast("#ffffff", accent) >= contrast("#0f1115", accent)
      ? "#ffffff"
      : "#0f1115";

  return {
    "--accent": accent,
    "--accent-ink": accentInk,
    "--accent-soft": `rgba(${ar}, ${ag}, ${ab}, ${dark ? 0.2 : 0.14})`,
    "--accent-ring": `rgba(${ar}, ${ag}, ${ab}, ${dark ? 0.45 : 0.35})`,
    "--ink-on-accent": inkOnAccent,
  };
}

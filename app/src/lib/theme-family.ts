/**
 * V2 色彩主题元数据与自定义强调色对比度派生（四轴正交架构）。
 *
 * - 内置 7 套精调主题：sky / mist / celadon / sakura / amber / violet / mono；
 *   每套主题的完整浅/深色令牌定义在 `app/src/styles/tokens.css`（通过 `html[data-theme="<ThemeId>"]` 命中），
 *   JS 不再向 <html> / <body> 批量注入 24 个派生内联变量。
 * - 仅当用户设置了 `customAccent` 时，由纯函数 {@link deriveCustomAccentVars} 按当前浅/深模式算出
 *   过 WCAG AA >= 4.5:1 的 `--accent` / `--accent-ink` / `--accent-soft` / `--accent-ring` / `--ink-on-accent`。
 * - 保持为纯模块（无 React / DOM 依赖），{@link deriveCustomAccentVars} 自包含以便启动脚本序列化内联。
 */

export type ThemeId =
  | "sky"
  | "mist"
  | "celadon"
  | "sakura"
  | "amber"
  | "violet"
  | "mono";

export const DEFAULT_THEME_ID: ThemeId = "sky";

export const VALID_THEME_IDS: readonly ThemeId[] = [
  "sky",
  "mist",
  "celadon",
  "sakura",
  "amber",
  "violet",
  "mono",
] as const;

export interface ThemeVariantMeta {
  accent: string;
  bg: string;
  fg: string;
  themeColor: string;
  canvasStops: readonly [string, string, string];
}

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  description: string;
  light: ThemeVariantMeta;
  dark: ThemeVariantMeta;
}

/** 7 套精选主题元数据（色值与 tokens.css 对齐）。 */
export const THEMES: readonly ThemeMeta[] = [
  {
    id: "sky",
    name: "晴空",
    description: "清透蔚蓝与柔光云感",
    light: {
      accent: "#4176e6",
      bg: "#f3f7fc",
      fg: "#1a2233",
      themeColor: "#9dbddc",
      canvasStops: ["#dce9f8", "#edf4fc", "#f6f9fd"],
    },
    dark: {
      accent: "#6ea8ff",
      bg: "#10141c",
      fg: "#e8eef9",
      themeColor: "#0c1626",
      canvasStops: ["#0c1626", "#111b2c", "#151f30"],
    },
  },
  {
    id: "mist",
    name: "晨雾",
    description: "克制中性灰蓝，专注阅读",
    light: {
      accent: "#55657a",
      bg: "#f4f5f7",
      fg: "#26292e",
      themeColor: "#cdd4de",
      canvasStops: ["#e3e7ed", "#eff1f5", "#f7f8fa"],
    },
    dark: {
      accent: "#94a3b8",
      bg: "#15181d",
      fg: "#e2e6ec",
      themeColor: "#15181d",
      canvasStops: ["#13171d", "#181d25", "#1d222b"],
    },
  },
  {
    id: "celadon",
    name: "青瓷",
    description: "温润松青与东方玉色",
    light: {
      accent: "#0f766e",
      bg: "#f3faf7",
      fg: "#10211c",
      themeColor: "#a8d2c6",
      canvasStops: ["#d8eee7", "#ebf6f2", "#f5fbf9"],
    },
    dark: {
      accent: "#3dd6b5",
      bg: "#071411",
      fg: "#e7f6f1",
      themeColor: "#0a1d18",
      canvasStops: ["#081915", "#0d221d", "#112822"],
    },
  },
  {
    id: "sakura",
    name: "落樱",
    description: "淡粉霞光与柔和暖调",
    light: {
      accent: "#d4527e",
      bg: "#fcf3f6",
      fg: "#331c26",
      themeColor: "#ebc0cf",
      canvasStops: ["#f7dfe8", "#fbeff3", "#fdf7f9"],
    },
    dark: {
      accent: "#e0789c",
      bg: "#1e1018",
      fg: "#f2dfe8",
      themeColor: "#22121b",
      canvasStops: ["#1d0f17", "#25141e", "#2b1823"],
    },
  },
  {
    id: "amber",
    name: "琥珀",
    description: "暖金纸感与柔和日光",
    light: {
      accent: "#b45309",
      bg: "#fbf6ee",
      fg: "#1c1915",
      themeColor: "#e6c8a2",
      canvasStops: ["#f3e3cc", "#f9f0e2", "#fcf8f1"],
    },
    dark: {
      accent: "#e2b15c",
      bg: "#14100b",
      fg: "#f6efe4",
      themeColor: "#1a140d",
      canvasStops: ["#18120b", "#201810", "#261d14"],
    },
  },
  {
    id: "violet",
    name: "暮紫",
    description: "微醺星云与深邃紫罗兰",
    light: {
      accent: "#7c3aed",
      bg: "#f7f3fc",
      fg: "#1c1524",
      themeColor: "#c9bbe8",
      canvasStops: ["#e7def8", "#f3eefb", "#f9f6fd"],
    },
    dark: {
      accent: "#c4a1ff",
      bg: "#120e18",
      fg: "#f3eefc",
      themeColor: "#171222",
      canvasStops: ["#140f1e", "#1b1528", "#211a30"],
    },
  },
  {
    id: "mono",
    name: "素墨",
    description: "高对比黑白极简",
    light: {
      accent: "#111111",
      bg: "#ffffff",
      fg: "#050505",
      themeColor: "#e5e7eb",
      canvasStops: ["#e8eaee", "#f4f5f7", "#ffffff"],
    },
    dark: {
      accent: "#ffffff",
      bg: "#050505",
      fg: "#f5f5f5",
      themeColor: "#0c0c0e",
      canvasStops: ["#070709", "#0e0e12", "#141418"],
    },
  },
] as const;

const THEME_MAP = new Map<ThemeId, ThemeMeta>(THEMES.map((t) => [t.id, t]));

/** 旧 theme-family / data-palette id → V2 ThemeId 的无损映射表。 */
export const LEGACY_THEME_MAP: Readonly<Record<string, ThemeId>> = {
  sky: "sky",
  azure: "sky",
  default: "sky",
  ocean: "sky",
  mist: "mist",
  stardust: "mist",
  london: "mist",
  celadon: "celadon",
  emerald: "celadon",
  sakura: "sakura",
  ruby: "sakura",
  amber: "amber",
  sunset: "amber",
  gold: "amber",
  violet: "violet",
  aurora: "violet",
  nocturne: "violet",
  mono: "mono",
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
  const accent = rgbToHex(r, g, b);
  // 浅色检查偏灰面板表面 #eef2f7（比纯白更严格），深色检查较亮面板表面 #1c222e（比纯黑更严格）。
  const surfaceRef = dark ? "#1c222e" : "#eef2f7";
  const targetTone = dark ? "#f8fafc" : "#0b0f17";
  const minRatio = 4.6;

  let accentInk = accent;
  if (contrast(accentInk, surfaceRef) < minRatio) {
    let lo = 0;
    let hi = 1;
    for (let step = 0; step < 24; step++) {
      const mid = (lo + hi) / 2;
      const candidate = mixHex(accent, targetTone, mid);
      if (contrast(candidate, surfaceRef) >= minRatio) {
        accentInk = candidate;
        hi = mid;
      } else {
        lo = mid;
      }
    }
    if (contrast(accentInk, surfaceRef) < minRatio) {
      accentInk = targetTone;
    }
  }

  const inkOnAccent =
    contrast("#ffffff", accent) >= contrast("#0f1115", accent)
      ? "#ffffff"
      : "#0f1115";

  return {
    "--accent": accent,
    "--accent-ink": accentInk,
    "--accent-soft": `rgba(${r}, ${g}, ${b}, ${dark ? 0.2 : 0.14})`,
    "--accent-ring": `rgba(${r}, ${g}, ${b}, ${dark ? 0.45 : 0.35})`,
    "--ink-on-accent": inkOnAccent,
  };
}

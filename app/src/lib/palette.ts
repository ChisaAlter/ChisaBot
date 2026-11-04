/**
 * 主题配色（8 套）和它们算出来的天空垫片颜色。
 *
 * 单独成一个不依赖 React / 别名路径的纯模块（2026-10-29，模块 11 审计）：vite.config.ts 要在构建时
 * 把配色表序列化进 index.html 的启动脚本（{@link paletteBootScript}），让启动骨架和地址栏颜色在 JS 加载前
 * 就是用户选的配色，而不是默认蓝天。lib/appearance.ts 照旧 re-export 这里的名字。
 */

export type ThemePaletteId =
  | "default"
  | "aurora"
  | "emerald"
  | "ocean"
  | "sunset"
  | "sakura"
  | "gold"
  | "ruby";

export type ThemePaletteMeta = {
  id: ThemePaletteId;
  name: string;
  subtitle: string;
  accentLight: string;
  accentDark: string;
  swatchGradient: string;
  skyHueLight: [number, number, number, number];
  skySatLight: [number, number, number, number];
  skyHueDark: [number, number, number, number];
  skySatDark: [number, number, number, number];
  /** 默认关联的日间 / 夜间 Hark WebGL 天空场景索引（深色模式统一采用深邃夜景以保障文字对比度） */
  harkSceneLight: number;
  harkSceneDark: number;
};

export const THEME_PALETTES: readonly ThemePaletteMeta[] = [
  {
    id: "default",
    name: "晴空冰蓝",
    subtitle: "澄澈晴空蓝与通透液态玻璃",
    accentLight: "#2f7cf6",
    accentDark: "#5b9cff",
    swatchGradient:
      "linear-gradient(135deg, #1d57a9 0%, #3e7bd1 50%, #6da7ec 100%)",
    skyHueLight: [214, 212, 208, 204],
    skySatLight: [71, 62, 68, 82],
    skyHueDark: [222, 220, 218, 216],
    skySatDark: [45, 42, 38, 34],
    harkSceneLight: 0,
    harkSceneDark: 4,
  },
  {
    id: "aurora",
    name: "极光幻紫",
    subtitle: "星夜紫罗兰与极光流彩",
    accentLight: "#7c3aed",
    accentDark: "#b197fc",
    swatchGradient:
      "linear-gradient(135deg, #6366f1 0%, #8b5cf6 52%, #ec4899 100%)",
    skyHueLight: [258, 266, 276, 245],
    skySatLight: [64, 58, 52, 48],
    skyHueDark: [266, 258, 250, 284],
    skySatDark: [52, 46, 40, 36],
    harkSceneLight: 7,
    harkSceneDark: 2,
  },
  {
    id: "emerald",
    name: "翡翠森境",
    subtitle: "雨后松林薄雾与通透翡翠",
    accentLight: "#059669",
    accentDark: "#38d9a9",
    swatchGradient:
      "linear-gradient(135deg, #059669 0%, #10b981 52%, #2dd4bf 100%)",
    skyHueLight: [164, 168, 172, 158],
    skySatLight: [56, 50, 44, 42],
    skyHueDark: [168, 172, 176, 160],
    skySatDark: [50, 46, 40, 36],
    harkSceneLight: 5,
    harkSceneDark: 4,
  },
  {
    id: "ocean",
    name: "深海蔚蓝",
    subtitle: "太平洋青蓝与冰晶折射高光",
    accentLight: "#0284c7",
    accentDark: "#4dabf7",
    swatchGradient:
      "linear-gradient(135deg, #0369a1 0%, #0ea5e9 50%, #22d3ee 100%)",
    skyHueLight: [196, 199, 202, 192],
    skySatLight: [76, 70, 62, 56],
    skyHueDark: [194, 198, 202, 188],
    skySatDark: [62, 56, 50, 44],
    harkSceneLight: 7,
    harkSceneDark: 2,
  },
  {
    id: "sunset",
    name: "落日琥珀",
    subtitle: "黄金时刻暖橙晚霞与流光",
    accentLight: "#d97706",
    accentDark: "#ffc048",
    swatchGradient:
      "linear-gradient(135deg, #ea580c 0%, #f59e0b 52%, #fb7185 100%)",
    skyHueLight: [28, 34, 40, 18],
    skySatLight: [74, 68, 60, 54],
    skyHueDark: [20, 26, 32, 12],
    skySatDark: [48, 44, 40, 34],
    harkSceneLight: 0,
    harkSceneDark: 4,
  },
  {
    id: "sakura",
    name: "樱花绯粉",
    subtitle: "春日落樱柔粉与微醺暮色",
    accentLight: "#db2777",
    accentDark: "#f783ac",
    swatchGradient:
      "linear-gradient(135deg, #ec4899 0%, #f472b6 50%, #fda4af 100%)",
    skyHueLight: [332, 340, 350, 22],
    skySatLight: [62, 60, 58, 74],
    skyHueDark: [318, 326, 334, 300],
    skySatDark: [46, 42, 38, 32],
    harkSceneLight: 7,
    harkSceneDark: 2,
  },
  {
    id: "gold",
    name: "银杏暖金",
    subtitle: "秋日银杏黄与暖阳鎏金",
    accentLight: "#a16207",
    accentDark: "#facc15",
    swatchGradient:
      "linear-gradient(135deg, #a16207 0%, #eab308 52%, #fde68a 100%)",
    skyHueLight: [46, 44, 42, 38],
    skySatLight: [72, 66, 58, 50],
    skyHueDark: [44, 42, 40, 48],
    skySatDark: [40, 36, 32, 28],
    harkSceneLight: 6,
    harkSceneDark: 4,
  },
  {
    id: "ruby",
    name: "朱砂绛红",
    subtitle: "醇厚朱砂红与蔷薇微醺",
    accentLight: "#dc2626",
    accentDark: "#f87171",
    swatchGradient:
      "linear-gradient(135deg, #991b1b 0%, #dc2626 50%, #fca5a5 100%)",
    skyHueLight: [356, 352, 348, 342],
    skySatLight: [62, 58, 54, 66],
    skyHueDark: [352, 348, 344, 336],
    skySatDark: [42, 38, 34, 30],
    harkSceneLight: 1,
    harkSceneDark: 2,
  },
] as const;

/**
 * 根据当前主题色生成与天空融合的渐变变量（作为 WebGL 首帧绘制前的预渲染垫片）
 */
export function computePaletteSky(
  palette: ThemePaletteId,
  dark: boolean,
): { body: Record<string, string>; root: Record<string, string> } | null {
  if (palette === "default") return null;
  const meta = THEME_PALETTES.find((p) => p.id === palette);
  if (!meta) return null;

  const hues = dark ? meta.skyHueDark : meta.skyHueLight;
  const sats = dark ? meta.skySatDark : meta.skySatLight;
  const lights = dark ? [12, 16, 21, 26] : [54, 66, 78, 88];
  const stops = [0, 1, 2, 3].map(
    (i) => `hsl(${hues[i]} ${sats[i]}% ${lights[i]}%)`,
  );

  return {
    body: {
      "--sky-0": stops[0],
      "--sky-1": stops[1],
      "--sky-2": stops[2],
      "--sky-3": stops[3],
      "--sky-glow": `hsl(${hues[1]} ${Math.min(90, sats[1] + 15)}% ${dark ? 32 : 76}%)`,
      "--sky-glow-a": dark ? "0.42" : "0.52",
    },
    root: {
      "--palette-sky-0": stops[0],
      "--palette-sky-1": stops[1],
      "--palette-sky-2": stops[2],
      "--palette-sky-3": stops[3],
    },
  };
}

/** 默认配色的地址栏 / 状态栏颜色（和 index.html 启动骨架的天空同色）。 */
export const DEFAULT_THEME_COLOR = {
  light: "#9dbddc",
  dark: "#0c1626",
} as const;

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * 地址栏 / PWA 状态栏颜色（meta[name=theme-color]）：跟随应用自己的浅色 / 深色和配色，而不是系统的配色方案。
 * 取天空最上面那一段：浅色取 --sky-2（和默认的 #9dbddc 同一档），深色取 --sky-1。
 */
export function paletteThemeColor(
  palette: ThemePaletteId,
  dark: boolean,
): string {
  const meta =
    palette === "default" ? null : THEME_PALETTES.find((p) => p.id === palette);
  if (!meta) return dark ? DEFAULT_THEME_COLOR.dark : DEFAULT_THEME_COLOR.light;
  const i = dark ? 1 : 2;
  const hues = dark ? meta.skyHueDark : meta.skyHueLight;
  const sats = dark ? meta.skySatDark : meta.skySatLight;
  const lights = dark ? [6, 9, 13, 17] : [54, 66, 78, 88];
  return hslToHex(hues[i], sats[i], lights[i]);
}

/** 把所有 meta[name=theme-color] 改成同一个颜色（两条按系统配色分的 meta 都改，应用主题优先）。 */
export function applyThemeColor(
  color: string,
  doc: Document | undefined = typeof document !== "undefined"
    ? document
    : undefined,
) {
  if (!doc) return;
  for (const meta of doc.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"]',
  )) {
    if (meta.content !== color) meta.content = color;
  }
}

export const PALETTE_STORAGE_KEY = "chisabot-theme-palette";
export const GLASS_STYLE_STORAGE_KEY = "chisabot-glass-style";
const BOOT_GLASS_STYLES = ["liquid", "mist", "crystal", "frosted"];

/**
 * index.html 的启动脚本（vite.config.ts 的 chisabot-sky-boot 插件塞在 <body> 第一行、时段天空之后）：
 * - 用户选了非默认配色：在 <html> 上写 data-palette，body 上写和应用一样的 --sky-0..3 / --sky-glow，
 *   启动骨架（骨架读 --sky-1..4）直接是这套配色；
 * - 写 data-glass，应用挂载时不用再改一次根属性；
 * - meta theme-color 按应用自己的深浅色 + 配色写好。
 * 配色表在构建时算好内联（非 default 各 2 个小对象），运行时不用再算。
 */
export function paletteBootScript(): string {
  const map: Record<
    string,
    {
      l: Record<string, string>;
      d: Record<string, string>;
      tl: string;
      td: string;
    }
  > = {};
  for (const p of THEME_PALETTES) {
    const light = computePaletteSky(p.id, false);
    const dark = computePaletteSky(p.id, true);
    if (!light || !dark) continue;
    map[p.id] = {
      l: light.body,
      d: dark.body,
      tl: paletteThemeColor(p.id, false),
      td: paletteThemeColor(p.id, true),
    };
  }
  return `(function(){try{var d=document.documentElement,s=window.localStorage,M=${JSON.stringify(map)},p=s.getItem(${JSON.stringify(PALETTE_STORAGE_KEY)}),g=s.getItem(${JSON.stringify(GLASS_STYLE_STORAGE_KEY)}),k=d.classList.contains("dark"),c=k?${JSON.stringify(DEFAULT_THEME_COLOR.dark)}:${JSON.stringify(DEFAULT_THEME_COLOR.light)},v,i,m;if(${JSON.stringify(BOOT_GLASS_STYLES)}.indexOf(g)>=0)d.setAttribute("data-glass",g);if(p&&M[p]){d.setAttribute("data-palette",p);v=M[p][k?"d":"l"];for(i in v)document.body.style.setProperty(i,v[i]);c=M[p][k?"td":"tl"]}m=document.querySelectorAll('meta[name="theme-color"]');for(i=0;i<m.length;i++)m[i].setAttribute("content",c)}catch(e){}})();`;
}

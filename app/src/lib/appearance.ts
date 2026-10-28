import { useSyncExternalStore } from "react";
import {
  readStoredPreference,
  writeStoredPreference,
} from "@/lib/preference-storage";

export const PALETTE_STORAGE_KEY = "chisabot-theme-palette";
export const WALLPAPER_ID_STORAGE_KEY = "chisabot-wallpaper-id";
export const WALLPAPER_CUSTOM_URL_STORAGE_KEY = "chisabot-wallpaper-custom-url";
export const WALLPAPER_BLUR_STORAGE_KEY = "chisabot-wallpaper-blur";
export const WALLPAPER_DIM_STORAGE_KEY = "chisabot-wallpaper-dim";
export const GLASS_STYLE_STORAGE_KEY = "chisabot-glass-style";
export const GLASS_OPACITY_STORAGE_KEY = "chisabot-glass-opacity";
export const HARK_SCENE_STORAGE_KEY = "chisabot-hark-scene";

export type ThemePaletteId =
  | "default"
  | "aurora"
  | "emerald"
  | "ocean"
  | "sunset"
  | "sakura";

export type GlassStyleId = "liquid" | "crystal" | "frosted";

/**
 * Hark 原生 WebGL 动态天空与天气引擎（wallpaper_core.html）精选场景 + 自动跟随模式。
 * - "auto": 根据当前主题配色与浅色/深色模式自动匹配最佳 Hark 动态天空场景（深色模式固定匹配深邃夜幕，保障浅色文字 100% 清晰可见）
 * - "live": 根据当前时间与实时天气（Open-Meteo）动态演算太阳高度、瑞利散射与云层
 * - "0".."11": 对应 wallpaper_core.html 中 SCENES[0..11] 的地标与气象时刻
 */
export type HarkSkySceneId =
  | "auto"
  | "live"
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "11";

export type HarkSkySceneMeta = {
  id: HarkSkySceneId;
  sceneIndex: number | null;
  name: string;
  subtitle: string;
  previewGradient: string;
  isNight: boolean;
};

export const HARK_SKY_SCENES: readonly HarkSkySceneMeta[] = [
  {
    id: "auto",
    sceneIndex: null,
    name: "智能跟随主题",
    subtitle: "浅色呈现晴空流云，深色自动切换静谧夜幕",
    previewGradient: "linear-gradient(180deg, #1d57a9 0%, #3e7bd1 42%, #6da7ec 76%, #b0d5f7 100%)",
    isNight: false,
  },
  {
    id: "live",
    sceneIndex: -1,
    name: "实时动态天象",
    subtitle: "按真实太阳轨迹与实时云量动态演进",
    previewGradient: "linear-gradient(180deg, #164e9f 0%, #3875ca 45%, #79b0ef 80%, #cbe3fa 100%)",
    isNight: false,
  },
  {
    id: "0",
    sceneIndex: 0,
    name: "晴空流云 · 帕洛阿尔托",
    subtitle: "Palo Alto · 午后澄澈蓝天与立体体积积云",
    previewGradient: "linear-gradient(180deg, #1d57a9 0%, #3e7bd1 40%, #6da7ec 75%, #b0d5f7 100%)",
    isNight: false,
  },
  {
    id: "6",
    sceneIndex: 6,
    name: "落日暖金 · 凤凰城",
    subtitle: "Phoenix · 黄金时刻暖阳散射与流云",
    previewGradient: "linear-gradient(180deg, #2b5899 0%, #5c7db0 38%, #b88b7c 72%, #f0b175 100%)",
    isNight: false,
  },
  {
    id: "5",
    sceneIndex: 5,
    name: "高山雪霁 · 太浩湖",
    subtitle: "Lake Tahoe · 清冽冰晶天光与层叠云海",
    previewGradient: "linear-gradient(180deg, #4b6cb7 0%, #6d8ec9 42%, #9bb4de 76%, #cfe0f5 100%)",
    isNight: false,
  },
  {
    id: "4",
    sceneIndex: 4,
    name: "静谧星夜 · 柏林",
    subtitle: "Berlin · 深邃夜空与微光云层",
    previewGradient: "linear-gradient(180deg, #090d18 0%, #10182b 42%, #18233c 76%, #22304e 100%)",
    isNight: true,
  },
] as const;

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
    swatchGradient: "linear-gradient(135deg, #1d57a9 0%, #3e7bd1 50%, #6da7ec 100%)",
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
    swatchGradient: "linear-gradient(135deg, #6366f1 0%, #8b5cf6 52%, #ec4899 100%)",
    skyHueLight: [258, 266, 276, 245],
    skySatLight: [64, 58, 52, 48],
    skyHueDark: [258, 252, 246, 264],
    skySatDark: [44, 40, 36, 32],
    harkSceneLight: 7,
    harkSceneDark: 2,
  },
  {
    id: "emerald",
    name: "翡翠森境",
    subtitle: "雨后松林薄雾与通透翡翠",
    accentLight: "#059669",
    accentDark: "#38d9a9",
    swatchGradient: "linear-gradient(135deg, #059669 0%, #10b981 52%, #2dd4bf 100%)",
    skyHueLight: [164, 168, 172, 158],
    skySatLight: [56, 50, 44, 42],
    skyHueDark: [172, 176, 180, 168],
    skySatDark: [38, 34, 30, 28],
    harkSceneLight: 5,
    harkSceneDark: 4,
  },
  {
    id: "ocean",
    name: "深海蔚蓝",
    subtitle: "太平洋青蓝与冰晶折射高光",
    accentLight: "#0284c7",
    accentDark: "#4dabf7",
    swatchGradient: "linear-gradient(135deg, #0369a1 0%, #0ea5e9 50%, #22d3ee 100%)",
    skyHueLight: [196, 199, 202, 192],
    skySatLight: [76, 70, 62, 56],
    skyHueDark: [204, 208, 212, 200],
    skySatDark: [48, 44, 40, 36],
    harkSceneLight: 7,
    harkSceneDark: 2,
  },
  {
    id: "sunset",
    name: "落日琥珀",
    subtitle: "黄金时刻暖橙晚霞与流光",
    accentLight: "#d97706",
    accentDark: "#ffc048",
    swatchGradient: "linear-gradient(135deg, #ea580c 0%, #f59e0b 52%, #fb7185 100%)",
    skyHueLight: [28, 34, 40, 18],
    skySatLight: [74, 68, 60, 54],
    skyHueDark: [224, 220, 216, 228],
    skySatDark: [36, 32, 28, 26],
    harkSceneLight: 0,
    harkSceneDark: 4,
  },
  {
    id: "sakura",
    name: "樱花绯粉",
    subtitle: "春日落樱柔粉与微醺暮色",
    accentLight: "#db2777",
    accentDark: "#f783ac",
    swatchGradient: "linear-gradient(135deg, #ec4899 0%, #f472b6 50%, #fda4af 100%)",
    skyHueLight: [336, 342, 348, 326],
    skySatLight: [66, 60, 54, 48],
    skyHueDark: [248, 242, 236, 254],
    skySatDark: [36, 32, 28, 26],
    harkSceneLight: 7,
    harkSceneDark: 2,
  },
] as const;

export type WallpaperPresetId =
  | "none"
  | "aurora-mesh"
  | "cyber-neon"
  | "mountain-mist"
  | "ocean-abyss"
  | "sakura-dream"
  | "sunset-dunes"
  | "starlight-cosmos"
  | "custom";

export type WallpaperPresetMeta = {
  id: Exclude<WallpaperPresetId, "custom">;
  name: string;
  subtitle: string;
  previewBackground: string;
  cssImage: string | null;
};

function svgDataUri(svg: string): string {
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg.trim().replace(/\s+/g, " "))}")`;
}

export const WALLPAPER_PRESETS: readonly WallpaperPresetMeta[] = [
  {
    id: "none",
    name: "Hark 动态天空（默认）",
    subtitle: "使用 Hark 原生 WebGL 实时大气散射与流云引擎",
    previewBackground:
      "linear-gradient(180deg, #1d57a9 0%, #3e7bd1 40%, #6da7ec 76%, #b0d5f7 100%)",
    cssImage: null,
  },
  {
    id: "aurora-mesh",
    name: "极光流彩星云",
    subtitle: "柔焦紫青极光丝带与深邃星芒",
    previewBackground:
      "radial-gradient(circle at 20% 20%, #8b5cf6 0%, transparent 55%), radial-gradient(circle at 80% 30%, #06b6d4 0%, transparent 55%), radial-gradient(circle at 50% 80%, #ec4899 0%, transparent 60%), linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #090d16 100%)",
    cssImage: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#0b1120"/>
            <stop offset="50%" stop-color="#1e1b4b"/>
            <stop offset="100%" stop-color="#090d16"/>
          </linearGradient>
          <radialGradient id="g1" cx="22%" cy="24%" r="52%">
            <stop offset="0%" stop-color="#8b5cf6" stop-opacity="0.78"/>
            <stop offset="55%" stop-color="#6366f1" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="g2" cx="82%" cy="28%" r="48%">
            <stop offset="0%" stop-color="#06b6d4" stop-opacity="0.72"/>
            <stop offset="55%" stop-color="#0ea5e9" stop-opacity="0.25"/>
            <stop offset="100%" stop-color="#0ea5e9" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="g3" cx="54%" cy="82%" r="55%">
            <stop offset="0%" stop-color="#ec4899" stop-opacity="0.62"/>
            <stop offset="55%" stop-color="#a855f7" stop-opacity="0.2"/>
            <stop offset="100%" stop-color="#a855f7" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="g4" cx="18%" cy="78%" r="42%">
            <stop offset="0%" stop-color="#2dd4bf" stop-opacity="0.5"/>
            <stop offset="100%" stop-color="#2dd4bf" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <rect width="1600" height="1000" fill="url(#bg)"/>
        <rect width="1600" height="1000" fill="url(#g1)"/>
        <rect width="1600" height="1000" fill="url(#g2)"/>
        <rect width="1600" height="1000" fill="url(#g3)"/>
        <rect width="1600" height="1000" fill="url(#g4)"/>
        <path d="M-100,620 C320,420 680,780 1120,500 C1360,350 1520,480 1720,390 L1720,1050 L-100,1050 Z" fill="#ffffff" fill-opacity="0.04"/>
        <path d="M-100,320 C380,540 820,160 1280,420 C1480,530 1600,380 1720,440 L1720,1050 L-100,1050 Z" fill="#38bdf8" fill-opacity="0.06"/>
      </svg>
    `),
  },
  {
    id: "mountain-mist",
    name: "远山云海晨雾",
    subtitle: "层叠水墨青峦与清晨柔光云海",
    previewBackground:
      "linear-gradient(180deg, #93c5fd 0%, #e0f2fe 45%, #64748b 78%, #1e293b 100%)",
    cssImage: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#38bdf8"/>
            <stop offset="38%" stop-color="#bae6fd"/>
            <stop offset="68%" stop-color="#f8fafc"/>
            <stop offset="100%" stop-color="#cbd5e1"/>
          </linearGradient>
          <radialGradient id="sun" cx="72%" cy="26%" r="36%">
            <stop offset="0%" stop-color="#fef08a" stop-opacity="0.85"/>
            <stop offset="50%" stop-color="#fde047" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="#fde047" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <rect width="1600" height="1000" fill="url(#sky)"/>
        <rect width="1600" height="1000" fill="url(#sun)"/>
        <path d="M0,560 L220,430 L460,520 L740,370 L1020,490 L1310,360 L1600,470 L1600,1000 L0,1000 Z" fill="#64748b" fill-opacity="0.35"/>
        <path d="M0,650 L180,540 L420,610 L690,480 L980,590 L1240,460 L1460,550 L1600,510 L1600,1000 L0,1000 Z" fill="#475569" fill-opacity="0.52"/>
        <path d="M0,760 L260,640 L520,720 L840,590 L1140,700 L1410,610 L1600,670 L1600,1000 L0,1000 Z" fill="#334155" fill-opacity="0.74"/>
        <path d="M0,850 L310,770 L640,830 L960,740 L1290,820 L1600,750 L1600,1000 L0,1000 Z" fill="#1e293b" fill-opacity="0.9"/>
      </svg>
    `),
  },
  {
    id: "ocean-abyss",
    name: "蔚蓝珊瑚海湾",
    subtitle: "阳光穿透清澈海水的丁达尔波光",
    previewBackground:
      "radial-gradient(circle at 50% 0%, #67e8f9 0%, #0284c7 52%, #0c4a6e 100%)",
    cssImage: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#22d3ee"/>
            <stop offset="35%" stop-color="#0284c7"/>
            <stop offset="75%" stop-color="#075985"/>
            <stop offset="100%" stop-color="#082f49"/>
          </linearGradient>
          <radialGradient id="topGlow" cx="50%" cy="6%" r="58%">
            <stop offset="0%" stop-color="#cffafe" stop-opacity="0.9"/>
            <stop offset="50%" stop-color="#38bdf8" stop-opacity="0.35"/>
            <stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <rect width="1600" height="1000" fill="url(#sea)"/>
        <rect width="1600" height="1000" fill="url(#topGlow)"/>
        <polygon points="800,-40 280,1000 480,1000" fill="#ffffff" fill-opacity="0.07"/>
        <polygon points="800,-40 620,1000 840,1000" fill="#ffffff" fill-opacity="0.09"/>
        <polygon points="800,-40 980,1000 1240,1000" fill="#ffffff" fill-opacity="0.07"/>
        <path d="M0,720 Q400,640 800,720 T1600,700 L1600,1000 L0,1000 Z" fill="#0369a1" fill-opacity="0.45"/>
        <path d="M0,840 Q400,780 800,840 T1600,820 L1600,1000 L0,1000 Z" fill="#082f49" fill-opacity="0.65"/>
      </svg>
    `),
  },
  {
    id: "sakura-dream",
    name: "绯樱暮色天际",
    subtitle: "柔和暮春粉霞与梦幻流光光斑",
    previewBackground:
      "radial-gradient(circle at 25% 25%, #fbcfe8 0%, transparent 50%), radial-gradient(circle at 75% 70%, #f43f5e 0%, transparent 55%), linear-gradient(135deg, #4c1d95 0%, #831843 55%, #be185d 100%)",
    cssImage: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="sbg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#3b0764"/>
            <stop offset="48%" stop-color="#831843"/>
            <stop offset="100%" stop-color="#fb7185"/>
          </linearGradient>
          <radialGradient id="sp1" cx="25%" cy="30%" r="45%">
            <stop offset="0%" stop-color="#f9a8d4" stop-opacity="0.72"/>
            <stop offset="100%" stop-color="#f9a8d4" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="sp2" cx="78%" cy="24%" r="42%">
            <stop offset="0%" stop-color="#c084fc" stop-opacity="0.65"/>
            <stop offset="100%" stop-color="#c084fc" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="sp3" cx="65%" cy="78%" r="50%">
            <stop offset="0%" stop-color="#fda4af" stop-opacity="0.68"/>
            <stop offset="100%" stop-color="#fda4af" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <rect width="1600" height="1000" fill="url(#sbg)"/>
        <rect width="1600" height="1000" fill="url(#sp1)"/>
        <rect width="1600" height="1000" fill="url(#sp2)"/>
        <rect width="1600" height="1000" fill="url(#sp3)"/>
        <circle cx="320" cy="240" r="90" fill="#ffffff" fill-opacity="0.1"/>
        <circle cx="1180" cy="360" r="140" fill="#ffffff" fill-opacity="0.08"/>
        <circle cx="860" cy="680" r="110" fill="#ffffff" fill-opacity="0.09"/>
      </svg>
    `),
  },
  {
    id: "sunset-dunes",
    name: "落日余晖沙丘",
    subtitle: "温暖琥珀金霞与丝绸曲线沙丘",
    previewBackground:
      "linear-gradient(160deg, #7c2d12 0%, #ea580c 42%, #f59e0b 75%, #fef08a 100%)",
    cssImage: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="dsky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#431407"/>
            <stop offset="36%" stop-color="#9a3412"/>
            <stop offset="70%" stop-color="#ea580c"/>
            <stop offset="100%" stop-color="#fbbf24"/>
          </linearGradient>
          <radialGradient id="dsun" cx="62%" cy="44%" r="32%">
            <stop offset="0%" stop-color="#fef9c3" stop-opacity="0.92"/>
            <stop offset="45%" stop-color="#fb923c" stop-opacity="0.45"/>
            <stop offset="100%" stop-color="#fb923c" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <rect width="1600" height="1000" fill="url(#dsky)"/>
        <rect width="1600" height="1000" fill="url(#dsun)"/>
        <circle cx="992" cy="440" r="115" fill="#fef08a" fill-opacity="0.72"/>
        <path d="M0,680 Q420,560 920,700 T1600,640 L1600,1000 L0,1000 Z" fill="#9a3412" fill-opacity="0.68"/>
        <path d="M0,780 Q560,670 1080,810 T1600,760 L1600,1000 L0,1000 Z" fill="#7c2d12" fill-opacity="0.82"/>
        <path d="M0,880 Q380,810 860,900 T1600,860 L1600,1000 L0,1000 Z" fill="#431407" fill-opacity="0.92"/>
      </svg>
    `),
  },
  {
    id: "cyber-neon",
    name: "赛博霓虹棱镜",
    subtitle: "未来感几何光栅与品红青蓝折射",
    previewBackground:
      "radial-gradient(circle at 80% 20%, #f43f5e 0%, transparent 48%), radial-gradient(circle at 20% 80%, #06b6d4 0%, transparent 52%), linear-gradient(135deg, #090d16 0%, #1e1b4b 52%, #311042 100%)",
    cssImage: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="cbg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#060913"/>
            <stop offset="50%" stop-color="#17153b"/>
            <stop offset="100%" stop-color="#2e1035"/>
          </linearGradient>
          <radialGradient id="cn1" cx="78%" cy="22%" r="48%">
            <stop offset="0%" stop-color="#f43f5e" stop-opacity="0.7"/>
            <stop offset="60%" stop-color="#a855f7" stop-opacity="0.24"/>
            <stop offset="100%" stop-color="#a855f7" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="cn2" cx="20%" cy="76%" r="50%">
            <stop offset="0%" stop-color="#06b6d4" stop-opacity="0.72"/>
            <stop offset="60%" stop-color="#3b82f6" stop-opacity="0.24"/>
            <stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <rect width="1600" height="1000" fill="url(#cbg)"/>
        <rect width="1600" height="1000" fill="url(#cn1)"/>
        <rect width="1600" height="1000" fill="url(#cn2)"/>
        <g stroke="#ffffff" stroke-opacity="0.07" stroke-width="1.5" fill="none">
          <circle cx="800" cy="500" r="220"/>
          <circle cx="800" cy="500" r="380"/>
          <circle cx="800" cy="500" r="560"/>
          <line x1="0" y1="500" x2="1600" y2="500"/>
          <line x1="800" y1="0" x2="800" y2="1000"/>
        </g>
      </svg>
    `),
  },
  {
    id: "starlight-cosmos",
    name: "深空星河静夜",
    subtitle: "静谧银河星尘与深邃午夜蓝黑",
    previewBackground:
      "radial-gradient(circle at 65% 35%, #3b82f6 0%, transparent 45%), radial-gradient(circle at 30% 65%, #6366f1 0%, transparent 50%), linear-gradient(180deg, #030712 0%, #0f172a 60%, #1e293b 100%)",
    cssImage: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="stbg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#030712"/>
            <stop offset="55%" stop-color="#0f172a"/>
            <stop offset="100%" stop-color="#1e293b"/>
          </linearGradient>
          <radialGradient id="neb" cx="62%" cy="38%" r="48%">
            <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.42"/>
            <stop offset="55%" stop-color="#6366f1" stop-opacity="0.16"/>
            <stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <rect width="1600" height="1000" fill="url(#stbg)"/>
        <rect width="1600" height="1000" fill="url(#neb)"/>
        <g fill="#ffffff">
          <circle cx="220" cy="180" r="2" fill-opacity="0.8"/>
          <circle cx="480" cy="120" r="1.5" fill-opacity="0.6"/>
          <circle cx="760" cy="240" r="2.2" fill-opacity="0.85"/>
          <circle cx="1080" cy="160" r="1.8" fill-opacity="0.7"/>
          <circle cx="1390" cy="280" r="2.4" fill-opacity="0.9"/>
          <circle cx="340" cy="420" r="1.6" fill-opacity="0.55"/>
          <circle cx="920" cy="460" r="2" fill-opacity="0.75"/>
          <circle cx="1260" cy="520" r="1.5" fill-opacity="0.6"/>
          <circle cx="620" cy="680" r="1.8" fill-opacity="0.65"/>
        </g>
      </svg>
    `),
  },
] as const;

export type AppearanceState = {
  palette: ThemePaletteId;
  glassStyle: GlassStyleId;
  /** 玻璃面板不透明度（8 ~ 55，默认 16，即 84% 透光率） */
  glassOpacity: number;
  /** Hark WebGL 动态天空场景（默认 "auto"） */
  harkScene: HarkSkySceneId;
  wallpaperId: WallpaperPresetId;
  customWallpaperUrl: string;
  wallpaperBlur: number;
  wallpaperDim: number;
};

const VALID_PALETTES = new Set<ThemePaletteId>(
  THEME_PALETTES.map((p) => p.id),
);
const VALID_GLASS_STYLES = new Set<GlassStyleId>([
  "liquid",
  "crystal",
  "frosted",
]);
const VALID_HARK_SCENES = new Set<HarkSkySceneId>([
  "auto",
  "live",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
]);
const VALID_WALLPAPER_IDS = new Set<WallpaperPresetId>([
  ...WALLPAPER_PRESETS.map((w) => w.id),
  "custom",
]);

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readInitialAppearance(): AppearanceState {
  const rawPalette = readStoredPreference(PALETTE_STORAGE_KEY) as ThemePaletteId | null;
  const rawGlass = readStoredPreference(GLASS_STYLE_STORAGE_KEY) as GlassStyleId | null;
  const rawGlassOpacity = Number(readStoredPreference(GLASS_OPACITY_STORAGE_KEY) ?? "16");
  const rawHarkScene = readStoredPreference(HARK_SCENE_STORAGE_KEY) as HarkSkySceneId | null;
  const rawWallpaperId = readStoredPreference(WALLPAPER_ID_STORAGE_KEY) as WallpaperPresetId | null;
  const customWallpaperUrl = readStoredPreference(WALLPAPER_CUSTOM_URL_STORAGE_KEY) ?? "";
  const rawBlur = Number(readStoredPreference(WALLPAPER_BLUR_STORAGE_KEY) ?? "0");
  const rawDim = Number(readStoredPreference(WALLPAPER_DIM_STORAGE_KEY) ?? "18");

  return {
    palette: rawPalette && VALID_PALETTES.has(rawPalette) ? rawPalette : "default",
    glassStyle: rawGlass && VALID_GLASS_STYLES.has(rawGlass) ? rawGlass : "liquid",
    glassOpacity: clampNumber(rawGlassOpacity, 5, 55, 16),
    harkScene: rawHarkScene && VALID_HARK_SCENES.has(rawHarkScene) ? rawHarkScene : "auto",
    wallpaperId:
      rawWallpaperId && VALID_WALLPAPER_IDS.has(rawWallpaperId) ? rawWallpaperId : "none",
    customWallpaperUrl,
    wallpaperBlur: clampNumber(rawBlur, 0, 40, 0),
    wallpaperDim: clampNumber(rawDim, 0, 75, 18),
  };
}

let currentState: AppearanceState | null = null;
const listeners = new Set<() => void>();

function ensureState(): AppearanceState {
  if (!currentState) {
    currentState = readInitialAppearance();
  }
  return currentState;
}

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

export function getAppearanceState(): AppearanceState {
  return ensureState();
}

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppearance(): AppearanceState {
  return useSyncExternalStore(subscribeAppearance, getAppearanceState, getAppearanceState);
}

export function applyAppearanceToDocument(state: AppearanceState = ensureState()) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-palette", state.palette);
  root.setAttribute("data-glass", state.glassStyle);
  root.style.setProperty("--lg-alpha", (state.glassOpacity / 100).toFixed(2));
  const hasWallpaper = resolveActiveWallpaperCss(state) !== null;
  if (hasWallpaper) {
    root.setAttribute("data-wallpaper", "on");
  } else {
    root.removeAttribute("data-wallpaper");
  }
}

export function updateAppearance(patch: Partial<AppearanceState>) {
  const prev = ensureState();
  const next: AppearanceState = {
    palette:
      patch.palette && VALID_PALETTES.has(patch.palette) ? patch.palette : prev.palette,
    glassStyle:
      patch.glassStyle && VALID_GLASS_STYLES.has(patch.glassStyle)
        ? patch.glassStyle
        : prev.glassStyle,
    glassOpacity:
      patch.glassOpacity !== undefined
        ? clampNumber(patch.glassOpacity, 5, 55, prev.glassOpacity)
        : prev.glassOpacity,
    harkScene:
      patch.harkScene && VALID_HARK_SCENES.has(patch.harkScene)
        ? patch.harkScene
        : prev.harkScene,
    wallpaperId:
      patch.wallpaperId && VALID_WALLPAPER_IDS.has(patch.wallpaperId)
        ? patch.wallpaperId
        : prev.wallpaperId,
    customWallpaperUrl:
      patch.customWallpaperUrl !== undefined
        ? patch.customWallpaperUrl.trim()
        : prev.customWallpaperUrl,
    wallpaperBlur:
      patch.wallpaperBlur !== undefined
        ? clampNumber(patch.wallpaperBlur, 0, 40, prev.wallpaperBlur)
        : prev.wallpaperBlur,
    wallpaperDim:
      patch.wallpaperDim !== undefined
        ? clampNumber(patch.wallpaperDim, 0, 75, prev.wallpaperDim)
        : prev.wallpaperDim,
  };

  currentState = next;
  // Only the keys that changed are written: one slider tick used to rewrite all eight keys,
  // including the custom wallpaper's data URL. The keys and their format are unchanged.
  const writes: Array<[string, string, string]> = [
    [PALETTE_STORAGE_KEY, prev.palette, next.palette],
    [GLASS_STYLE_STORAGE_KEY, prev.glassStyle, next.glassStyle],
    [GLASS_OPACITY_STORAGE_KEY, String(prev.glassOpacity), String(next.glassOpacity)],
    [HARK_SCENE_STORAGE_KEY, prev.harkScene, next.harkScene],
    [WALLPAPER_ID_STORAGE_KEY, prev.wallpaperId, next.wallpaperId],
    [WALLPAPER_CUSTOM_URL_STORAGE_KEY, prev.customWallpaperUrl, next.customWallpaperUrl],
    [WALLPAPER_BLUR_STORAGE_KEY, String(prev.wallpaperBlur), String(next.wallpaperBlur)],
    [WALLPAPER_DIM_STORAGE_KEY, String(prev.wallpaperDim), String(next.wallpaperDim)],
  ];
  for (const [key, before, after] of writes) {
    if (before !== after) writeStoredPreference(key, after);
  }

  applyAppearanceToDocument(next);
  emitChange();
}

export function setThemePalette(palette: ThemePaletteId) {
  updateAppearance({ palette });
}

export function setGlassStyle(glassStyle: GlassStyleId) {
  updateAppearance({ glassStyle });
}

export function setGlassOpacity(glassOpacity: number) {
  updateAppearance({ glassOpacity });
}

export function setHarkSkyScene(harkScene: HarkSkySceneId) {
  updateAppearance({ harkScene, wallpaperId: "none" });
}

export function setWallpaperPreset(wallpaperId: WallpaperPresetId) {
  updateAppearance({ wallpaperId });
}

export function setCustomWallpaperUrl(url: string) {
  const trimmed = url.trim();
  updateAppearance({
    customWallpaperUrl: trimmed,
    wallpaperId: trimmed ? "custom" : "none",
  });
}

export function setWallpaperBlur(wallpaperBlur: number) {
  updateAppearance({ wallpaperBlur });
}

export function setWallpaperDim(wallpaperDim: number) {
  updateAppearance({ wallpaperDim });
}

export function resetAppearanceDefaults() {
  updateAppearance({
    palette: "default",
    glassStyle: "liquid",
    glassOpacity: 16,
    harkScene: "auto",
    wallpaperId: "none",
    customWallpaperUrl: "",
    wallpaperBlur: 0,
    wallpaperDim: 18,
  });
}

/**
 * 解析当前应当驱动 Hark WebGL 天空（window.hark）的场景：
 * - 返回 "live" 表示调用 window.hark.setLive(true)
 * - 返回 0..11 表示调用 window.hark.applyScene(index)
 */
export function resolveEffectiveHarkScene(
  state: AppearanceState,
  dark: boolean,
): "live" | number {
  if (state.harkScene === "live") return "live";
  if (state.harkScene !== "auto") {
    const idx = Number(state.harkScene);
    if (Number.isInteger(idx) && idx >= 0 && idx <= 11) return idx;
  }
  const meta = THEME_PALETTES.find((p) => p.id === state.palette) ?? THEME_PALETTES[0];
  return dark ? meta.harkSceneDark : meta.harkSceneLight;
}

export function resolveActiveWallpaperCss(state: AppearanceState): string | null {
  if (state.wallpaperId === "none") return null;
  if (state.wallpaperId === "custom") {
    const u = state.customWallpaperUrl.trim();
    if (!u) return null;
    if (/^(https?:\/\/|data:image\/|blob:|\/)/i.test(u)) {
      return `url("${u.replace(/"/g, '\\"')}")`;
    }
    return null;
  }
  const found = WALLPAPER_PRESETS.find((w) => w.id === state.wallpaperId);
  return found?.cssImage ?? null;
}

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
  const lights = dark ? [6, 9, 13, 17] : [54, 66, 78, 88];
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
      "--glass-sky": stops[2],
    },
  };
}

/**
 * 将本地上传的图片文件压缩为适配 localStorage 存储的 Data URL（最大边 1920px，WebP/JPEG 质量 0.84）
 */
export async function compressUploadedWallpaper(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片文件失败"));
    reader.onload = () => {
      const src = typeof reader.result === "string" ? reader.result : "";
      if (!src) {
        reject(new Error("图片内容为空"));
        return;
      }
      const img = new Image();
      img.onerror = () => reject(new Error("无法解析该图片格式"));
      img.onload = () => {
        const maxSide = 1920;
        let { width, height } = img;
        if (width > maxSide || height > maxSide) {
          const ratio = Math.min(maxSide / width, maxSide / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(src);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        const webp = canvas.toDataURL("image/webp", 0.84);
        if (webp && webp.length < 3_500_000) {
          resolve(webp);
          return;
        }
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}

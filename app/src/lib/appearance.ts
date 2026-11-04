import { useSyncExternalStore } from "react";
import {
  GLASS_STYLE_STORAGE_KEY,
  PALETTE_STORAGE_KEY,
  THEME_PALETTES,
  type ThemePaletteId,
} from "@/lib/palette";
import {
  readStoredPreference,
  writeStoredPreference,
} from "@/lib/preference-storage";
import {
  getWallpaperBackend,
  WALLPAPER_IDB_MARKER,
} from "@/lib/wallpaper-store";
import { compressWallpaperImage } from "@/lib/wallpaper-compress";

// 配色表搬到了纯模块 lib/palette.ts（构建时要内联进 index.html 的启动脚本），这里照旧导出。
export {
  applyThemeColor,
  computePaletteSky,
  GLASS_STYLE_STORAGE_KEY,
  PALETTE_STORAGE_KEY,
  paletteThemeColor,
  THEME_PALETTES,
  type ThemePaletteId,
  type ThemePaletteMeta,
} from "@/lib/palette";
export const WALLPAPER_ID_STORAGE_KEY = "chisabot-wallpaper-id";
export const WALLPAPER_CUSTOM_URL_STORAGE_KEY = "chisabot-wallpaper-custom-url";
export const WALLPAPER_BLUR_STORAGE_KEY = "chisabot-wallpaper-blur";
export const WALLPAPER_DIM_STORAGE_KEY = "chisabot-wallpaper-dim";
export const GLASS_OPACITY_STORAGE_KEY = "chisabot-glass-opacity";
/** 深色模式自己的一档釉色浓度（和浅色档分开存，切主题时各自滑行到各自的值）。 */
export const GLASS_OPACITY_DARK_STORAGE_KEY = "chisabot-glass-opacity-dark";
export const HARK_SCENE_STORAGE_KEY = "chisabot-hark-scene";
/**
 * 天空引擎（public/wallpaper_core.html 的 SAVE_KEY）存的地点和天气快照。不归 AppearanceState 管，
 * 但「恢复默认」要一起清掉（模块 11 第 13 条）。
 */
export const HARK_WEATHER_SNAPSHOT_STORAGE_KEY = "hark-wallpaper-v1";
/** 天空引擎写进 localStorage 的全部键。 */
export const HARK_ENGINE_STORAGE_KEYS: readonly string[] = [
  HARK_WEATHER_SNAPSHOT_STORAGE_KEY,
];
/** 面板雾度（玻璃不透明度，%）允许的范围：存储、读取和设置页滑块共用。 */
export const GLASS_OPACITY_MIN = 5;
export const GLASS_OPACITY_MAX = 55;

export type GlassStyleId = "liquid" | "mist" | "crystal" | "frosted";

/**
 * Hark 原生 WebGL 动态天空与天气引擎（wallpaper_core.html）精选场景 + 自动跟随模式。
 * - "auto": 根据当前主题配色与浅色/深色模式自动匹配最佳 Hark 动态天空场景（深色模式固定匹配深邃夜幕，保障浅色文字 100% 清晰可见）
 * - "live": 根据当前时间与实时天气（Open-Meteo）动态演算太阳高度、瑞利散射与云层
 * - "0".."11": 对应 wallpaper_core.html 中 SCENES[0..11] 的地标与气象时刻；设置页精选 8 张卡
 *   （auto / live + 6 个互不相同的场景：晨霞、晴空、暖金、雪霁、风暴、星夜）
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
    // 昼 / 夜对半分：一眼看出它会跟着主题变
    previewGradient:
      "linear-gradient(135deg, #4a8fdf 0%, #4a8fdf 44%, #0d1526 56%, #1c2a4a 100%)",
    isNight: false,
  },
  {
    id: "live",
    sceneIndex: -1,
    name: "实时动态天象",
    subtitle: "按真实太阳轨迹与实时云量动态演进",
    // 蓝天尽头压一道太阳位置的暖光：示意它跟着真实太阳走
    previewGradient:
      "linear-gradient(180deg, #1d57a9 0%, #3e7bd1 42%, #e89a5a 82%, #f5c87e 100%)",
    isNight: false,
  },
  {
    id: "11",
    sceneIndex: 11,
    name: "晨霞初晓 · 檀香山",
    subtitle: "Honolulu · 日出粉紫霞光与海岸晨雾",
    previewGradient:
      "linear-gradient(180deg, #3b3f8f 0%, #7c5cad 35%, #d67fa8 68%, #f5b3a1 100%)",
    isNight: false,
  },
  {
    id: "0",
    sceneIndex: 0,
    name: "晴空流云 · 帕洛阿尔托",
    subtitle: "Palo Alto · 午后澄澈蓝天与立体体积积云",
    previewGradient:
      "linear-gradient(180deg, #1466c2 0%, #3b8de0 48%, #7db8ef 82%, #b8dcf8 100%)",
    isNight: false,
  },
  {
    id: "6",
    sceneIndex: 6,
    name: "落日暖金 · 凤凰城",
    subtitle: "Phoenix · 黄金时刻暖阳散射与流云",
    previewGradient:
      "linear-gradient(180deg, #31497c 0%, #6d5d93 38%, #c97e5e 72%, #f2ac63 100%)",
    isNight: false,
  },
  {
    id: "5",
    sceneIndex: 5,
    name: "高山雪霁 · 太浩湖",
    subtitle: "Lake Tahoe · 清冽冰晶天光与层叠云海",
    previewGradient:
      "linear-gradient(180deg, #6d93c9 0%, #9dbce4 42%, #cfe0f4 75%, #eaf3fb 100%)",
    isNight: false,
  },
  {
    id: "10",
    sceneIndex: 10,
    name: "风暴雷云 · 迈阿密",
    subtitle: "Miami · 黄昏雷雨云墙与疾风",
    previewGradient:
      "linear-gradient(180deg, #141d29 0%, #22303f 42%, #354a5e 78%, #4a637c 100%)",
    isNight: true,
  },
  {
    id: "4",
    sceneIndex: 4,
    name: "静谧星夜 · 柏林",
    subtitle: "Berlin · 深邃夜空与微光云层",
    previewGradient:
      "linear-gradient(180deg, #090d18 0%, #10182b 42%, #18233c 76%, #22304e 100%)",
    isNight: true,
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
  /** 玻璃面板不透明度（8 ~ 55，默认 16，即 84% 透光率）——浅色档 */
  glassOpacity: number;
  /** 深色档（同上；未存过时跟随浅色档的值） */
  glassOpacityDark: number;
  /** Hark WebGL 动态天空场景（默认 "auto"） */
  harkScene: HarkSkySceneId;
  wallpaperId: WallpaperPresetId;
  customWallpaperUrl: string;
  wallpaperBlur: number;
  wallpaperDim: number;
};

const VALID_PALETTES = new Set<ThemePaletteId>(THEME_PALETTES.map((p) => p.id));
const VALID_GLASS_STYLES = new Set<GlassStyleId>([
  "liquid",
  "mist",
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

function clampNumber(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readInitialAppearance(): AppearanceState {
  const rawPalette = readStoredPreference(
    PALETTE_STORAGE_KEY,
  ) as ThemePaletteId | null;
  const rawGlass = readStoredPreference(
    GLASS_STYLE_STORAGE_KEY,
  ) as GlassStyleId | null;
  const rawGlassOpacity = Number(
    readStoredPreference(GLASS_OPACITY_STORAGE_KEY) ?? "16",
  );
  const rawHarkScene = readStoredPreference(
    HARK_SCENE_STORAGE_KEY,
  ) as HarkSkySceneId | null;
  const rawWallpaperId = readStoredPreference(
    WALLPAPER_ID_STORAGE_KEY,
  ) as WallpaperPresetId | null;
  const storedCustomUrl =
    readStoredPreference(WALLPAPER_CUSTOM_URL_STORAGE_KEY) ?? "";
  // 图片数据在 IndexedDB：localStorage 里只有占位标记，先按空处理，异步读回后再补上。
  // 旧版本直接存在 localStorage 里的 Data URL 先照常显示，随后迁移进 IndexedDB 并清掉。
  pendingWallpaperLoad =
    storedCustomUrl === WALLPAPER_IDB_MARKER
      ? "hydrate"
      : storedCustomUrl.startsWith("data:")
        ? "migrate"
        : null;
  const customWallpaperUrl =
    storedCustomUrl === WALLPAPER_IDB_MARKER ? "" : storedCustomUrl;
  const rawBlur = Number(
    readStoredPreference(WALLPAPER_BLUR_STORAGE_KEY) ?? "0",
  );
  const rawDim = Number(
    readStoredPreference(WALLPAPER_DIM_STORAGE_KEY) ?? "18",
  );

  return {
    palette:
      rawPalette && VALID_PALETTES.has(rawPalette) ? rawPalette : "default",
    glassStyle:
      rawGlass && VALID_GLASS_STYLES.has(rawGlass) ? rawGlass : "liquid",
    glassOpacity: clampNumber(
      rawGlassOpacity,
      GLASS_OPACITY_MIN,
      GLASS_OPACITY_MAX,
      16,
    ),
    // 深色档没存过就用浅色档的值，老用户拖过的滑块在深色下照旧生效。
    glassOpacityDark: clampNumber(
      Number(
        readStoredPreference(GLASS_OPACITY_DARK_STORAGE_KEY) ??
          rawGlassOpacity,
      ),
      GLASS_OPACITY_MIN,
      GLASS_OPACITY_MAX,
      clampNumber(rawGlassOpacity, GLASS_OPACITY_MIN, GLASS_OPACITY_MAX, 16),
    ),
    harkScene:
      rawHarkScene && VALID_HARK_SCENES.has(rawHarkScene)
        ? rawHarkScene
        : "auto",
    wallpaperId:
      rawWallpaperId && VALID_WALLPAPER_IDS.has(rawWallpaperId)
        ? rawWallpaperId
        : "none",
    customWallpaperUrl,
    wallpaperBlur: clampNumber(rawBlur, 0, 40, 0),
    wallpaperDim: clampNumber(rawDim, 0, 75, 18),
  };
}

let currentState: AppearanceState | null = null;
const listeners = new Set<() => void>();
let pendingWallpaperLoad: "hydrate" | "migrate" | null = null;
/** IndexedDB 里当前保存的 Data URL（已知时），用来避免重复写入。 */
let persistedWallpaperDataUrl: string | null = null;
let persistencePromise: Promise<void> = Promise.resolve();

/**
 * 刷新后「壁纸读取中」：localStorage 里只有占位标记、选的又是自定义壁纸时为 true。
 * 这段时间不挂天空，只铺主题纯色；IndexedDB 读回成功直接显示壁纸，读取失败、没有记录或超过
 * {@link WALLPAPER_LOAD_TIMEOUT_MS} 才退回天空。否则会先闪一下天空，再换成壁纸。
 */
let wallpaperLoading = false;
/** 每次重新读取外观加 1：旧的读取结果晚到了也不会改动新的状态。 */
let wallpaperLoadGeneration = 0;
export const WALLPAPER_LOAD_TIMEOUT_MS = 1500;

/** 拖动时会连续触发的滑块键：界面立即生效，localStorage 写入合并到停手 ~200ms 后。 */
export const SLIDER_WRITE_DELAY_MS = 200;
const pendingSliderWrites = new Map<string, string>();
let sliderWriteTimer: ReturnType<typeof setTimeout> | null = null;

/** 立即写出还在等待的滑块值（页面隐藏 / 关闭前、测试里调用）。 */
export function flushAppearanceWrites() {
  if (sliderWriteTimer !== null) {
    clearTimeout(sliderWriteTimer);
    sliderWriteTimer = null;
  }
  for (const [key, value] of pendingSliderWrites)
    writeStoredPreference(key, value);
  pendingSliderWrites.clear();
}

function scheduleSliderWrite(key: string, value: string) {
  pendingSliderWrites.set(key, value);
  if (sliderWriteTimer !== null) clearTimeout(sliderWriteTimer);
  sliderWriteTimer = setTimeout(() => {
    sliderWriteTimer = null;
    flushAppearanceWrites();
  }, SLIDER_WRITE_DELAY_MS);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushAppearanceWrites);
}

/** 读取结束：有图就换上壁纸，并在同一次通知里结束「读取中」，中间不会出现天空。 */
function finishWallpaperLoading(generation: number, dataUrl: string | null) {
  if (generation !== wallpaperLoadGeneration) return;
  const state = currentState;
  const apply =
    Boolean(dataUrl) &&
    state?.wallpaperId === "custom" &&
    !state.customWallpaperUrl;
  if (!apply && !wallpaperLoading) return;
  wallpaperLoading = false;
  if (apply && state && dataUrl) {
    persistedWallpaperDataUrl = dataUrl;
    currentState = { ...state, customWallpaperUrl: dataUrl };
  }
  if (currentState) applyAppearanceToDocument(currentState);
  emitChange();
}

async function loadStoredWallpaper(
  mode: "hydrate" | "migrate",
  generation: number,
) {
  const backend = getWallpaperBackend();
  if (mode === "hydrate") {
    const read = backend.get().catch(() => null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), WALLPAPER_LOAD_TIMEOUT_MS);
    });
    const first = await Promise.race([read, timeout]);
    clearTimeout(timer);
    if (first === "timeout") {
      // 超时先退回天空；IndexedDB 之后读回来了照样换上壁纸，用户选的壁纸不丢。
      finishWallpaperLoading(generation, null);
      void read.then((late) => finishWallpaperLoading(generation, late));
      return;
    }
    finishWallpaperLoading(generation, first);
    return;
  }
  const legacy = currentState?.customWallpaperUrl ?? "";
  if (!legacy.startsWith("data:")) return;
  try {
    await backend.put(legacy);
  } catch {
    // 迁移失败就保留旧数据，壁纸不丢；下次加载再试。
    return;
  }
  persistedWallpaperDataUrl = legacy;
  if (currentState?.customWallpaperUrl === legacy) {
    writeStoredPreference(
      WALLPAPER_CUSTOM_URL_STORAGE_KEY,
      WALLPAPER_IDB_MARKER,
    );
  }
}

function ensureState(): AppearanceState {
  if (!currentState) {
    currentState = readInitialAppearance();
    const mode = pendingWallpaperLoad;
    pendingWallpaperLoad = null;
    wallpaperLoadGeneration += 1;
    wallpaperLoading =
      mode === "hydrate" && currentState.wallpaperId === "custom";
    if (mode)
      persistencePromise = loadStoredWallpaper(mode, wallpaperLoadGeneration);
  }
  return currentState;
}

/**
 * 重新从存储读取外观设置（测试和多标签页同步用），返回 IndexedDB 读回 / 迁移完成的 Promise。
 */
export function reloadAppearanceFromStorage(): Promise<void> {
  flushAppearanceWrites();
  currentState = null;
  persistedWallpaperDataUrl = null;
  ensureState();
  return persistencePromise;
}

function persistCustomWallpaperUrl(url: string) {
  if (url.startsWith("data:")) {
    writeStoredPreference(
      WALLPAPER_CUSTOM_URL_STORAGE_KEY,
      WALLPAPER_IDB_MARKER,
    );
    if (persistedWallpaperDataUrl !== url) {
      persistedWallpaperDataUrl = url;
      getWallpaperBackend()
        .put(url)
        .catch(() => {
          if (persistedWallpaperDataUrl === url)
            persistedWallpaperDataUrl = null;
        });
    }
    return;
  }
  writeStoredPreference(WALLPAPER_CUSTOM_URL_STORAGE_KEY, url);
  if (persistedWallpaperDataUrl !== null) {
    persistedWallpaperDataUrl = null;
    getWallpaperBackend()
      .remove()
      .catch(() => {});
  }
}

/**
 * 保存上传的壁纸：先写进 IndexedDB，成功后才应用；写入失败（配额不足等）会抛错，由调用方提示用户。
 */
export async function saveUploadedWallpaper(dataUrl: string): Promise<void> {
  try {
    await getWallpaperBackend().put(dataUrl);
  } catch (error) {
    const detail =
      error instanceof Error && error.message ? `：${error.message}` : "";
    throw new Error(`壁纸保存失败，可能是浏览器存储空间不足${detail}`);
  }
  persistedWallpaperDataUrl = dataUrl;
  setCustomWallpaperUrl(dataUrl);
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
  return useSyncExternalStore(
    subscribeAppearance,
    getAppearanceState,
    getAppearanceState,
  );
}

/** 自定义壁纸是否还在从 IndexedDB 读回（见 {@link WALLPAPER_LOAD_TIMEOUT_MS}）。 */
export function isWallpaperLoading(): boolean {
  ensureState();
  return wallpaperLoading;
}

export function useWallpaperLoading(): boolean {
  return useSyncExternalStore(
    subscribeAppearance,
    isWallpaperLoading,
    isWallpaperLoading,
  );
}

/**
 * 读 --lg-surface / --lg-blur 这几个玻璃变量的元素（和 styles.css「三档玻璃材质」一节的 :where 名单一致）。
 * --lg-alpha 只写到这些元素上：拖滑块时只有它们重算样式，不再是整页（见 styles.css 那一节的注释）。
 */
export const GLASS_SURFACE_SELECTOR =
  ':where(.glass-side-card, .acct-card, .acct-mini-card, .glass-mini-card, .rail-card, .glass-seg, .glass-search, .glass-pill, .glass-newchat, .glass-icon-btn, .glass-mini-new, .glass-composer, [data-slot="bubble-content"], .jr-card, .page-rows, .sg-card, .page-section > form, .page .border)';
export const GLASS_ALPHA_STYLE_ID = "chisabot-glass-alpha";

let glassAlphaApplied: string | null = null;
let glassAlphaFrame: number | null = null;
let glassAlphaPending: { light: number; dark: number } | null = null;

function glassAlphaValue(glassOpacity: number): string {
  return (glassOpacity / 100).toFixed(2);
}

/**
 * 把 --lg-alpha 写进 <head> 里只命中玻璃元素的两条规则：浅色档一条，深色档一条
 * （html.dark 前缀的那条）。浅 / 深各自的雾度分开存，切主题时各自的值各自生效。
 * 已经有这两条规则时直接改它们的声明（CSSOM），浏览器只让匹配的元素重算。
 */
function writeGlassAlpha(glassOpacity: number, glassOpacityDark: number) {
  if (typeof document === "undefined") return;
  const light = glassAlphaValue(glassOpacity);
  const dark = glassAlphaValue(glassOpacityDark);
  const el = document.getElementById(GLASS_ALPHA_STYLE_ID);
  if (`${light}|${dark}` === glassAlphaApplied && el) return;
  glassAlphaApplied = `${light}|${dark}`;
  if (el instanceof HTMLStyleElement) {
    const rules = el.sheet?.cssRules;
    const lightRule = rules?.[0] as CSSStyleRule | undefined;
    const darkRule = rules?.[1] as CSSStyleRule | undefined;
    if (
      lightRule?.style &&
      darkRule?.style &&
      typeof lightRule.style.setProperty === "function"
    ) {
      lightRule.style.setProperty("--lg-alpha", light);
      darkRule.style.setProperty("--lg-alpha", dark);
      return;
    }
    el.textContent = `${GLASS_SURFACE_SELECTOR}{--lg-alpha:${light}}html.dark ${GLASS_SURFACE_SELECTOR}{--lg-alpha:${dark}}`;
    return;
  }
  const style = document.createElement("style");
  style.id = GLASS_ALPHA_STYLE_ID;
  style.textContent = `${GLASS_SURFACE_SELECTOR}{--lg-alpha:${light}}html.dark ${GLASS_SURFACE_SELECTOR}{--lg-alpha:${dark}}`;
  document.head.appendChild(style);
}

function readGlassAlphaRule(index: number): string | null {
  if (typeof document === "undefined") return null;
  const el = document.getElementById(GLASS_ALPHA_STYLE_ID);
  if (!(el instanceof HTMLStyleElement)) return null;
  const rule = el.sheet?.cssRules?.[index] as CSSStyleRule | undefined;
  const fromRule = rule?.style?.getPropertyValue?.("--lg-alpha")?.trim();
  if (fromRule) return fromRule;
  return (
    [...(el.textContent ?? "").matchAll(/--lg-alpha:\s*([\d.]+)/g)][index]?.[1] ??
    null
  );
}

/** 当前写进页面的浅色档 --lg-alpha（测试和调试用）；还没写过时为 null。 */
export function readGlassAlpha(): string | null {
  return readGlassAlphaRule(0);
}

/** 当前写进页面的深色档 --lg-alpha。 */
export function readGlassAlphaDark(): string | null {
  return readGlassAlphaRule(1);
}

/** 立即写出还在等下一帧的 --lg-alpha（测试、以及需要同步结果的调用方）。 */
export function flushGlassAlpha() {
  if (glassAlphaFrame !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(glassAlphaFrame);
  }
  glassAlphaFrame = null;
  if (glassAlphaPending === null) return;
  const next = glassAlphaPending;
  glassAlphaPending = null;
  writeGlassAlpha(next.light, next.dark);
}

/**
 * 拖滑块：一帧最多写一次（指针拖动一帧能来好几个 input 事件），写在下一帧开始前。
 * 状态和滑块数字仍然每一步立即更新，只有写进样式这一步合并。
 */
function scheduleGlassAlpha(glassOpacity: number, glassOpacityDark: number) {
  glassAlphaPending = { light: glassOpacity, dark: glassOpacityDark };
  if (glassAlphaFrame !== null) return;
  if (typeof requestAnimationFrame !== "function") {
    flushGlassAlpha();
    return;
  }
  glassAlphaFrame = requestAnimationFrame(() => {
    glassAlphaFrame = null;
    flushGlassAlpha();
  });
}

function setRootAttribute(
  root: HTMLElement,
  name: string,
  value: string | null,
) {
  // 值没变就不碰：同值 setAttribute 在有的浏览器里也会触发一次失效检查。
  if (root.getAttribute(name) === value) return;
  if (value === null) root.removeAttribute(name);
  else root.setAttribute(name, value);
}

export function applyAppearanceToDocument(
  state: AppearanceState = ensureState(),
) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  setRootAttribute(root, "data-palette", state.palette);
  setRootAttribute(root, "data-glass", state.glassStyle);
  // 旧版本写在 <html> 行内的 --lg-alpha：清掉（它会让整页跟着重算），改由 #chisabot-glass-alpha 规则承担。
  if (root.style.getPropertyValue("--lg-alpha"))
    root.style.removeProperty("--lg-alpha");
  glassAlphaPending = null;
  writeGlassAlpha(state.glassOpacity, state.glassOpacityDark);
  setRootAttribute(
    root,
    "data-wallpaper",
    resolveActiveWallpaperCss(state) !== null ? "on" : null,
  );
}

export function updateAppearance(patch: Partial<AppearanceState>) {
  const prev = ensureState();
  const next: AppearanceState = {
    palette:
      patch.palette && VALID_PALETTES.has(patch.palette)
        ? patch.palette
        : prev.palette,
    glassStyle:
      patch.glassStyle && VALID_GLASS_STYLES.has(patch.glassStyle)
        ? patch.glassStyle
        : prev.glassStyle,
    glassOpacity:
      patch.glassOpacity !== undefined
        ? clampNumber(
            patch.glassOpacity,
            GLASS_OPACITY_MIN,
            GLASS_OPACITY_MAX,
            prev.glassOpacity,
          )
        : prev.glassOpacity,
    glassOpacityDark:
      patch.glassOpacityDark !== undefined
        ? clampNumber(
            patch.glassOpacityDark,
            GLASS_OPACITY_MIN,
            GLASS_OPACITY_MAX,
            prev.glassOpacityDark,
          )
        : prev.glassOpacityDark,
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
  // including the custom wallpaper's data URL. Slider keys are debounced (the preview stays live),
  // and the wallpaper image itself goes to IndexedDB, not localStorage.
  const writes: Array<[string, string, string]> = [
    [PALETTE_STORAGE_KEY, prev.palette, next.palette],
    [GLASS_STYLE_STORAGE_KEY, prev.glassStyle, next.glassStyle],
    [HARK_SCENE_STORAGE_KEY, prev.harkScene, next.harkScene],
    [WALLPAPER_ID_STORAGE_KEY, prev.wallpaperId, next.wallpaperId],
  ];
  for (const [key, before, after] of writes) {
    if (before !== after) writeStoredPreference(key, after);
  }
  const sliderWrites: Array<[string, number, number]> = [
    [GLASS_OPACITY_STORAGE_KEY, prev.glassOpacity, next.glassOpacity],
    [
      GLASS_OPACITY_DARK_STORAGE_KEY,
      prev.glassOpacityDark,
      next.glassOpacityDark,
    ],
    [WALLPAPER_BLUR_STORAGE_KEY, prev.wallpaperBlur, next.wallpaperBlur],
    [WALLPAPER_DIM_STORAGE_KEY, prev.wallpaperDim, next.wallpaperDim],
  ];
  for (const [key, before, after] of sliderWrites) {
    if (before !== after) scheduleSliderWrite(key, String(after));
  }
  if (prev.customWallpaperUrl !== next.customWallpaperUrl) {
    persistCustomWallpaperUrl(next.customWallpaperUrl);
  }
  // 读取中用户自己换了壁纸（或不再用自定义壁纸）：不用再等 IndexedDB。
  if (
    wallpaperLoading &&
    (next.wallpaperId !== "custom" || next.customWallpaperUrl)
  ) {
    wallpaperLoading = false;
  }

  // 只动了玻璃雾度（拖滑块）：不重写根属性，--lg-alpha 合并到下一帧写。
  const onlyGlassOpacity =
    (prev.glassOpacity !== next.glassOpacity ||
      prev.glassOpacityDark !== next.glassOpacityDark) &&
    prev.palette === next.palette &&
    prev.glassStyle === next.glassStyle &&
    prev.wallpaperId === next.wallpaperId &&
    prev.customWallpaperUrl === next.customWallpaperUrl;
  if (onlyGlassOpacity)
    scheduleGlassAlpha(next.glassOpacity, next.glassOpacityDark);
  else applyAppearanceToDocument(next);
  emitChange();
}

/** 别的标签页改了这些键：这边跟着改（只改状态和页面，不写回存储）。 */
const SYNCED_APPEARANCE_KEYS = new Set<string>([
  PALETTE_STORAGE_KEY,
  WALLPAPER_ID_STORAGE_KEY,
  WALLPAPER_CUSTOM_URL_STORAGE_KEY,
  WALLPAPER_BLUR_STORAGE_KEY,
  WALLPAPER_DIM_STORAGE_KEY,
  GLASS_STYLE_STORAGE_KEY,
  GLASS_OPACITY_STORAGE_KEY,
  GLASS_OPACITY_DARK_STORAGE_KEY,
  HARK_SCENE_STORAGE_KEY,
]);

/**
 * 多标签页同步：处理一次 `storage` 事件。key 为 null 表示另一个标签页清空了存储。
 * - 自定义壁纸变了（或清空）：整份重读，图片从 IndexedDB 读回；
 * - 其它键：按存储重读这几项，保留当前的壁纸图片，不触发 IndexedDB；
 * 这边还没写出的同一个滑块键作废，免得 200ms 后把对方的值盖回去。
 */
export function syncAppearanceFromStorage(key: string | null): Promise<void> {
  if (key !== null && !SYNCED_APPEARANCE_KEYS.has(key))
    return Promise.resolve();
  if (key === null || key === WALLPAPER_CUSTOM_URL_STORAGE_KEY) {
    pendingSliderWrites.clear();
    if (sliderWriteTimer !== null) {
      clearTimeout(sliderWriteTimer);
      sliderWriteTimer = null;
    }
    const done = reloadAppearanceFromStorage();
    applyAppearanceToDocument(ensureState());
    emitChange();
    return done;
  }
  pendingSliderWrites.delete(key);
  const prev = ensureState();
  const fresh = readInitialAppearance();
  pendingWallpaperLoad = null;
  const next: AppearanceState = {
    ...fresh,
    customWallpaperUrl: prev.customWallpaperUrl,
  };
  const changed = (Object.keys(next) as Array<keyof AppearanceState>).some(
    (k) => next[k] !== prev[k],
  );
  if (!changed) return Promise.resolve();
  currentState = next;
  applyAppearanceToDocument(next);
  emitChange();
  return Promise.resolve();
}

let storageSyncInstalled = false;

/** 监听别的标签页改外观（window 的 storage 事件只在「别的」标签页写存储时触发）。 */
export function installAppearanceStorageSync() {
  if (storageSyncInstalled || typeof window === "undefined") return;
  storageSyncInstalled = true;
  window.addEventListener("storage", (event) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    void syncAppearanceFromStorage(event.key);
  });
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

export function setGlassOpacityDark(glassOpacityDark: number) {
  updateAppearance({ glassOpacityDark });
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
    glassOpacityDark: 16,
    harkScene: "auto",
    wallpaperId: "none",
    customWallpaperUrl: "",
    wallpaperBlur: 0,
    wallpaperDim: 18,
  });
  // 天空引擎的地点 / 天气快照：下次加载按默认场景重新取，不再沿用之前搜过或定位到的城市。
  for (const key of HARK_ENGINE_STORAGE_KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // 存储不可用（隐私模式等）就跳过。
    }
  }
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
  const meta =
    THEME_PALETTES.find((p) => p.id === state.palette) ?? THEME_PALETTES[0];
  return dark ? meta.harkSceneDark : meta.harkSceneLight;
}

export function resolveActiveWallpaperCss(
  state: AppearanceState,
): string | null {
  if (state.wallpaperId === "none") return null;
  if (state.wallpaperId === "custom") {
    const u = state.customWallpaperUrl.trim();
    if (!u) return null;
    if (/^(https?:\/\/|data:image\/|blob:|\/)/i.test(u)) {
      // CSS 字符串里 \ 和 " 要转义，换行不能出现（否则会截断 url() 注入别的声明）。
      return `url("${u.replace(/[\r\n\f]/g, "").replace(/[\\"]/g, "\\$&")}")`;
    }
    return null;
  }
  const found = WALLPAPER_PRESETS.find((w) => w.id === state.wallpaperId);
  return found?.cssImage ?? null;
}

/**
 * 选了非 default 配色时（不管「智能跟随主题」开没开、手动选了哪个场景），天空一律用 computePaletteSky 的主题渐变，
 * 不启动 Hark WebGL：引擎只有固定的蓝天 / 夜空场景、没有色相参数，会把主题色盖掉；不跑 WebGL 也更省。
 * 设置页场景选择处会提示「彩色主题下使用主题天空」。
 */
export function usesPaletteGradientSky(state: Pick<AppearanceState, "palette">): boolean {
  return state.palette !== "default";
}

/** 允许上传的壁纸图片类型（与上传控件的 accept 一致）。 */
export const ALLOWED_WALLPAPER_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
];
/** 原始图片文件大小上限：超过就不读进内存。 */
export const MAX_WALLPAPER_FILE_BYTES = 20 * 1024 * 1024;
/** 压缩后 Data URL 的长度上限（约 6 MB）。 */
export const MAX_WALLPAPER_DATA_URL_CHARS = 6_000_000;

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 校验上传的壁纸文件；不合格返回给用户看的提示，合格返回 null。 */
export function validateWallpaperFile(file: {
  type: string;
  size: number;
}): string | null {
  if (!ALLOWED_WALLPAPER_TYPES.includes(file.type.toLowerCase())) {
    return "请选择图片格式文件（PNG / JPG / WebP / GIF / AVIF）";
  }
  if (file.size > MAX_WALLPAPER_FILE_BYTES) {
    return `图片太大（${formatMb(file.size)}），请选择不超过 ${formatMb(MAX_WALLPAPER_FILE_BYTES)} 的图片`;
  }
  return null;
}

/** 压缩结果超过上限时抛出明确的错误。 */
export function assertWallpaperDataUrlSize(dataUrl: string): string {
  if (dataUrl.length > MAX_WALLPAPER_DATA_URL_CHARS) {
    throw new Error("图片压缩后仍然太大，请换一张分辨率更低或更简单的图片");
  }
  return dataUrl;
}

/**
 * 将本地上传的图片文件压缩为 Data URL，保存在 IndexedDB。
 * 最长边 = 屏幕最长边 × DPR（最多 3840），优先在 Worker 里压缩，见 `wallpaper-compress.ts`。
 */
export async function compressUploadedWallpaper(file: File): Promise<string> {
  const invalid = validateWallpaperFile(file);
  if (invalid) throw new Error(invalid);
  return assertWallpaperDataUrlSize(await compressWallpaperImage(file));
}

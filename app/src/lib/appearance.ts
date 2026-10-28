import {
  readStoredPreference,
  writeStoredPreference,
} from "@/lib/preference-storage";
import type { SkyVars } from "@/lib/sky";

export const PALETTE_STORAGE_KEY = "chisabot-palette";
export const WALLPAPER_ID_STORAGE_KEY = "chisabot-wallpaper-id";
export const WALLPAPER_CUSTOM_STORAGE_KEY = "chisabot-wallpaper-custom";
export const WALLPAPER_BLUR_STORAGE_KEY = "chisabot-wallpaper-blur";
export const WALLPAPER_DIM_STORAGE_KEY = "chisabot-wallpaper-dim";
export const GLASS_STYLE_STORAGE_KEY = "chisabot-glass-style";

export type ThemePaletteId =
  | "default"
  | "aurora"
  | "emerald"
  | "sakura"
  | "ocean"
  | "sunset"
  | "crimson"
  | "obsidian";

export type GlassStyleId = "liquid" | "crystal" | "frosted";

export type WallpaperPresetId =
  | "none"
  | "fluid"
  | "aurora"
  | "ocean"
  | "sakura"
  | "sunset"
  | "cyber"
  | "custom";

export type ThemePaletteDef = {
  id: ThemePaletteId;
  name: string;
  desc: string;
  swatch: string;
  accentLight: string;
  accentDark: string;
  lightSky?: {
    sky1: string;
    sky2: string;
    sky3: string;
    sky4: string;
    cloud: string;
    glow: string;
    stars: string;
    lift: string;
    muted: string;
  };
  darkSky?: {
    sky1: string;
    sky2: string;
    sky3: string;
    sky4: string;
    cloud: string;
    glow: string;
    stars: string;
    lift: string;
    muted: string;
  };
};

export const THEME_PALETTES: readonly ThemePaletteDef[] = [
  {
    id: "default",
    name: "晴空蓝",
    desc: "经典晴空与深邃夜空",
    swatch: "linear-gradient(135deg, #2f74f0 0%, #84aee0 52%, #12203a 100%)",
    accentLight: "#2f74f0",
    accentDark: "#5b95ff",
  },
  {
    id: "aurora",
    name: "极光紫",
    desc: "梦幻星云与北极光紫",
    swatch: "linear-gradient(135deg, #7c3aed 0%, #c084fc 52%, #1e1b4b 100%)",
    accentLight: "#7c3aed",
    accentDark: "#a78bfa",
    lightSky: {
      sky1: "#7466dc",
      sky2: "#9f87f5",
      sky3: "#d4c4fb",
      sky4: "#f1ebff",
      cloud: "rgba(245, 236, 255, 0.72)",
      glow: "rgba(216, 180, 254, 0.58)",
      stars: "0.15",
      lift: "0.02",
      muted: "#5b5475",
    },
    darkSky: {
      sky1: "#0c0920",
      sky2: "#18123b",
      sky3: "#281b59",
      sky4: "#37226e",
      cloud: "rgba(167, 139, 250, 0.22)",
      glow: "rgba(217, 70, 239, 0.24)",
      stars: "0.85",
      lift: "0",
      muted: "#a39bbf",
    },
  },
  {
    id: "emerald",
    name: "翡翠森",
    desc: "晨雾松林与碧玉青绿",
    swatch: "linear-gradient(135deg, #059669 0%, #6ee7b7 52%, #064e3b 100%)",
    accentLight: "#059669",
    accentDark: "#34d399",
    lightSky: {
      sky1: "#3d9982",
      sky2: "#73c2ad",
      sky3: "#b6e3d5",
      sky4: "#e6f7f1",
      cloud: "rgba(235, 255, 248, 0.72)",
      glow: "rgba(167, 243, 208, 0.55)",
      stars: "0",
      lift: "0",
      muted: "#4d6860",
    },
    darkSky: {
      sky1: "#061815",
      sky2: "#0a2823",
      sky3: "#103b33",
      sky4: "#164d43",
      cloud: "rgba(52, 211, 153, 0.18)",
      glow: "rgba(110, 231, 183, 0.22)",
      stars: "0.65",
      lift: "0",
      muted: "#8fb3a8",
    },
  },
  {
    id: "sakura",
    name: "樱花粉",
    desc: "春日绯樱与暮色玫瑰",
    swatch: "linear-gradient(135deg, #db2777 0%, #f9a8d4 52%, #4a153b 100%)",
    accentLight: "#db2777",
    accentDark: "#f472b6",
    lightSky: {
      sky1: "#cf7da5",
      sky2: "#eba4c4",
      sky3: "#f7cfe1",
      sky4: "#fdf0f6",
      cloud: "rgba(255, 244, 250, 0.74)",
      glow: "rgba(251, 207, 232, 0.62)",
      stars: "0",
      lift: "0",
      muted: "#6e5262",
    },
    darkSky: {
      sky1: "#1c0b18",
      sky2: "#301328",
      sky3: "#451c39",
      sky4: "#572448",
      cloud: "rgba(244, 114, 182, 0.18)",
      glow: "rgba(251, 113, 133, 0.22)",
      stars: "0.7",
      lift: "0",
      muted: "#b896ab",
    },
  },
  {
    id: "ocean",
    name: "深海蓝",
    desc: "琉璃浅滩与深海幽蓝",
    swatch: "linear-gradient(135deg, #0284c7 0%, #38bdf8 52%, #082f49 100%)",
    accentLight: "#0284c7",
    accentDark: "#38bdf8",
    lightSky: {
      sky1: "#3492b5",
      sky2: "#6ec0dc",
      sky3: "#b6e3f2",
      sky4: "#e5f6fc",
      cloud: "rgba(235, 252, 255, 0.74)",
      glow: "rgba(165, 243, 252, 0.58)",
      stars: "0",
      lift: "0",
      muted: "#4d6470",
    },
    darkSky: {
      sky1: "#041421",
      sky2: "#082338",
      sky3: "#0d3552",
      sky4: "#124669",
      cloud: "rgba(34, 211, 238, 0.2)",
      glow: "rgba(56, 189, 248, 0.24)",
      stars: "0.75",
      lift: "0",
      muted: "#8eaec2",
    },
  },
  {
    id: "sunset",
    name: "暮光金",
    desc: "落日熔金与琥珀暖橙",
    swatch: "linear-gradient(135deg, #d97706 0%, #fb923c 52%, #431407 100%)",
    accentLight: "#d97706",
    accentDark: "#fbbf24",
    lightSky: {
      sky1: "#c7785e",
      sky2: "#e4a278",
      sky3: "#f5cba3",
      sky4: "#fceedd",
      cloud: "rgba(255, 246, 235, 0.7)",
      glow: "rgba(253, 186, 116, 0.65)",
      stars: "0",
      lift: "0.02",
      muted: "#6b584d",
    },
    darkSky: {
      sky1: "#1c0f0a",
      sky2: "#301912",
      sky3: "#452319",
      sky4: "#572e20",
      cloud: "rgba(251, 146, 60, 0.18)",
      glow: "rgba(245, 158, 11, 0.24)",
      stars: "0.65",
      lift: "0",
      muted: "#b89f91",
    },
  },
  {
    id: "crimson",
    name: "绯红星",
    desc: "丝绒红宝石与暗夜星云",
    swatch: "linear-gradient(135deg, #e11d48 0%, #fb7185 52%, #3b0718 100%)",
    accentLight: "#e11d48",
    accentDark: "#fb7185",
    lightSky: {
      sky1: "#b85c77",
      sky2: "#da8ba2",
      sky3: "#f0bfd0",
      sky4: "#faeaf0",
      cloud: "rgba(255, 240, 245, 0.7)",
      glow: "rgba(253, 164, 175, 0.58)",
      stars: "0",
      lift: "0.02",
      muted: "#6b5059",
    },
    darkSky: {
      sky1: "#1a070f",
      sky2: "#2c0c1a",
      sky3: "#401226",
      sky4: "#521831",
      cloud: "rgba(244, 63, 94, 0.18)",
      glow: "rgba(251, 113, 133, 0.22)",
      stars: "0.75",
      lift: "0",
      muted: "#b8949f",
    },
  },
  {
    id: "obsidian",
    name: "曜石黑",
    desc: "极简银灰与黑曜石质感",
    swatch: "linear-gradient(135deg, #475569 0%, #94a3b8 52%, #090d16 100%)",
    accentLight: "#334155",
    accentDark: "#94a3b8",
    lightSky: {
      sky1: "#8a96a8",
      sky2: "#b0bac9",
      sky3: "#d5dce6",
      sky4: "#eef1f6",
      cloud: "rgba(255, 255, 255, 0.68)",
      glow: "rgba(226, 232, 240, 0.5)",
      stars: "0",
      lift: "0",
      muted: "#58606e",
    },
    darkSky: {
      sky1: "#07090e",
      sky2: "#0d111a",
      sky3: "#141926",
      sky4: "#1b2233",
      cloud: "rgba(148, 163, 184, 0.12)",
      glow: "rgba(203, 213, 225, 0.14)",
      stars: "0.5",
      lift: "0",
      muted: "#949eb0",
    },
  },
];

function svgDataUri(svg: string): string {
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg.trim())}")`;
}

export type WallpaperPresetDef = {
  id: Exclude<WallpaperPresetId, "custom">;
  name: string;
  desc: string;
  preview: string;
  backgroundImage: string;
};

export const WALLPAPER_PRESETS: readonly WallpaperPresetDef[] = [
  {
    id: "none",
    name: "默认天空",
    desc: "跟随主题配色与时间变化",
    preview: "linear-gradient(180deg, #6f9bc7 0%, #9dbddc 48%, #e4ecf3 100%)",
    backgroundImage: "",
  },
  {
    id: "fluid",
    name: "流光幻境",
    desc: "多彩液态丝绸光影，凸显玻璃折射",
    preview:
      "radial-gradient(circle at 20% 25%, #38bdf8 0%, transparent 50%), radial-gradient(circle at 80% 30%, #ec4899 0%, transparent 55%), radial-gradient(circle at 50% 80%, #8b5cf6 0%, #0f172a 100%)",
    backgroundImage: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#0b132b"/>
            <stop offset="45%" stop-color="#1e1b4b"/>
            <stop offset="100%" stop-color="#0f172a"/>
          </linearGradient>
          <radialGradient id="g1" cx="22%" cy="28%" r="55%">
            <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.88"/>
            <stop offset="50%" stop-color="#6366f1" stop-opacity="0.45"/>
            <stop offset="100%" stop-color="#0f172a" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="g2" cx="78%" cy="26%" r="52%">
            <stop offset="0%" stop-color="#f472b6" stop-opacity="0.85"/>
            <stop offset="55%" stop-color="#a855f7" stop-opacity="0.42"/>
            <stop offset="100%" stop-color="#1e1b4b" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="g3" cx="54%" cy="82%" r="58%">
            <stop offset="0%" stop-color="#2dd4bf" stop-opacity="0.72"/>
            <stop offset="52%" stop-color="#3b82f6" stop-opacity="0.38"/>
            <stop offset="100%" stop-color="#0b132b" stop-opacity="0"/>
          </radialGradient>
          <linearGradient id="w1" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.48"/>
            <stop offset="50%" stop-color="#f472b6" stop-opacity="0.58"/>
            <stop offset="100%" stop-color="#8b5cf6" stop-opacity="0.45"/>
          </linearGradient>
          <linearGradient id="w2" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#a855f7" stop-opacity="0.38"/>
            <stop offset="50%" stop-color="#2dd4bf" stop-opacity="0.48"/>
            <stop offset="100%" stop-color="#60a5fa" stop-opacity="0.35"/>
          </linearGradient>
        </defs>
        <rect width="1920" height="1080" fill="url(#bg)"/>
        <rect width="1920" height="1080" fill="url(#g1)"/>
        <rect width="1920" height="1080" fill="url(#g2)"/>
        <rect width="1920" height="1080" fill="url(#g3)"/>
        <path d="M-120,680 C340,420 760,920 1240,560 C1560,320 1820,580 2040,440 L2040,1140 L-120,1140 Z" fill="url(#w1)"/>
        <path d="M-120,360 C280,620 820,140 1320,480 C1640,700 1840,340 2040,520 L2040,1140 L-120,1140 Z" fill="url(#w2)"/>
        <circle cx="420" cy="320" r="240" fill="#ffffff" fill-opacity="0.08"/>
        <circle cx="1480" cy="680" r="320" fill="#f472b6" fill-opacity="0.1"/>
      </svg>
    `),
  },
  {
    id: "aurora",
    name: "极光星夜",
    desc: "绚丽极光丝带划过星空远山",
    preview:
      "linear-gradient(160deg, #090d1e 0%, #133b5c 38%, #2dd4bf 72%, #a855f7 100%)",
    backgroundImage: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="sky" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#050814"/>
            <stop offset="50%" stop-color="#0f1f3d"/>
            <stop offset="100%" stop-color="#1b3a5c"/>
          </linearGradient>
          <linearGradient id="aur1" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#2dd4bf" stop-opacity="0"/>
            <stop offset="28%" stop-color="#34d399" stop-opacity="0.68"/>
            <stop offset="65%" stop-color="#38bdf8" stop-opacity="0.62"/>
            <stop offset="100%" stop-color="#a855f7" stop-opacity="0"/>
          </linearGradient>
          <linearGradient id="aur2" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#a855f7" stop-opacity="0"/>
            <stop offset="40%" stop-color="#c084fc" stop-opacity="0.52"/>
            <stop offset="75%" stop-color="#2dd4bf" stop-opacity="0.55"/>
            <stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <rect width="1920" height="1080" fill="url(#sky)"/>
        <path d="M-100,260 C380,40 860,480 1380,180 C1620,40 1820,260 2020,160 L2020,620 C1680,740 1280,380 820,640 C420,860 120,520 -100,660 Z" fill="url(#aur1)"/>
        <path d="M-100,440 C420,180 940,620 1460,280 C1720,120 1880,380 2020,280 L2020,760 C1640,860 1160,520 740,760 C360,960 80,680 -100,820 Z" fill="url(#aur2)"/>
        <path d="M0,1080 L0,830 L280,670 L540,810 L880,610 L1220,790 L1540,640 L1920,780 L1920,1080 Z" fill="#0b1528" fill-opacity="0.88"/>
        <path d="M0,1080 L0,900 L420,750 L760,890 L1140,720 L1520,880 L1920,760 L1920,1080 Z" fill="#060b16" fill-opacity="0.95"/>
      </svg>
    `),
  },
  {
    id: "ocean",
    name: "深海琉璃",
    desc: "蔚蓝水波光斑与晶莹珊瑚海",
    preview:
      "linear-gradient(145deg, #082f49 0%, #0284c7 48%, #22d3ee 82%, #a5f3fc 100%)",
    backgroundImage: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="sea" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#041c2c"/>
            <stop offset="48%" stop-color="#0369a1"/>
            <stop offset="100%" stop-color="#0e7490"/>
          </linearGradient>
          <radialGradient id="sun" cx="65%" cy="18%" r="60%">
            <stop offset="0%" stop-color="#a5f3fc" stop-opacity="0.85"/>
            <stop offset="42%" stop-color="#38bdf8" stop-opacity="0.48"/>
            <stop offset="100%" stop-color="#041c2c" stop-opacity="0"/>
          </radialGradient>
          <linearGradient id="wave" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#22d3ee" stop-opacity="0.42"/>
            <stop offset="50%" stop-color="#38bdf8" stop-opacity="0.22"/>
            <stop offset="100%" stop-color="#67e8f9" stop-opacity="0.45"/>
          </linearGradient>
        </defs>
        <rect width="1920" height="1080" fill="url(#sea)"/>
        <rect width="1920" height="1080" fill="url(#sun)"/>
        <path d="M-100,480 C320,340 680,640 1120,460 C1480,310 1720,560 2020,420 L2020,1080 L-100,1080 Z" fill="url(#wave)"/>
        <path d="M-100,680 C380,520 840,820 1320,640 C1620,520 1800,720 2020,620 L2020,1080 L-100,1080 Z" fill="url(#wave)"/>
        <circle cx="1240" cy="220" r="280" fill="#cffafe" fill-opacity="0.18"/>
        <circle cx="520" cy="640" r="340" fill="#22d3ee" fill-opacity="0.14"/>
      </svg>
    `),
  },
  {
    id: "sakura",
    name: "绯樱春晓",
    desc: "柔粉樱花云海与暖金晨曦",
    preview:
      "linear-gradient(145deg, #831843 0%, #db2777 38%, #f472b6 70%, #fde68a 100%)",
    backgroundImage: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="sk" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#4a153b"/>
            <stop offset="46%" stop-color="#9d174d"/>
            <stop offset="82%" stop-color="#f472b6"/>
            <stop offset="100%" stop-color="#fde2e4"/>
          </linearGradient>
          <radialGradient id="glow" cx="76%" cy="28%" r="55%">
            <stop offset="0%" stop-color="#fef08a" stop-opacity="0.78"/>
            <stop offset="45%" stop-color="#f9a8d4" stop-opacity="0.52"/>
            <stop offset="100%" stop-color="#831843" stop-opacity="0"/>
          </radialGradient>
          <linearGradient id="cloud" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#fbcfe8" stop-opacity="0.45"/>
            <stop offset="50%" stop-color="#f472b6" stop-opacity="0.32"/>
            <stop offset="100%" stop-color="#fef3c7" stop-opacity="0.5"/>
          </linearGradient>
        </defs>
        <rect width="1920" height="1080" fill="url(#sk)"/>
        <rect width="1920" height="1080" fill="url(#glow)"/>
        <path d="M-100,560 C340,380 780,720 1240,500 C1580,340 1780,580 2020,460 L2020,1080 L-100,1080 Z" fill="url(#cloud)"/>
        <path d="M-100,740 C420,580 880,880 1380,680 C1680,560 1840,760 2020,660 L2020,1080 L-100,1080 Z" fill="url(#cloud)"/>
        <circle cx="380" cy="340" r="220" fill="#fbcfe8" fill-opacity="0.18"/>
        <circle cx="1460" cy="300" r="260" fill="#fef08a" fill-opacity="0.18"/>
      </svg>
    `),
  },
  {
    id: "sunset",
    name: "落日旷野",
    desc: "暮色紫金交织的远山层峦",
    preview:
      "linear-gradient(160deg, #31102f 0%, #9a3412 45%, #f59e0b 78%, #fef08a 100%)",
    backgroundImage: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="dusk" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#1e1035"/>
            <stop offset="38%" stop-color="#6b2146"/>
            <stop offset="72%" stop-color="#ea580c"/>
            <stop offset="100%" stop-color="#fbbf24"/>
          </linearGradient>
          <radialGradient id="sun" cx="50%" cy="62%" r="42%">
            <stop offset="0%" stop-color="#fef08a" stop-opacity="0.92"/>
            <stop offset="45%" stop-color="#fb923c" stop-opacity="0.55"/>
            <stop offset="100%" stop-color="#6b2146" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <rect width="1920" height="1080" fill="url(#dusk)"/>
        <rect width="1920" height="1080" fill="url(#sun)"/>
        <circle cx="960" cy="640" r="190" fill="#fef9c3" fill-opacity="0.45"/>
        <path d="M-80,740 C260,580 580,820 960,670 C1340,520 1640,760 2000,630 L2000,1080 L-80,1080 Z" fill="#431426" fill-opacity="0.65"/>
        <path d="M-80,860 C340,720 740,940 1180,790 C1520,670 1760,860 2000,770 L2000,1080 L-80,1080 Z" fill="#230b18" fill-opacity="0.88"/>
      </svg>
    `),
  },
  {
    id: "cyber",
    name: "霓虹幻夜",
    desc: "赛博紫青流光与深空星云",
    preview:
      "linear-gradient(135deg, #090d16 0%, #3b0764 42%, #d946ef 74%, #06b6d4 100%)",
    backgroundImage: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="cy" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#050711"/>
            <stop offset="50%" stop-color="#1e0b36"/>
            <stop offset="100%" stop-color="#081c30"/>
          </linearGradient>
          <radialGradient id="n1" cx="25%" cy="35%" r="50%">
            <stop offset="0%" stop-color="#d946ef" stop-opacity="0.78"/>
            <stop offset="50%" stop-color="#7c3aed" stop-opacity="0.38"/>
            <stop offset="100%" stop-color="#050711" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="n2" cx="76%" cy="62%" r="52%">
            <stop offset="0%" stop-color="#06b6d4" stop-opacity="0.82"/>
            <stop offset="50%" stop-color="#3b82f6" stop-opacity="0.38"/>
            <stop offset="100%" stop-color="#081c30" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <rect width="1920" height="1080" fill="url(#cy)"/>
        <rect width="1920" height="1080" fill="url(#n1)"/>
        <rect width="1920" height="1080" fill="url(#n2)"/>
        <path d="M-100,620 C420,280 960,880 1480,420 C1720,220 1880,520 2020,380 L2020,1080 L-100,1080 Z" fill="#d946ef" fill-opacity="0.18"/>
        <path d="M-100,760 C380,480 920,960 1440,580 C1680,400 1860,680 2020,560 L2020,1080 L-100,1080 Z" fill="#06b6d4" fill-opacity="0.22"/>
      </svg>
    `),
  },
];

export type AppearanceState = {
  palette: ThemePaletteId;
  glassStyle: GlassStyleId;
  wallpaperId: WallpaperPresetId;
  customWallpaper: string;
  wallpaperBlur: number;
  wallpaperDim: number;
};

function parsePalette(raw: string | null): ThemePaletteId {
  if (raw && THEME_PALETTES.some((p) => p.id === raw)) {
    return raw as ThemePaletteId;
  }
  return "default";
}

function parseGlassStyle(raw: string | null): GlassStyleId {
  if (raw === "liquid" || raw === "crystal" || raw === "frosted") return raw;
  return "liquid";
}

function parseWallpaperId(raw: string | null): WallpaperPresetId {
  if (
    raw === "none" ||
    raw === "fluid" ||
    raw === "aurora" ||
    raw === "ocean" ||
    raw === "sakura" ||
    raw === "sunset" ||
    raw === "cyber" ||
    raw === "custom"
  ) {
    return raw;
  }
  return "none";
}

function clampNum(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

let appearanceState: AppearanceState = {
  palette: parsePalette(readStoredPreference(PALETTE_STORAGE_KEY)),
  glassStyle: parseGlassStyle(readStoredPreference(GLASS_STYLE_STORAGE_KEY)),
  wallpaperId: parseWallpaperId(readStoredPreference(WALLPAPER_ID_STORAGE_KEY)),
  customWallpaper: readStoredPreference(WALLPAPER_CUSTOM_STORAGE_KEY) ?? "",
  wallpaperBlur: clampNum(readStoredPreference(WALLPAPER_BLUR_STORAGE_KEY), 0, 0, 32),
  wallpaperDim: clampNum(readStoredPreference(WALLPAPER_DIM_STORAGE_KEY), 12, 0, 75),
};

const listeners = new Set<() => void>();
function emit() {
  for (const listener of listeners) listener();
}

export function subscribeAppearance(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAppearanceState(): AppearanceState {
  return appearanceState;
}

export function setThemePalette(palette: ThemePaletteId) {
  writeStoredPreference(PALETTE_STORAGE_KEY, palette);
  appearanceState = { ...appearanceState, palette };
  emit();
}

export function setGlassStyle(glassStyle: GlassStyleId) {
  writeStoredPreference(GLASS_STYLE_STORAGE_KEY, glassStyle);
  appearanceState = { ...appearanceState, glassStyle };
  emit();
}

export function setWallpaperPreset(wallpaperId: WallpaperPresetId) {
  writeStoredPreference(WALLPAPER_ID_STORAGE_KEY, wallpaperId);
  appearanceState = { ...appearanceState, wallpaperId };
  emit();
}

export function setCustomWallpaperUrl(url: string) {
  const trimmed = url.trim();
  writeStoredPreference(WALLPAPER_CUSTOM_STORAGE_KEY, trimmed);
  const nextId: WallpaperPresetId = trimmed ? "custom" : "none";
  writeStoredPreference(WALLPAPER_ID_STORAGE_KEY, nextId);
  appearanceState = {
    ...appearanceState,
    customWallpaper: trimmed,
    wallpaperId: nextId,
  };
  emit();
}

export function setWallpaperBlur(blur: number) {
  const clamped = Math.max(0, Math.min(32, Math.round(blur)));
  writeStoredPreference(WALLPAPER_BLUR_STORAGE_KEY, String(clamped));
  appearanceState = { ...appearanceState, wallpaperBlur: clamped };
  emit();
}

export function setWallpaperDim(dim: number) {
  const clamped = Math.max(0, Math.min(75, Math.round(dim)));
  writeStoredPreference(WALLPAPER_DIM_STORAGE_KEY, String(clamped));
  appearanceState = { ...appearanceState, wallpaperDim: clamped };
  emit();
}

export function resetAppearanceDefaults() {
  setThemePalette("default");
  setGlassStyle("liquid");
  setWallpaperPreset("none");
  setWallpaperBlur(0);
  setWallpaperDim(12);
}

/** 根据当前主题配色计算自定义天空变量（非 default 配色时使用）。 */
export function computePaletteSky(paletteId: ThemePaletteId, dark: boolean): SkyVars | null {
  const def = THEME_PALETTES.find((p) => p.id === paletteId);
  if (!def || def.id === "default") return null;
  const sky = dark ? def.darkSky : def.lightSky;
  if (!sky) return null;
  return {
    body: {
      "--sky-1": sky.sky1,
      "--sky-2": sky.sky2,
      "--sky-3": sky.sky3,
      "--sky-4": sky.sky4,
      "--sky-cloud": sky.cloud,
      "--sky-glow": sky.glow,
      "--sky-glow-x": "64%",
      "--sky-glow-y": "24%",
      "--sky-stars": sky.stars,
    },
    root: {
      "--sky-lift": sky.lift,
      "--sky-muted": sky.muted,
    },
  };
}

/** 解析当前激活壁纸的 CSS background-image 值。 */
export function resolveActiveWallpaperCss(state: AppearanceState): string | null {
  if (state.wallpaperId === "none") return null;
  if (state.wallpaperId === "custom") {
    const raw = state.customWallpaper.trim();
    if (!raw) return null;
    const safe = raw.replace(/["\\]/g, "\\$&");
    return `url("${safe}")`;
  }
  const preset = WALLPAPER_PRESETS.find((w) => w.id === state.wallpaperId);
  return preset?.backgroundImage || null;
}

/** 将用户上传的本地图片压缩为适合本地持久化的高清 Data URL（最大 1920×1080，WebP/JPEG）。 */
export async function compressUploadedWallpaper(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片文件失败"));
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const img = new Image();
      img.onerror = () => reject(new Error("无法解析该图片格式"));
      img.onload = () => {
        try {
          const maxW = 1920;
          const maxH = 1080;
          let { width, height } = img;
          if (width > maxW || height > maxH) {
            const ratio = Math.min(maxW / width, maxH / height);
            width = Math.max(1, Math.round(width * ratio));
            height = Math.max(1, Math.round(height * ratio));
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            resolve(dataUrl);
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);
          let compressed = canvas.toDataURL("image/webp", 0.84);
          if (!compressed.startsWith("data:image/webp")) {
            compressed = canvas.toDataURL("image/jpeg", 0.84);
          }
          resolve(compressed);
        } catch {
          resolve(dataUrl);
        }
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

import { useSyncExternalStore } from "react";
import {
  APPEARANCE_STORAGE_KEY,
  applyThemeColor,
  CUSTOM_ACCENT_CSS_PROPS,
  DEFAULT_THEME_ID,
  deriveCustomAccentVars,
  isThemeId,
  mapLegacyThemeId,
  normalizeHexColor,
  type ThemeId,
  themeMetaColor,
} from "@/lib/palette";
import {
  readStoredPreference,
  writeStoredPreference,
} from "@/lib/preference-storage";
import {
  type AppearanceMode,
  parseAppearanceMode,
  prefersSystemDark,
  resolveDarkTheme,
  THEME_STORAGE_KEY,
} from "@/lib/theme";
import { compressWallpaperImage } from "@/lib/wallpaper-compress";
import type { PixelCropRect } from "@/lib/wallpaper-crop";
import {
  getWallpaperBackend,
  type WallpaperSourceRecord,
} from "@/lib/wallpaper-store";

export {
  APPEARANCE_STORAGE_KEY,
  appearanceBootScript,
  applyThemeColor,
  CUSTOM_ACCENT_CSS_PROPS,
  type CustomAccentVars,
  DEFAULT_THEME_ID,
  deriveCustomAccentVars,
  getThemeMeta,
  isThemeId,
  LEGACY_THEME_MAP,
  mapLegacyThemeId,
  normalizeHexColor,
  THEMES,
  type ThemeId,
  type ThemeMeta,
  themeMetaColor,
  VALID_THEME_IDS,
} from "@/lib/palette";
export type { AppearanceMode } from "@/lib/theme";
export type { WallpaperSourceRecord } from "@/lib/wallpaper-store";

// ---------------------------------------------------------------------------
// V2 冻结硬契约类型与常量
// ---------------------------------------------------------------------------

export type MaterialId = "glass" | "clear" | "solid";

export type SkySceneId = "auto" | "dawn" | "day" | "dusk" | "night";

export type WallpaperCategoryId = "all" | "impression" | "eastern" | "modern";

export const WALLPAPER_CATEGORIES: readonly {
  id: WallpaperCategoryId;
  label: string;
}[] = [
  { id: "all", label: "全部" },
  { id: "impression", label: "印象油画" },
  { id: "eastern", label: "东方意境" },
  { id: "modern", label: "现代光影" },
] as const;

export type ArtisticWallpaperPresetId =
  | "waterlily-pond"
  | "starry-rhone"
  | "tuscan-golden"
  | "lavender-provence"
  | "venice-glow"
  | "qinglv-shanhe"
  | "fuji-sakura"
  | "ink-bamboo-mist"
  | "red-maple"
  | "snow-river"
  | "arch-sunbeam"
  | "mineral-agate"
  | "nordic-fjord"
  | "nebula-drift"
  | "dune-gold";

export type WallpaperPresetId = "none" | ArtisticWallpaperPresetId | "custom";

export type CanvasConfig =
  | { kind: "pure" }
  | {
      kind: "sky";
      scene: SkySceneId;
      weather: { enabled: boolean; city: string | null };
    }
  | {
      kind: "wallpaper";
      source: ArtisticWallpaperPresetId | "custom";
      blur: number;
      scrim: number;
    };

export type AppearanceConfigV2 = {
  v: 2;
  mode: AppearanceMode;
  theme: ThemeId;
  customAccent: string | null;
  material: MaterialId;
  canvas: CanvasConfig;
  staticBackground: boolean;
};

export const WALLPAPER_BLUR_MIN = 0;
export const WALLPAPER_BLUR_MAX = 24;
export const DEFAULT_WALLPAPER_BLUR = 0;

export const WALLPAPER_SCRIM_MIN = 0;
export const WALLPAPER_SCRIM_MAX = 100;
export const DEFAULT_WALLPAPER_SCRIM = 35;

export const DEFAULT_APPEARANCE_CONFIG: AppearanceConfigV2 = {
  v: 2,
  mode: "system",
  theme: DEFAULT_THEME_ID,
  customAccent: null,
  material: "glass",
  canvas: {
    kind: "sky",
    scene: "auto",
    weather: { enabled: false, city: null },
  },
  staticBackground: false,
};

/** 界面材质 3 档元数据（纯 CSS 驱动，彻底移除重型液态玻璃）。 */
export interface MaterialMeta {
  id: MaterialId;
  name: string;
  description: string;
}

export const MATERIALS: readonly MaterialMeta[] = [
  { id: "glass", name: "磨砂", description: "细腻均衡的毛玻璃层次（默认）" },
  { id: "clear", name: "通透", description: "更轻薄透亮的背景通透感" },
  { id: "solid", name: "实色", description: "零模糊原生实面，更省电流畅" },
] as const;

/**
 * 动态天空 4 个固定时刻与 Hark `SCENES[0..11]` 的精确一一对应关系：
 *  - dawn  → SCENES[11] (Honolulu · Dawn)
 *  - day   → SCENES[0]  (Palo Alto · Sunny)
 *  - dusk  → SCENES[6]  (Phoenix · Golden)
 *  - night → SCENES[4]  (Berlin · Night)
 * 彻底消除旧版 seed.scene 下标错位与静默昼夜调包。
 */
export const SKY_SCENE_TO_HARK_INDEX: Readonly<
  Record<Exclude<SkySceneId, "auto">, number>
> = {
  dawn: 11,
  day: 0,
  dusk: 6,
  night: 4,
};

export interface SkySceneMeta {
  id: SkySceneId;
  harkIndex: number | null;
  name: string;
  subtitle: string;
  previewGradient: string;
}

export const SKY_SCENES: readonly SkySceneMeta[] = [
  {
    id: "auto",
    harkIndex: null,
    name: "随时间流动",
    subtitle: "按本机时间沿柔和太阳弧线演进",
    previewGradient:
      "linear-gradient(135deg, #4a8fdf 0%, #7db8ef 44%, #10182b 56%, #1c2a4a 100%)",
  },
  {
    id: "dawn",
    harkIndex: 11,
    name: "晨霞",
    subtitle: "日出粉紫霞光与海岸晨雾",
    previewGradient:
      "linear-gradient(180deg, #3b3f8f 0%, #7c5cad 35%, #d67fa8 68%, #f5b3a1 100%)",
  },
  {
    id: "day",
    harkIndex: 0,
    name: "晴空",
    subtitle: "午后澄澈蓝天与立体积云",
    previewGradient:
      "linear-gradient(180deg, #1466c2 0%, #3b8de0 48%, #7db8ef 82%, #b8dcf8 100%)",
  },
  {
    id: "dusk",
    harkIndex: 6,
    name: "暖暮",
    subtitle: "黄金时刻暖阳散射与暮云",
    previewGradient:
      "linear-gradient(180deg, #31497c 0%, #6d5d93 38%, #c97e5e 72%, #f2ac63 100%)",
  },
  {
    id: "night",
    harkIndex: 4,
    name: "静夜",
    subtitle: "深邃星夜与微光云层",
    previewGradient:
      "linear-gradient(180deg, #090d18 0%, #10182b 42%, #18233c 76%, #22304e 100%)",
  },
] as const;

export type WallpaperPresetMeta = {
  id: Exclude<WallpaperPresetId, "custom">;
  category: Exclude<WallpaperCategoryId, "all"> | null;
  tag: string | null;
  name: string;
  subtitle: string;
  previewBackground: string;
  thumbUrl: string | null;
  imageUrl: string | null;
  cssImage: string | null;
};

export type ArtisticWallpaperPresetMeta = WallpaperPresetMeta & {
  id: ArtisticWallpaperPresetId;
  category: Exclude<WallpaperCategoryId, "all">;
  tag: string;
  thumbUrl: string;
  imageUrl: string;
  cssImage: string;
};

function artPreset(meta: {
  id: ArtisticWallpaperPresetId;
  category: Exclude<WallpaperCategoryId, "all">;
  tag: string;
  name: string;
  subtitle: string;
  previewBackground: string;
}): ArtisticWallpaperPresetMeta {
  const imageUrl = `/wallpapers/${meta.id}.webp`;
  return {
    ...meta,
    thumbUrl: `/wallpapers/${meta.id}-thumb.webp`,
    imageUrl,
    cssImage: `url("${imageUrl}")`,
  };
}

export const ARTISTIC_WALLPAPER_PRESETS: readonly ArtisticWallpaperPresetMeta[] =
  [
    // ── 印象油画 ──
    artPreset({
      id: "waterlily-pond",
      category: "impression",
      tag: "印象派油画",
      name: "睡莲晨光 · 莫奈印象",
      subtitle: "吉维尼晨雾池塘、柔紫倒影与垂柳厚涂笔触",
      previewBackground:
        "linear-gradient(135deg, #6e8f82 0%, #94a69d 50%, #405e52 100%)",
    }),
    artPreset({
      id: "starry-rhone",
      category: "impression",
      tag: "后印象油画",
      name: "星夜罗纳 · 旋流夜曲",
      subtitle: "群青旋流夜空与洒满河湾的暖金星辉波光",
      previewBackground:
        "linear-gradient(135deg, #1d3564 0%, #324f82 52%, #171e30 100%)",
    }),
    artPreset({
      id: "tuscan-golden",
      category: "impression",
      tag: "田园油画",
      name: "暮色麦浪 · 托斯卡纳",
      subtitle: "鎏金起伏麦田、丝柏小径与杏粉晚霞油彩",
      previewBackground:
        "linear-gradient(135deg, #dba473 0%, #c98856 52%, #7c4922 100%)",
    }),
    artPreset({
      id: "lavender-provence",
      category: "impression",
      tag: "田园油画",
      name: "薰衣草浪 · 普罗旺斯",
      subtitle: "暮紫花海垄浪、暖金夕照与远山薄雾笔触",
      previewBackground:
        "linear-gradient(135deg, #a88ac0 0%, #7a5ea0 52%, #584080 100%)",
    }),
    artPreset({
      id: "venice-glow",
      category: "impression",
      tag: "都市油画",
      name: "水城暮光 · 威尼斯",
      subtitle: "暖金夕照洒落碧水回廊与粼粼倒影油彩",
      previewBackground:
        "linear-gradient(135deg, #c87858 0%, #4a7080 52%, #1e4858 100%)",
    }),
    // ── 东方意境 ──
    artPreset({
      id: "qinglv-shanhe",
      category: "eastern",
      tag: "宋韵青绿",
      name: "千里青绿 · 宋韵烟岚",
      subtitle: "古绢石青石绿重峦叠嶂与云海平湖长卷",
      previewBackground:
        "linear-gradient(135deg, #c5ad74 0%, #6f9478 52%, #3a686e 100%)",
    }),
    artPreset({
      id: "fuji-sakura",
      category: "eastern",
      tag: "浮世绘木版",
      name: "浮世沧浪 · 樱雪远富士",
      subtitle: "普鲁士蓝千重海浪、春樱飞瓣与暮霞远山",
      previewBackground:
        "linear-gradient(135deg, #2b4c6b 0%, #d9b8a9 52%, #1d3b58 100%)",
    }),
    artPreset({
      id: "ink-bamboo-mist",
      category: "eastern",
      tag: "禅意水墨",
      name: "烟雨空山 · 水墨留白",
      subtitle: "宣纸淡墨远岫、青瓷烟霭与孤舟清竹留白",
      previewBackground:
        "linear-gradient(135deg, #efece0 0%, #cbd3cb 52%, #59605d 100%)",
    }),
    artPreset({
      id: "red-maple",
      category: "eastern",
      tag: "丹枫设色",
      name: "霜叶栖霞 · 丹枫似火",
      subtitle: "朱砂霜叶层林尽染与暖金暮霭远山",
      previewBackground:
        "linear-gradient(135deg, #e0b898 0%, #a84a40 52%, #682828 100%)",
    }),
    artPreset({
      id: "snow-river",
      category: "eastern",
      tag: "浅绛山水",
      name: "寒江雪霁 · 独钓空濛",
      subtitle: "雪后江天留白、浅绛远岫与一蓑寒波",
      previewBackground:
        "linear-gradient(135deg, #d8e0e6 0%, #7d8d95 52%, #46565e 100%)",
    }),
    // ── 现代光影 ──
    artPreset({
      id: "arch-sunbeam",
      category: "modern",
      tag: "极简建筑",
      name: "光影回廊 · 极简几何",
      subtitle: "暖陶拱廊、斜射夕照金光与静水几何倒影",
      previewBackground:
        "linear-gradient(135deg, #d7b196 0%, #a06b65 52%, #6e6378 100%)",
    }),
    artPreset({
      id: "mineral-agate",
      category: "modern",
      tag: "流体矿物",
      name: "流金玛瑙 · 矿物肌理",
      subtitle: "孔雀青蓝丝绸层理、珠母流光与金缮细脉",
      previewBackground:
        "linear-gradient(135deg, #162a38 0%, #2f5b55 52%, #b9ae95 100%)",
    }),
    artPreset({
      id: "nordic-fjord",
      category: "modern",
      tag: "极地绘境",
      name: "极昼冰峡 · 幻彩静谧",
      subtitle: "薄荷粉紫极光丝带与镜面冰川峡湾雪峰",
      previewBackground:
        "linear-gradient(135deg, #2d3e56 0%, #73998f 50%, #243b55 100%)",
    }),
    artPreset({
      id: "nebula-drift",
      category: "modern",
      tag: "深空影像",
      name: "星云漫游 · 深空絮语",
      subtitle: "紫粉星云弥散、微光尘埃与漫天星屑",
      previewBackground:
        "linear-gradient(135deg, #141a3a 0%, #3a2a5e 52%, #6a4a8a 100%)",
    }),
    artPreset({
      id: "dune-gold",
      category: "modern",
      tag: "自然光影",
      name: "沙海鎏金 · 大漠弧线",
      subtitle: "落日斜照沙丘流线与明暗鎏金分界",
      previewBackground:
        "linear-gradient(135deg, #e0ac6c 0%, #a06838 52%, #6e4020 100%)",
    }),
  ] as const;

export const WALLPAPER_PRESETS: readonly WallpaperPresetMeta[] = [
  {
    id: "none",
    category: null,
    tag: null,
    name: "动态天空（默认）",
    subtitle: "使用实时大气散射与流云引擎",
    previewBackground:
      "linear-gradient(180deg, #1d57a9 0%, #3e7bd1 40%, #6da7ec 76%, #b0d5f7 100%)",
    thumbUrl: null,
    imageUrl: null,
    cssImage: null,
  },
  ...ARTISTIC_WALLPAPER_PRESETS,
] as const;

const VALID_ARTISTIC_WALLPAPERS = new Set<string>(
  ARTISTIC_WALLPAPER_PRESETS.map((w) => w.id),
);

/** 旧版本曾用过的几何 SVG 预设名平滑映射到风格最接近的艺术画作。 */
export const LEGACY_WALLPAPER_ID_MAP: Readonly<
  Record<string, ArtisticWallpaperPresetId>
> = {
  "aurora-mesh": "nordic-fjord",
  "mountain-mist": "qinglv-shanhe",
  "ocean-abyss": "waterlily-pond",
  "sakura-dream": "fuji-sakura",
  "sunset-dunes": "tuscan-golden",
  "cyber-neon": "mineral-agate",
  "starlight-cosmos": "starry-rhone",
};

// ---------------------------------------------------------------------------
// 旧 16 键清单 + 外部/幽灵键清单（供迁移与清退）
// ---------------------------------------------------------------------------

export const WALLPAPER_ID_STORAGE_KEY = "chisabot-wallpaper-id";
export const WALLPAPER_CUSTOM_URL_STORAGE_KEY = "chisabot-wallpaper-custom-url";
export const WALLPAPER_BLUR_STORAGE_KEY = "chisabot-wallpaper-blur";
export const WALLPAPER_DIM_STORAGE_KEY = "chisabot-wallpaper-dim";
export const WALLPAPER_SCRIM_STORAGE_KEY = "chisabot-wallpaper-scrim";
export const GLASS_OPACITY_STORAGE_KEY = "chisabot-glass-opacity";
export const GLASS_OPACITY_DARK_STORAGE_KEY = "chisabot-glass-opacity-dark";
export const HARK_SCENE_STORAGE_KEY = "chisabot-hark-scene";
export const LEGACY_PERF_MODE_STORAGE_KEY = "chisabot.perf-mode";
export const LEGACY_SKY_STORAGE_KEY = "chisabot-sky";
export const HARK_WEATHER_SNAPSHOT_STORAGE_KEY = "hark-wallpaper-v1";
export const HARK_ENGINE_STORAGE_KEYS: readonly string[] = [
  HARK_WEATHER_SNAPSHOT_STORAGE_KEY,
];

const LEGACY_FAMILY_LIGHT_KEY = "chisabot-theme-family-light";
const LEGACY_FAMILY_DARK_KEY = "chisabot-theme-family-dark";
const LEGACY_CUSTOM_FAMILIES_KEY = "chisabot-theme-families";
const LEGACY_PALETTE_KEY = "chisabot-theme-palette";
const LEGACY_GLASS_STYLE_KEY = "chisabot-glass-style";
const LEGACY_SKY_SOURCE_KEY = "chisabot-sky-source";

/** V1 遗留的 16 个外观存储键 + 幽灵旧键，迁移落盘 V2 后统一清退。 */
export const LEGACY_APPEARANCE_STORAGE_KEYS: readonly string[] = [
  THEME_STORAGE_KEY,
  LEGACY_FAMILY_LIGHT_KEY,
  LEGACY_FAMILY_DARK_KEY,
  LEGACY_CUSTOM_FAMILIES_KEY,
  LEGACY_PALETTE_KEY,
  LEGACY_GLASS_STYLE_KEY,
  GLASS_OPACITY_STORAGE_KEY,
  GLASS_OPACITY_DARK_STORAGE_KEY,
  LEGACY_SKY_SOURCE_KEY,
  HARK_SCENE_STORAGE_KEY,
  WALLPAPER_ID_STORAGE_KEY,
  WALLPAPER_CUSTOM_URL_STORAGE_KEY,
  WALLPAPER_BLUR_STORAGE_KEY,
  WALLPAPER_DIM_STORAGE_KEY,
  WALLPAPER_SCRIM_STORAGE_KEY,
  LEGACY_PERF_MODE_STORAGE_KEY,
  LEGACY_SKY_STORAGE_KEY,
  HARK_WEATHER_SNAPSHOT_STORAGE_KEY,
];

function parseLegacyCustomFamilyAccents(
  raw: string | null,
): Map<string, { lightAc: string | null; darkAc: string | null }> {
  const out = new Map<
    string,
    { lightAc: string | null; darkAc: string | null }
  >();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return out;
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.id !== "string" || !obj.id.trim()) continue;
      const light =
        obj.light && typeof obj.light === "object"
          ? (obj.light as Record<string, unknown>)
          : null;
      const dark =
        obj.dark && typeof obj.dark === "object"
          ? (obj.dark as Record<string, unknown>)
          : null;
      out.set(obj.id, {
        lightAc: normalizeHexColor(
          typeof light?.ac === "string" ? light.ac : null,
        ),
        darkAc: normalizeHexColor(
          typeof dark?.ac === "string" ? dark.ac : null,
        ),
      });
    }
  } catch {
    // 忽略损坏的旧自定义族 JSON
  }
  return out;
}

const VALID_MATERIALS = new Set<MaterialId>(["glass", "clear", "solid"]);
const VALID_SKY_SCENES = new Set<SkySceneId>([
  "auto",
  "dawn",
  "day",
  "dusk",
  "night",
]);

function clampInt(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function parseOptionalNumber(raw: string | null): number {
  if (raw === null || raw.trim() === "") return Number.NaN;
  return Number(raw);
}

function normalizeCity(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 80) : null;
}

function normalizeWallpaperSource(
  raw: unknown,
): ArtisticWallpaperPresetId | "custom" | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "custom") return "custom";
  if (trimmed in LEGACY_WALLPAPER_ID_MAP) {
    return LEGACY_WALLPAPER_ID_MAP[trimmed] ?? null;
  }
  if (VALID_ARTISTIC_WALLPAPERS.has(trimmed)) {
    return trimmed as ArtisticWallpaperPresetId;
  }
  return null;
}

export function normalizeCanvasConfig(raw: unknown): CanvasConfig {
  if (!raw || typeof raw !== "object") {
    return {
      kind: "sky",
      scene: "auto",
      weather: { enabled: false, city: null },
    };
  }
  const c = raw as Record<string, unknown>;
  if (c.kind === "pure") {
    return { kind: "pure" };
  }
  if (c.kind === "wallpaper") {
    const source = normalizeWallpaperSource(c.source) ?? "waterlily-pond";
    return {
      kind: "wallpaper",
      source,
      blur: clampInt(
        typeof c.blur === "number" ? c.blur : Number.NaN,
        WALLPAPER_BLUR_MIN,
        WALLPAPER_BLUR_MAX,
        DEFAULT_WALLPAPER_BLUR,
      ),
      scrim: clampInt(
        typeof c.scrim === "number" ? c.scrim : Number.NaN,
        WALLPAPER_SCRIM_MIN,
        WALLPAPER_SCRIM_MAX,
        DEFAULT_WALLPAPER_SCRIM,
      ),
    };
  }
  const scene: SkySceneId =
    typeof c.scene === "string" && VALID_SKY_SCENES.has(c.scene as SkySceneId)
      ? (c.scene as SkySceneId)
      : "auto";
  const weatherObj =
    c.weather && typeof c.weather === "object"
      ? (c.weather as Record<string, unknown>)
      : null;
  return {
    kind: "sky",
    scene,
    weather: {
      enabled: Boolean(weatherObj?.enabled),
      city: normalizeCity(weatherObj?.city),
    },
  };
}

/** 校验并规整 V2 存储 JSON；非法或非 v:2 返回 null。 */
export function parseAppearanceConfig(
  raw: string | null,
): AppearanceConfigV2 | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.v !== 2) return null;
    const mode = parseAppearanceMode(
      typeof obj.mode === "string" ? obj.mode : null,
    );
    const theme: ThemeId = isThemeId(obj.theme) ? obj.theme : DEFAULT_THEME_ID;
    const customAccent = normalizeHexColor(
      typeof obj.customAccent === "string" ? obj.customAccent : null,
    );
    const material: MaterialId =
      typeof obj.material === "string" &&
      VALID_MATERIALS.has(obj.material as MaterialId)
        ? (obj.material as MaterialId)
        : "glass";
    const canvas = normalizeCanvasConfig(obj.canvas);
    const staticBackground = Boolean(obj.staticBackground);
    return {
      v: 2,
      mode,
      theme,
      customAccent,
      material,
      canvas,
      staticBackground,
    };
  } catch {
    return null;
  }
}

function mapLegacyHarkScene(raw: string | null): {
  scene: SkySceneId;
  weatherEnabled: boolean;
} {
  switch (raw) {
    case "live":
      return { scene: "auto", weatherEnabled: true };
    case "11":
      return { scene: "dawn", weatherEnabled: false };
    case "0":
    case "3":
    case "5":
    case "7":
    case "9":
      return { scene: "day", weatherEnabled: false };
    case "1":
    case "6":
    case "8":
      return { scene: "dusk", weatherEnabled: false };
    case "2":
    case "4":
    case "10":
      return { scene: "night", weatherEnabled: false };
    default:
      return { scene: "auto", weatherEnabled: false };
  }
}

export interface LegacyMigrationResult {
  config: AppearanceConfigV2;
  /** 是否存在任意旧键并触发了迁移。 */
  migrated: boolean;
  /** 若旧键 chisabot-wallpaper-custom-url 存着内联 data URL，需要异步迁入 IndexedDB。 */
  legacyWallpaperDataUrl: string | null;
  /** 是否需要从 IndexedDB 读回自定义壁纸。 */
  needsWallpaperHydrate: boolean;
}

/**
 * 纯函数：将旧 16 键一次性无损迁移为 `AppearanceConfigV2`。
 * 不直接读写 DOM / localStorage，便于全组合单元测试。
 */
export function migrateLegacyAppearance(
  get: (key: string) => string | null,
  systemDark = false,
): LegacyMigrationResult {
  const hasAnyLegacy = LEGACY_APPEARANCE_STORAGE_KEYS.some((key) => {
    try {
      return get(key) !== null;
    } catch {
      return false;
    }
  });

  if (!hasAnyLegacy) {
    return {
      config: cloneConfig(DEFAULT_APPEARANCE_CONFIG),
      migrated: false,
      legacyWallpaperDataUrl: null,
      needsWallpaperHydrate: false,
    };
  }

  const rawTheme = get(THEME_STORAGE_KEY);
  const mode: AppearanceMode =
    rawTheme === "dark" ? "dark" : rawTheme === "light" ? "light" : "system";
  const activeDark = resolveDarkTheme(mode, systemDark);

  const perfOn = get(LEGACY_PERF_MODE_STORAGE_KEY) === "on";

  const customFamilyAccents = parseLegacyCustomFamilyAccents(
    get(LEGACY_CUSTOM_FAMILIES_KEY),
  );
  const rawFamilyActive = activeDark
    ? get(LEGACY_FAMILY_DARK_KEY)
    : get(LEGACY_FAMILY_LIGHT_KEY);
  const rawFamilyFallback = activeDark
    ? get(LEGACY_FAMILY_LIGHT_KEY)
    : get(LEGACY_FAMILY_DARK_KEY);
  const rawPalette = get(LEGACY_PALETTE_KEY);
  const candidateFamilyId = rawFamilyActive || rawFamilyFallback || rawPalette;

  let theme: ThemeId = DEFAULT_THEME_ID;
  let customAccent: string | null = null;
  const mappedBuiltIn = mapLegacyThemeId(candidateFamilyId);
  if (mappedBuiltIn) {
    theme = mappedBuiltIn;
  } else if (candidateFamilyId) {
    const customMatch = customFamilyAccents.get(candidateFamilyId);
    if (customMatch) {
      customAccent = activeDark ? customMatch.darkAc : customMatch.lightAc;
      theme = DEFAULT_THEME_ID;
    }
  }

  const rawGlass = get(LEGACY_GLASS_STYLE_KEY);
  const material: MaterialId = perfOn
    ? "solid"
    : rawGlass === "crystal" || rawGlass === "liquid"
      ? "clear"
      : "glass";
  const staticBackground = perfOn;

  const rawWallpaperId = get(WALLPAPER_ID_STORAGE_KEY);
  const wallpaperSource =
    rawWallpaperId && rawWallpaperId !== "none"
      ? normalizeWallpaperSource(rawWallpaperId)
      : null;

  const storedCustomUrl = get(WALLPAPER_CUSTOM_URL_STORAGE_KEY) ?? "";
  const legacyWallpaperDataUrl = storedCustomUrl.startsWith("data:")
    ? storedCustomUrl
    : null;

  let canvas: CanvasConfig;
  if (wallpaperSource) {
    const rawBlur = parseOptionalNumber(get(WALLPAPER_BLUR_STORAGE_KEY));
    const rawDim = parseOptionalNumber(get(WALLPAPER_DIM_STORAGE_KEY));
    const rawScrim = parseOptionalNumber(get(WALLPAPER_SCRIM_STORAGE_KEY));
    const blur = clampInt(
      rawBlur,
      WALLPAPER_BLUR_MIN,
      WALLPAPER_BLUR_MAX,
      DEFAULT_WALLPAPER_BLUR,
    );
    const scrim =
      Number.isNaN(rawDim) && Number.isNaN(rawScrim)
        ? DEFAULT_WALLPAPER_SCRIM
        : clampInt(
            (Number.isFinite(rawScrim) ? rawScrim : 53) * 0.65 +
              (Number.isFinite(rawDim) ? rawDim : 18) * 0.5,
            WALLPAPER_SCRIM_MIN,
            WALLPAPER_SCRIM_MAX,
            DEFAULT_WALLPAPER_SCRIM,
          );
    canvas = {
      kind: "wallpaper",
      source: wallpaperSource,
      blur,
      scrim,
    };
  } else {
    const rawSkySource = get(LEGACY_SKY_SOURCE_KEY);
    const rawHarkScene = get(HARK_SCENE_STORAGE_KEY);
    const rawLegacySky = get(LEGACY_SKY_STORAGE_KEY);
    const isPure =
      rawSkySource === "theme" ||
      (!rawSkySource && rawPalette !== null && rawPalette !== "default") ||
      (!rawSkySource && !rawHarkScene && rawLegacySky === "off");
    if (isPure) {
      canvas = { kind: "pure" };
    } else {
      const mapped = mapLegacyHarkScene(rawHarkScene);
      canvas = {
        kind: "sky",
        scene: mapped.scene,
        weather: { enabled: mapped.weatherEnabled, city: null },
      };
    }
  }

  const needsWallpaperHydrate =
    canvas.kind === "wallpaper" &&
    canvas.source === "custom" &&
    !legacyWallpaperDataUrl;

  return {
    config: {
      v: 2,
      mode,
      theme,
      customAccent,
      material,
      canvas,
      staticBackground,
    },
    migrated: true,
    legacyWallpaperDataUrl,
    needsWallpaperHydrate,
  };
}

function cloneConfig(config: AppearanceConfigV2): AppearanceConfigV2 {
  if (config.canvas.kind === "sky") {
    return {
      ...config,
      canvas: {
        kind: "sky",
        scene: config.canvas.scene,
        weather: { ...config.canvas.weather },
      },
    };
  }
  return { ...config, canvas: { ...config.canvas } };
}

/** 全字段精确判脏：用于「恢复默认」按钮显隐。 */
export function isDefaultAppearance(config: AppearanceConfigV2): boolean {
  if (config.mode !== DEFAULT_APPEARANCE_CONFIG.mode) return false;
  if (config.theme !== DEFAULT_APPEARANCE_CONFIG.theme) return false;
  if (config.customAccent !== DEFAULT_APPEARANCE_CONFIG.customAccent)
    return false;
  if (config.material !== DEFAULT_APPEARANCE_CONFIG.material) return false;
  if (config.staticBackground !== DEFAULT_APPEARANCE_CONFIG.staticBackground)
    return false;
  if (config.canvas.kind !== "sky") return false;
  return (
    config.canvas.scene === "auto" &&
    config.canvas.weather.enabled === false &&
    config.canvas.weather.city === null
  );
}

/**
 * 是否允许向 Open-Meteo 发起实时天气请求：
 * 仅当画布是动态天空、时刻为 auto、且用户显式开启了实时天气时才返回 true；
 * 其余任何情况（pure / wallpaper / 固定时刻 / 关闭实时天气）严格返回 false（0 网络请求）。
 */
export function shouldFetchLiveWeather(config: AppearanceConfigV2): boolean {
  return (
    config.canvas.kind === "sky" &&
    config.canvas.scene === "auto" &&
    config.canvas.weather.enabled === true
  );
}

/**
 * 「随时间流动（auto）」且未开启实时天气时，按本机时间沿浅色昼/晨昏、深色暮/星夜弧线平滑演化：
 *  - 浅色模式：06:00–18:30 直接按本机真实时刻走；夜间平滑落到柔和晨曦（06:15）或暖晚（17:36）；
 *  - 深色模式：18:30–06:00 直接按本机真实夜空走；白天沿 19:15 → 23:45 → 04:15 的暮夜弧线柔和演化。
 */
export function resolveAutoSkyHour(localHour: number, dark: boolean): number {
  const h = ((localHour % 24) + 24) % 24;
  if (!dark) {
    if (h >= 6 && h <= 18.5) return h;
    if (h < 6) return 6.2 + (h / 6) * 0.4;
    return 17.6 - ((h - 18.5) / 5.5) * 0.4;
  }
  if (h >= 18.5 || h < 6) return h;
  // 白天 06:00–18:30 → 映射到 19.25 → 24/0 → 4.25（总计 9 小时夜间弧线）
  const t = (h - 6) / 12.5;
  return (19.25 + t * 9) % 24;
}

// ---------------------------------------------------------------------------
// 单一真相源 Store + IndexedDB 自定义壁纸水合 + 防抖写盘 + 跨标签页同步
// ---------------------------------------------------------------------------

function removeStoredKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 隐私模式或存储不可用时静默忽略。
  }
}

let currentConfig: AppearanceConfigV2 | null = null;
let customWallpaperUrl = "";
const listeners = new Set<() => void>();

let pendingWallpaperLoad: "hydrate" | "migrate" | null = null;
let pendingLegacyDataUrl: string | null = null;
let persistencePromise: Promise<void> = Promise.resolve();
let wallpaperLoading = false;
let wallpaperLoadGeneration = 0;

export const WALLPAPER_LOAD_TIMEOUT_MS = 1500;
export const SLIDER_WRITE_DELAY_MS = 200;

let pendingConfigWrite: string | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

/** 立即落盘等待中的防抖配置写入（pagehide / 测试使用）。 */
export function flushAppearanceWrites(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (pendingConfigWrite !== null) {
    const payload = pendingConfigWrite;
    pendingConfigWrite = null;
    writeStoredPreference(APPEARANCE_STORAGE_KEY, payload);
  }
}

function persistConfig(config: AppearanceConfigV2, debounced = false): void {
  const json = JSON.stringify(config);
  if (!debounced) {
    if (writeTimer !== null) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    pendingConfigWrite = null;
    writeStoredPreference(APPEARANCE_STORAGE_KEY, json);
    return;
  }
  pendingConfigWrite = json;
  if (writeTimer !== null) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flushAppearanceWrites();
  }, SLIDER_WRITE_DELAY_MS);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushAppearanceWrites);
}

function readInitialConfig(): AppearanceConfigV2 {
  const rawV2 = readStoredPreference(APPEARANCE_STORAGE_KEY);
  const parsedV2 = parseAppearanceConfig(rawV2);
  if (parsedV2) {
    pendingLegacyDataUrl = null;
    pendingWallpaperLoad =
      parsedV2.canvas.kind === "wallpaper" &&
      parsedV2.canvas.source === "custom"
        ? "hydrate"
        : null;
    customWallpaperUrl = "";
    return parsedV2;
  }

  const migration = migrateLegacyAppearance(
    readStoredPreference,
    prefersSystemDark(),
  );
  if (migration.migrated) {
    writeStoredPreference(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify(migration.config),
    );
    for (const key of LEGACY_APPEARANCE_STORAGE_KEYS) {
      // 旧内联 data URL 先留到 IndexedDB 写入成功后再清，防中断丢图。
      if (
        key === WALLPAPER_CUSTOM_URL_STORAGE_KEY &&
        migration.legacyWallpaperDataUrl
      ) {
        continue;
      }
      removeStoredKey(key);
    }
  }

  if (migration.legacyWallpaperDataUrl) {
    customWallpaperUrl = migration.legacyWallpaperDataUrl;
    pendingLegacyDataUrl = migration.legacyWallpaperDataUrl;
    pendingWallpaperLoad = "migrate";
  } else {
    customWallpaperUrl = "";
    pendingLegacyDataUrl = null;
    pendingWallpaperLoad = migration.needsWallpaperHydrate ? "hydrate" : null;
  }
  return migration.config;
}

function finishWallpaperLoading(
  generation: number,
  dataUrl: string | null,
): void {
  if (generation !== wallpaperLoadGeneration) return;
  const config = currentConfig;
  const wantsCustom =
    config?.canvas.kind === "wallpaper" && config.canvas.source === "custom";
  const apply = Boolean(dataUrl) && wantsCustom && !customWallpaperUrl;
  if (!apply && !wallpaperLoading) return;
  wallpaperLoading = false;
  if (apply && dataUrl) {
    customWallpaperUrl = dataUrl;
  }
  if (currentConfig) applyAppearanceToDocument(currentConfig);
  emitChange();
}

async function loadStoredWallpaper(
  mode: "hydrate" | "migrate",
  generation: number,
  legacyUrl: string | null,
): Promise<void> {
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
      finishWallpaperLoading(generation, null);
      void read.then((late) => finishWallpaperLoading(generation, late));
      return;
    }
    finishWallpaperLoading(generation, first);
    return;
  }
  if (!legacyUrl?.startsWith("data:")) return;
  try {
    await backend.put(legacyUrl);
  } catch {
    return;
  }
  removeStoredKey(WALLPAPER_CUSTOM_URL_STORAGE_KEY);
}

function ensureConfig(): AppearanceConfigV2 {
  if (!currentConfig) {
    currentConfig = readInitialConfig();
    const mode = pendingWallpaperLoad;
    const legacyUrl = pendingLegacyDataUrl;
    pendingWallpaperLoad = null;
    pendingLegacyDataUrl = null;
    wallpaperLoadGeneration += 1;
    wallpaperLoading =
      mode === "hydrate" &&
      currentConfig.canvas.kind === "wallpaper" &&
      currentConfig.canvas.source === "custom";
    if (mode) {
      persistencePromise = loadStoredWallpaper(
        mode,
        wallpaperLoadGeneration,
        legacyUrl,
      );
    }
  }
  return currentConfig;
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function reloadAppearanceFromStorage(): Promise<void> {
  flushAppearanceWrites();
  currentConfig = null;
  customWallpaperUrl = "";
  ensureConfig();
  return persistencePromise;
}

export function getAppearanceConfig(): AppearanceConfigV2 {
  return ensureConfig();
}

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppearanceConfig(): AppearanceConfigV2 {
  return useSyncExternalStore(
    subscribeAppearance,
    getAppearanceConfig,
    getAppearanceConfig,
  );
}

export function getCustomWallpaperUrl(): string {
  ensureConfig();
  return customWallpaperUrl;
}

export function useCustomWallpaperUrl(): string {
  return useSyncExternalStore(
    subscribeAppearance,
    getCustomWallpaperUrl,
    getCustomWallpaperUrl,
  );
}

export function isWallpaperLoading(): boolean {
  ensureConfig();
  return wallpaperLoading;
}

export function useWallpaperLoading(): boolean {
  return useSyncExternalStore(
    subscribeAppearance,
    isWallpaperLoading,
    isWallpaperLoading,
  );
}

// ---------------------------------------------------------------------------
// DOM 应用：严格遵循冻结根属性契约 + #sky-root 壁纸微调变量
// ---------------------------------------------------------------------------

function setRootAttribute(
  root: HTMLElement,
  name: string,
  value: string | null,
): void {
  if (root.getAttribute(name) === value) return;
  if (value === null) root.removeAttribute(name);
  else root.setAttribute(name, value);
}

const LEGACY_ROOT_ATTRS = [
  "data-theme-family",
  "data-palette",
  "data-glass",
  "data-wallpaper",
] as const;

const LEGACY_ROOT_VARS = [
  "--lg-alpha",
  "--wallpaper-scrim-alpha",
  "--sky-lift",
  "--sky-muted",
  "--glass-sky",
  "--palette-sky-0",
  "--palette-sky-1",
  "--palette-sky-2",
  "--palette-sky-3",
  "--fam-sky-0",
  "--fam-sky-1",
  "--fam-sky-2",
  "--fam-sky-3",
] as const;

export function applyAppearanceToDocument(
  config: AppearanceConfigV2 = ensureConfig(),
  darkOverride?: boolean,
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const dark = darkOverride ?? resolveDarkTheme(config.mode);

  // 1. 唯一深浅色标记 html.dark + colorScheme（未变时不碰 classList，避免派发无谓 MutationObserver 变更）
  if (root.classList.contains("dark") !== dark) {
    root.classList.toggle("dark", dark);
  }
  const scheme = dark ? "dark" : "light";
  if (root.style.colorScheme !== scheme) root.style.colorScheme = scheme;

  // 2. 四轴核心正交根属性
  setRootAttribute(root, "data-theme", config.theme);
  setRootAttribute(root, "data-material", config.material);
  setRootAttribute(root, "data-canvas", config.canvas.kind);

  // 3. 辅助状态属性
  setRootAttribute(
    root,
    "data-static-bg",
    config.staticBackground ? "on" : null,
  );
  setRootAttribute(
    root,
    "data-perf",
    config.material === "solid" && config.staticBackground ? "on" : null,
  );

  // 4. 自定义强调色：仅非空时内联写入 <html>，为空时彻底清理
  if (config.customAccent) {
    const accentVars = deriveCustomAccentVars(config.customAccent, dark);
    for (const prop of CUSTOM_ACCENT_CSS_PROPS) {
      const val = accentVars[prop];
      if (root.style.getPropertyValue(prop) !== val) {
        root.style.setProperty(prop, val);
      }
    }
  } else {
    for (const prop of CUSTOM_ACCENT_CSS_PROPS) {
      if (root.style.getPropertyValue(prop)) {
        root.style.removeProperty(prop);
      }
    }
  }

  // 5. 壁纸微调变量：仅挂在 #sky-root（绝不挂在 <html> 触发整页样式重算）
  const skyRoot = document.getElementById("sky-root");
  if (skyRoot) {
    if (config.canvas.kind === "wallpaper") {
      const blurVal = `${config.canvas.blur}px`;
      const scrimVal = (config.canvas.scrim / 100).toFixed(2);
      if (skyRoot.style.getPropertyValue("--canvas-blur") !== blurVal) {
        skyRoot.style.setProperty("--canvas-blur", blurVal);
      }
      if (skyRoot.style.getPropertyValue("--canvas-scrim") !== scrimVal) {
        skyRoot.style.setProperty("--canvas-scrim", scrimVal);
      }
    } else {
      if (skyRoot.style.getPropertyValue("--canvas-blur")) {
        skyRoot.style.removeProperty("--canvas-blur");
      }
      if (skyRoot.style.getPropertyValue("--canvas-scrim")) {
        skyRoot.style.removeProperty("--canvas-scrim");
      }
    }
  }

  // 6. 清理历史残留属性、动态样式表 #chisabot-glass-alpha 与旧内联变量
  for (const attr of LEGACY_ROOT_ATTRS) {
    setRootAttribute(root, attr, null);
  }
  for (const prop of LEGACY_ROOT_VARS) {
    if (root.style.getPropertyValue(prop)) {
      root.style.removeProperty(prop);
    }
  }
  const legacyGlassStyle = document.getElementById("chisabot-glass-alpha");
  if (legacyGlassStyle) {
    legacyGlassStyle.remove();
  }

  // 7. 同步 <meta name="theme-color">
  applyThemeColor(themeMetaColor(config.theme, dark));
}

// ---------------------------------------------------------------------------
// V2 变更入口
// ---------------------------------------------------------------------------

export function setAppearanceConfig(
  patch: Partial<Omit<AppearanceConfigV2, "v">>,
  options?: { debounced?: boolean },
): void {
  const prev = ensureConfig();
  const next: AppearanceConfigV2 = {
    v: 2,
    mode:
      patch.mode !== undefined ? parseAppearanceMode(patch.mode) : prev.mode,
    theme:
      patch.theme !== undefined && isThemeId(patch.theme)
        ? patch.theme
        : prev.theme,
    customAccent:
      patch.customAccent !== undefined
        ? normalizeHexColor(patch.customAccent)
        : prev.customAccent,
    material:
      patch.material !== undefined && VALID_MATERIALS.has(patch.material)
        ? patch.material
        : prev.material,
    canvas:
      patch.canvas !== undefined
        ? normalizeCanvasConfig(patch.canvas)
        : prev.canvas,
    staticBackground:
      patch.staticBackground !== undefined
        ? Boolean(patch.staticBackground)
        : prev.staticBackground,
  };

  currentConfig = next;
  persistConfig(next, options?.debounced ?? false);

  if (
    wallpaperLoading &&
    (next.canvas.kind !== "wallpaper" ||
      next.canvas.source !== "custom" ||
      Boolean(customWallpaperUrl))
  ) {
    wallpaperLoading = false;
  }

  // 关闭实时天气或离开 auto 动态天空时，清理引擎快照键防止遗留缓存。
  if (!shouldFetchLiveWeather(next)) {
    for (const key of HARK_ENGINE_STORAGE_KEYS) {
      removeStoredKey(key);
    }
  }

  applyAppearanceToDocument(next);
  emitChange();
}

export function setAppearanceMode(mode: AppearanceMode): void {
  setAppearanceConfig({ mode });
}

export function setTheme(theme: ThemeId): void {
  setAppearanceConfig({ theme });
}

export function setCustomAccent(hex: string | null): void {
  setAppearanceConfig({ customAccent: hex ? normalizeHexColor(hex) : null });
}

export function setMaterial(material: MaterialId): void {
  setAppearanceConfig({ material });
}

export function setCanvas(canvas: CanvasConfig): void {
  setAppearanceConfig({ canvas });
}

export function setSkyScene(scene: SkySceneId): void {
  const prev = ensureConfig();
  const prevWeather =
    prev.canvas.kind === "sky"
      ? prev.canvas.weather
      : { enabled: false, city: null };
  setAppearanceConfig({
    canvas: {
      kind: "sky",
      scene,
      weather:
        scene === "auto"
          ? { ...prevWeather }
          : { enabled: false, city: prevWeather.city },
    },
  });
}

export function setSkyWeather(patch: {
  enabled?: boolean;
  city?: string | null;
}): void {
  const prev = ensureConfig();
  const prevSky =
    prev.canvas.kind === "sky"
      ? prev.canvas
      : {
          kind: "sky" as const,
          scene: "auto" as const,
          weather: { enabled: false, city: null },
        };
  const nextEnabled =
    patch.enabled !== undefined ? patch.enabled : prevSky.weather.enabled;
  const nextCity =
    patch.city !== undefined ? normalizeCity(patch.city) : prevSky.weather.city;
  setAppearanceConfig({
    canvas: {
      kind: "sky",
      scene: nextEnabled ? "auto" : prevSky.scene,
      weather: {
        enabled: nextEnabled,
        city: nextCity,
      },
    },
  });
}

export function setWallpaperSource(
  source: ArtisticWallpaperPresetId | "custom",
): void {
  const prev = ensureConfig();
  const blur =
    prev.canvas.kind === "wallpaper"
      ? prev.canvas.blur
      : DEFAULT_WALLPAPER_BLUR;
  const scrim =
    prev.canvas.kind === "wallpaper"
      ? prev.canvas.scrim
      : DEFAULT_WALLPAPER_SCRIM;
  setAppearanceConfig({
    canvas: {
      kind: "wallpaper",
      source,
      blur,
      scrim,
    },
  });
}

export function setWallpaperAdjustments(patch: {
  blur?: number;
  scrim?: number;
}): void {
  const prev = ensureConfig();
  if (prev.canvas.kind !== "wallpaper") return;
  setAppearanceConfig(
    {
      canvas: {
        kind: "wallpaper",
        source: prev.canvas.source,
        blur:
          patch.blur !== undefined
            ? clampInt(
                patch.blur,
                WALLPAPER_BLUR_MIN,
                WALLPAPER_BLUR_MAX,
                prev.canvas.blur,
              )
            : prev.canvas.blur,
        scrim:
          patch.scrim !== undefined
            ? clampInt(
                patch.scrim,
                WALLPAPER_SCRIM_MIN,
                WALLPAPER_SCRIM_MAX,
                prev.canvas.scrim,
              )
            : prev.canvas.scrim,
      },
    },
    { debounced: true },
  );
}

export function setStaticBackground(staticBackground: boolean): void {
  setAppearanceConfig({ staticBackground });
}

export function resetAppearance(): void {
  flushAppearanceWrites();
  customWallpaperUrl = "";
  wallpaperLoading = false;
  const next = cloneConfig(DEFAULT_APPEARANCE_CONFIG);
  currentConfig = next;
  persistConfig(next, false);
  for (const key of LEGACY_APPEARANCE_STORAGE_KEYS) {
    removeStoredKey(key);
  }
  getWallpaperBackend()
    .remove()
    .catch(() => {});
  getWallpaperBackend()
    .removeSource?.()
    .catch(() => {});
  applyAppearanceToDocument(next);
  emitChange();
}

// ---------------------------------------------------------------------------
// 跨标签页同步
// ---------------------------------------------------------------------------

export function syncAppearanceFromStorage(key: string | null): Promise<void> {
  if (key !== null && key !== APPEARANCE_STORAGE_KEY) {
    return Promise.resolve();
  }
  pendingConfigWrite = null;
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  const prev = ensureConfig();
  const prevUrl = customWallpaperUrl;
  const raw = readStoredPreference(APPEARANCE_STORAGE_KEY);
  const parsed = parseAppearanceConfig(raw);
  const next = parsed ?? cloneConfig(DEFAULT_APPEARANCE_CONFIG);

  const needsHydrate =
    next.canvas.kind === "wallpaper" &&
    next.canvas.source === "custom" &&
    (!prevUrl || key === null);

  if (key === null) {
    customWallpaperUrl = "";
  }

  const changed = JSON.stringify(prev) !== JSON.stringify(next) || key === null;
  currentConfig = next;

  if (needsHydrate) {
    wallpaperLoadGeneration += 1;
    wallpaperLoading = true;
    persistencePromise = loadStoredWallpaper(
      "hydrate",
      wallpaperLoadGeneration,
      null,
    );
    applyAppearanceToDocument(next);
    emitChange();
    return persistencePromise;
  }

  if (changed) {
    applyAppearanceToDocument(next);
    emitChange();
  }
  return Promise.resolve();
}

function onAppearanceStorageEvent(event: StorageEvent): void {
  if (event.storageArea && event.storageArea !== window.localStorage) return;
  void syncAppearanceFromStorage(event.key);
}

export function installAppearanceStorageSync(): void {
  if (typeof window === "undefined") return;
  // 传同一函数引用，浏览器与 DOM 规范自动去重；测试进程重建 window 时也能可靠重挂。
  window.addEventListener("storage", onAppearanceStorageEvent);
}

// ---------------------------------------------------------------------------
// 壁纸解析、上传、裁剪与压缩
// ---------------------------------------------------------------------------

export function resolveWallpaperCssFromConfig(
  config: AppearanceConfigV2,
  customUrl: string = customWallpaperUrl,
): string | null {
  if (config.canvas.kind !== "wallpaper") return null;
  const { source } = config.canvas;
  if (source === "custom") {
    const u = customUrl.trim();
    if (!u) return null;
    if (/^(https?:\/\/|data:image\/|blob:|\/)/i.test(u)) {
      return `url("${u.replace(/[\r\n\f]/g, "").replace(/[\\"]/g, "\\$&")}")`;
    }
    return null;
  }
  const found = ARTISTIC_WALLPAPER_PRESETS.find((w) => w.id === source);
  return found?.cssImage ?? null;
}

/** 保存上传的壁纸：先写进 IndexedDB，成功后切换为自定义壁纸。 */
export async function saveUploadedWallpaper(dataUrl: string): Promise<void> {
  try {
    await getWallpaperBackend().put(dataUrl);
  } catch (error) {
    const detail =
      error instanceof Error && error.message ? `：${error.message}` : "";
    throw new Error(`壁纸保存失败，可能是浏览器存储空间不足${detail}`);
  }
  customWallpaperUrl = dataUrl;
  setWallpaperSource("custom");
}

export function removeCustomWallpaper(): void {
  customWallpaperUrl = "";
  getWallpaperBackend()
    .remove()
    .catch(() => {});
  getWallpaperBackend()
    .removeSource?.()
    .catch(() => {});
  const prev = ensureConfig();
  if (prev.canvas.kind === "wallpaper" && prev.canvas.source === "custom") {
    setCanvas({
      kind: "sky",
      scene: "auto",
      weather: { enabled: false, city: null },
    });
  } else {
    emitChange();
  }
}

export async function loadUploadedWallpaperSource(): Promise<WallpaperSourceRecord | null> {
  try {
    const record = await getWallpaperBackend().getSource?.();
    return record ?? null;
  } catch {
    return null;
  }
}

export async function saveUploadedWallpaperSource(
  record: WallpaperSourceRecord,
): Promise<void> {
  try {
    await getWallpaperBackend().putSource?.(record);
  } catch {
    // 原图缓存写入失败不阻断已生效的自定义壁纸。
  }
}

export const ALLOWED_WALLPAPER_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
];
export const MAX_WALLPAPER_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_WALLPAPER_DATA_URL_CHARS = 6_000_000;

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

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

export function assertWallpaperDataUrlSize(dataUrl: string): string {
  if (dataUrl.length > MAX_WALLPAPER_DATA_URL_CHARS) {
    throw new Error("图片压缩后仍然太大，请换一张分辨率更低或更简单的图片");
  }
  return dataUrl;
}

export async function compressUploadedWallpaper(file: File): Promise<string> {
  const invalid = validateWallpaperFile(file);
  if (invalid) throw new Error(invalid);
  return assertWallpaperDataUrlSize(await compressWallpaperImage(file));
}

export async function compressCroppedWallpaper(
  source: Blob,
  crop?: PixelCropRect,
): Promise<string> {
  if (source instanceof File) {
    const invalid = validateWallpaperFile(source);
    if (invalid) throw new Error(invalid);
  }
  return assertWallpaperDataUrlSize(
    await compressWallpaperImage(source, crop ? { crop } : undefined),
  );
}

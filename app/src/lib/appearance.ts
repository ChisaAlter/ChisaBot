import { useSyncExternalStore } from "react";
import {
  DEFAULT_GLASS_STYLE,
  fallbackGlassStyle,
  GLASS_STYLE_STORAGE_KEY,
  PALETTE_STORAGE_KEY,
  THEME_PALETTES,
  type ThemePaletteId,
} from "@/lib/palette";
import {
  readStoredPreference,
  writeStoredPreference,
} from "@/lib/preference-storage";
import { compressWallpaperImage } from "@/lib/wallpaper-compress";
import {
  getWallpaperBackend,
  WALLPAPER_IDB_MARKER,
} from "@/lib/wallpaper-store";

// 配色表搬到了纯模块 lib/palette.ts（构建时要内联进 index.html 的启动脚本），这里照旧导出。
export {
  applyThemeColor,
  computePaletteSky,
  DEFAULT_GLASS_STYLE,
  fallbackGlassStyle,
  GLASS_STYLE_STORAGE_KEY,
  LEGACY_DEFAULT_GLASS_STYLE,
  PRIOR_APPEARANCE_STORAGE_KEYS,
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
export const WALLPAPER_SCRIM_STORAGE_KEY = "chisabot-wallpaper-scrim";
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
/**
 * 默认雾度（%，浅 / 深两档同值）：新用户、「恢复默认」、存储值为空或非法时都回到它。
 * 要换默认值只改这一个常量（styles.css 里 var(--lg-alpha, 0.16) 只是 JS 写入前的兜底，
 * 运行时 --lg-alpha 总由 writeGlassAlpha 按这里的值写好）。
 */
export const DEFAULT_GLASS_OPACITY = 16;

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
  | "qinglv-shanhe"
  | "fuji-sakura"
  | "ink-bamboo-mist"
  | "arch-sunbeam"
  | "mineral-agate"
  | "nordic-fjord";

export type WallpaperPresetId = "none" | ArtisticWallpaperPresetId | "custom";

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
  ] as const;

export const WALLPAPER_PRESETS: readonly WallpaperPresetMeta[] = [
  {
    id: "none",
    category: null,
    tag: null,
    name: "Hark 动态天空（默认）",
    subtitle: "使用 Hark 原生 WebGL 实时大气散射与流云引擎",
    previewBackground:
      "linear-gradient(180deg, #1d57a9 0%, #3e7bd1 40%, #6da7ec 76%, #b0d5f7 100%)",
    thumbUrl: null,
    imageUrl: null,
    cssImage: null,
  },
  ...ARTISTIC_WALLPAPER_PRESETS,
] as const;

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

export type AppearanceState = {
  palette: ThemePaletteId;
  glassStyle: GlassStyleId;
  /** 玻璃面板不透明度（GLASS_OPACITY_MIN ~ MAX，默认 DEFAULT_GLASS_OPACITY）——浅色档 */
  glassOpacity: number;
  /** 深色档（同上；未存过时跟随浅色档的值） */
  glassOpacityDark: number;
  /** Hark WebGL 动态天空场景（默认 "auto"） */
  harkScene: HarkSkySceneId;
  wallpaperId: WallpaperPresetId;
  customWallpaperUrl: string;
  wallpaperBlur: number;
  wallpaperDim: number;
  /** 壁纸薄幕浓度（%，0–100）：.chisabot-wallpaper::after 那一层统一纱罩的透明度。 */
  wallpaperScrim: number;
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

/** 存储里的数字：没存、空串、纯空白都当「没有值」（NaN），交给 clampNumber 回默认，不当 0。 */
function readStoredNumber(key: string): number {
  const raw = readStoredPreference(key);
  if (raw === null || raw.trim() === "") return Number.NaN;
  return Number(raw);
}

function resolveStoredGlassStyle(rawGlass: GlassStyleId | null): GlassStyleId {
  if (rawGlass && VALID_GLASS_STYLES.has(rawGlass)) return rawGlass;
  const glass = fallbackGlassStyle(readStoredPreference);
  writeStoredPreference(GLASS_STYLE_STORAGE_KEY, glass);
  return glass;
}

function readInitialAppearance(): AppearanceState {
  const rawPalette = readStoredPreference(
    PALETTE_STORAGE_KEY,
  ) as ThemePaletteId | null;
  const rawGlass = readStoredPreference(
    GLASS_STYLE_STORAGE_KEY,
  ) as GlassStyleId | null;
  const rawGlassOpacity = readStoredNumber(GLASS_OPACITY_STORAGE_KEY);
  const rawHarkScene = readStoredPreference(
    HARK_SCENE_STORAGE_KEY,
  ) as HarkSkySceneId | null;
  const rawWallpaperKey = readStoredPreference(WALLPAPER_ID_STORAGE_KEY);
  const rawWallpaperId = (
    rawWallpaperKey && rawWallpaperKey in LEGACY_WALLPAPER_ID_MAP
      ? LEGACY_WALLPAPER_ID_MAP[rawWallpaperKey]
      : rawWallpaperKey
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
  const rawBlur = readStoredNumber(WALLPAPER_BLUR_STORAGE_KEY);
  const rawDim = readStoredNumber(WALLPAPER_DIM_STORAGE_KEY);
  const rawScrim = readStoredNumber(WALLPAPER_SCRIM_STORAGE_KEY);
  const glassOpacity = clampNumber(
    rawGlassOpacity,
    GLASS_OPACITY_MIN,
    GLASS_OPACITY_MAX,
    DEFAULT_GLASS_OPACITY,
  );

  return {
    palette:
      rawPalette && VALID_PALETTES.has(rawPalette) ? rawPalette : "default",
    // 没存材质：按 fallbackGlassStyle 判定一次（不含会自动写入的深浅主题），并立刻写入
    // glass-style，这样 ThemeProvider 随后写入 chisabot-theme 也不会在下次加载时改口径。
    glassStyle: resolveStoredGlassStyle(rawGlass),
    glassOpacity,
    // 深色档没存过（或为空）就用浅色档的值，老用户拖过的滑块在深色下照旧生效。
    glassOpacityDark: clampNumber(
      readStoredNumber(GLASS_OPACITY_DARK_STORAGE_KEY),
      GLASS_OPACITY_MIN,
      GLASS_OPACITY_MAX,
      glassOpacity,
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
    wallpaperScrim: clampNumber(rawScrim, 0, 100, 53),
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
    [...(el.textContent ?? "").matchAll(/--lg-alpha:\s*([\d.]+)/g)][
      index
    ]?.[1] ?? null
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
  // 薄幕浓度：色在 styles.css 的深浅两条规则里，alpha 从根变量读，拖滑块只重算这一个值。
  // liquid-glass 画合成层时也从 documentElement 读 --wallpaper-scrim，两处自动一致。
  root.style.setProperty(
    "--wallpaper-scrim-alpha",
    (state.wallpaperScrim / 100).toFixed(2),
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
    wallpaperScrim:
      patch.wallpaperScrim !== undefined
        ? clampNumber(patch.wallpaperScrim, 0, 100, prev.wallpaperScrim)
        : prev.wallpaperScrim,
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
  // 第一次存任何外观设置时把当前材质一起钉进存储：不然新用户（mist）只拖一下雾度，
  // 下次加载会因为「存过外观设置」被当成老用户落回 liquid。
  if (
    prev.glassStyle === next.glassStyle &&
    readStoredPreference(GLASS_STYLE_STORAGE_KEY) === null
  ) {
    writeStoredPreference(GLASS_STYLE_STORAGE_KEY, next.glassStyle);
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
    [WALLPAPER_SCRIM_STORAGE_KEY, prev.wallpaperScrim, next.wallpaperScrim],
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
  WALLPAPER_SCRIM_STORAGE_KEY,
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

export function setWallpaperScrim(wallpaperScrim: number) {
  updateAppearance({ wallpaperScrim });
}

export function resetAppearanceDefaults() {
  updateAppearance({
    palette: "default",
    glassStyle: DEFAULT_GLASS_STYLE,
    glassOpacity: DEFAULT_GLASS_OPACITY,
    glassOpacityDark: DEFAULT_GLASS_OPACITY,
    harkScene: "auto",
    wallpaperId: "none",
    customWallpaperUrl: "",
    wallpaperBlur: 0,
    wallpaperDim: 18,
    wallpaperScrim: 53,
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
export function usesPaletteGradientSky(
  state: Pick<AppearanceState, "palette">,
): boolean {
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

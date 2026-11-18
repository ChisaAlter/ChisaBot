/**
 * CB-137：旧的「10 套皮肤」轴已被主题族（{@link ./theme-family}）取代。
 * 这个文件只剩兼容层：
 *  - 外观存储键（玻璃材质、天空来源）与「存过外观设置」的判定；
 *  - index.html 启动脚本（{@link familyBootScript}，由 vite.config.ts 的
 *    chisabot-sky-boot 插件构建时内联）：族解析 + seed 派生变量 + 材质 + theme-color。
 * 类型与常量 re-export 自 theme-family.ts；lib/appearance.ts 照旧从这里转口。
 *
 * 保持为一个不依赖 React / 别名路径的纯模块（启动脚本要序列化 deriveSeed 进 HTML）。
 */

import {
  CUSTOM_FAMILIES_STORAGE_KEY,
  DEFAULT_FAMILY_ID,
  deriveSeed,
  FAMILY_DARK_STORAGE_KEY,
  FAMILY_LIGHT_STORAGE_KEY,
  PALETTE_STORAGE_KEY,
  type Seed,
  THEME_FAMILIES,
} from "./theme-family";

export {
  CUSTOM_FAMILIES_STORAGE_KEY,
  DEFAULT_FAMILY_ID,
  deriveSeed,
  FAMILY_DARK_STORAGE_KEY,
  FAMILY_LIGHT_STORAGE_KEY,
  familySeed,
  familySkyStops,
  familyThemeColor,
  isValidFamily,
  isValidFamilyId,
  listThemeFamilies,
  migrateLegacyPalette,
  PALETTE_STORAGE_KEY,
  parseCustomFamilies,
  resolveThemeFamily,
  type Seed,
  THEME_FAMILIES,
  type ThemeFamily,
} from "./theme-family";

/** 默认配色的地址栏 / 状态栏颜色（族解析失败时的兜底，正常情况下永远解析得到 azure）。 */
export const DEFAULT_THEME_COLOR = {
  light: "#9dbddc",
  dark: "#0c1626",
} as const;

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

/**
 * 天空来源（2026-11 外观模型重构）：主题族与背景解耦——族只管整套派生令牌，
 * 天空是「Hark 动态天象」还是「族配套静态主题渐变」由这个键单独决定。
 * - "hark"（默认）：Hark WebGL 引擎渲染的天象（auto / live / 场景）。
 * - "theme"：当前族 seed 派生的静态主题渐变（引擎不启动，更省）。
 */
export const SKY_SOURCE_STORAGE_KEY = "chisabot-sky-source";
export type SkySourceId = "hark" | "theme";
export const GLASS_STYLE_STORAGE_KEY = "chisabot-glass-style";
const BOOT_GLASS_STYLES = ["liquid", "mist", "crystal", "frosted"];
/** 新用户（从没存过任何外观设置）的默认材质。 */
export const DEFAULT_GLASS_STYLE = "mist";
/** 0.1.138 以前的默认材质是 liquid；0.1.155 起统一回落薄雾玻璃（老用户已存的显式选择仍保留）。 */
export const LEGACY_DEFAULT_GLASS_STYLE = "mist";
/**
 * 材质以外的外观设置键。只要存过其中任何一个，就算「已保存过外观」的老用户，
 * 材质默认按 {@link LEGACY_DEFAULT_GLASS_STYLE}。
 * 不含 `chisabot-theme`：ThemeProvider 挂载时会自动写入，分不出用户有没有主动选过。
 * CB-137 后主题族键顶替旧的 palette 键；其余键与 appearance.ts 的同名常量对应
 * （tests/default-mist-glass.test.tsx 核对）。
 * 写在这里而不是 appearance.ts：启动脚本要内联这份列表，palette.ts 是不依赖 DOM 的纯模块。
 */
export const PRIOR_APPEARANCE_STORAGE_KEYS: readonly string[] = [
  FAMILY_LIGHT_STORAGE_KEY,
  "chisabot-wallpaper-id",
  "chisabot-wallpaper-custom-url",
  "chisabot-wallpaper-blur",
  "chisabot-wallpaper-dim",
  "chisabot-glass-opacity",
  "chisabot-glass-opacity-dark",
  "chisabot-hark-scene",
];

/**
 * 没存材质时用哪种：存过任何其他外观设置（不含会自动写入的深浅主题） → LEGACY_DEFAULT_GLASS_STYLE；
 * 什么都没存过（或只有自动写入的 chisabot-theme） → mist。get 读不到（隐私模式抛错）按没存过处理。
 * 判定结果由调用方立刻写入 glass-style，避免随后自动写入的主题键在下次加载时改口径。
 */
export function fallbackGlassStyle(
  get: (key: string) => string | null,
): "liquid" | "mist" {
  for (const key of PRIOR_APPEARANCE_STORAGE_KEYS) {
    try {
      if (get(key) !== null) return LEGACY_DEFAULT_GLASS_STYLE;
    } catch {
      return DEFAULT_GLASS_STYLE;
    }
  }
  return DEFAULT_GLASS_STYLE;
}

/** 旧 data-palette 轴 → 主题族的迁移表（启动脚本内联一份）。 */
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
 * index.html 的启动脚本（vite.config.ts 的 chisabot-sky-boot 插件塞在 <body> 第一行、时段天空之后）：
 * - 解析当前模式的主题族（新键优先；旧 palette 键一次性映射迁移；兜底 azure），
 *   在 <html> 上写 data-theme-family，把 deriveSeed 算出的整套变量写进 html/body 内联样式——
 *   启动骨架（读 --sky-1..4、--accent-color 等）React 接管前就是用户的主题；
 * - 写 data-glass（没存材质时按 {@link fallbackGlassStyle} 的同一条规则，并把结果写入 glass-style）；
 * - meta theme-color 取当前族天空渐变顶段。
 * deriveSeed 的函数体在构建时序列化内联（函数必须自包含，不能引用模块级变量）。
 */
export function familyBootScript(): string {
  const map: Record<string, { l: Seed; d: Seed }> = {};
  for (const f of THEME_FAMILIES) map[f.id] = { l: f.light, d: f.dark };
  return `(function(){try{var d=document.documentElement,s=window.localStorage,F=${JSON.stringify(map)},L=${JSON.stringify(LEGACY_PALETTE_TO_FAMILY)},P=${JSON.stringify(PRIOR_APPEARANCE_STORAGE_KEYS)},g=s.getItem(${JSON.stringify(GLASS_STYLE_STORAGE_KEY)}),k=d.classList.contains("dark"),c,i,m,w,seed,vars,fid,lm,dm,cu=[];if(${JSON.stringify(BOOT_GLASS_STYLES)}.indexOf(g)<0){g=${JSON.stringify(DEFAULT_GLASS_STYLE)};for(i=0;i<P.length;i++)if(s.getItem(P[i])!==null){g=${JSON.stringify(LEGACY_DEFAULT_GLASS_STYLE)};break}try{s.setItem(${JSON.stringify(GLASS_STYLE_STORAGE_KEY)},g)}catch(e){}}d.setAttribute("data-glass",g);try{var r=s.getItem(${JSON.stringify(CUSTOM_FAMILIES_STORAGE_KEY)});cu=r?JSON.parse(r):[]}catch(e){cu=[]}if(!Array.isArray(cu))cu=[];fid=function(v){if(!v)return null;if(F[v])return v;for(i=0;i<cu.length;i++){var f=cu[i];if(f&&f.id===v&&f.light&&f.dark)return v}return null};lm=s.getItem(${JSON.stringify(FAMILY_LIGHT_STORAGE_KEY)});dm=s.getItem(${JSON.stringify(FAMILY_DARK_STORAGE_KEY)});var lg=L[s.getItem(${JSON.stringify(PALETTE_STORAGE_KEY)})||""]||null;lm=fid(lm)||lg||${JSON.stringify(DEFAULT_FAMILY_ID)};dm=fid(dm)||lg||${JSON.stringify(DEFAULT_FAMILY_ID)};var id=k?dm:lm,fam=F[id];if(!fam){for(i=0;i<cu.length;i++){var cf=cu[i];if(cf&&cf.id===id){fam={l:cf.light,d:cf.dark};break}}}if(!fam){id=${JSON.stringify(DEFAULT_FAMILY_ID)};fam=F[id]}d.setAttribute("data-theme-family",id);seed=k?fam.d:fam.l;var derive=${deriveSeed.toString()};vars=derive(seed,k);for(i in vars.root)d.style.setProperty(i,vars.root[i]);if(document.body)for(i in vars.body)document.body.style.setProperty(i,vars.body[i]);c=vars.root["--fam-sky-0"]||seed.bg;m=document.querySelectorAll('meta[name="theme-color"]');for(i=0;i<m.length;i++)m[i].setAttribute("content",c);w=s.getItem("chisabot-wallpaper-scrim");if(w!=null)w=(Math.min(100,Math.max(0,parseFloat(w)||0))/100).toFixed(2),d.style.setProperty("--wallpaper-scrim-alpha",w)}catch(e){}})();`;
}

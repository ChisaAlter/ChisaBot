/**
 * V2 首屏外观启动脚本（唯一 `appearanceBootScript()`）与地址栏 theme-color 工具。
 *
 * 由 `app/vite.config.ts` 的 `chisabot-appearance-boot` 插件内联进 `app/index.html` 的 `<head>`，
 * 在首帧绘制前同步写好：
 *  - `html.dark` 与 `colorScheme`（支持 `system | light | dark`）
 *  - `html[data-theme="<ThemeId>"]`
 *  - `html[data-material="glass|clear|solid"]`
 *  - `html[data-canvas="pure|sky|wallpaper"]`
 *  - `html[data-static-bg="on"]` / `html[data-perf="on"]` / `html[data-sky="live|snapshot|off"]`
 *  - 自定义强调色内联变量（仅当 `customAccent` 非空）
 *  - `<meta name="theme-color">`
 *
 * 保持为不依赖 React / DOM 顶层引用的纯模块，供 Vite 构建时直接导入。
 */

import {
  DEFAULT_THEME_ID,
  deriveCustomAccentVars,
  LEGACY_THEME_MAP,
  THEMES,
  type ThemeId,
} from "./theme-family";

export {
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
} from "./theme-family";

export const APPEARANCE_STORAGE_KEY = "chisabot-appearance";

/** 默认配色的地址栏 / 状态栏颜色（兜底值）。 */
export const DEFAULT_THEME_COLOR = {
  light: "#9dbddc",
  dark: "#070d1c",
} as const;

/** 把所有 meta[name=theme-color] 改成同一个颜色（应用主题优先于系统媒体查询）。 */
export function applyThemeColor(
  color: string,
  doc: Document | undefined = typeof document !== "undefined"
    ? document
    : undefined,
): void {
  if (!doc) return;
  for (const meta of doc.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"]',
  )) {
    if (meta.content !== color) meta.content = color;
  }
}

/**
 * 唯一首屏同步启动脚本（合并旧 `skyBootScript` 与 `familyBootScript`）：
 * 纯只读解析 `localStorage["chisabot-appearance"]`（若尚未迁移则按同口径读取旧 16 键），
 * 首帧前同步挂齐 `.dark` + `data-theme` + `data-material` + `data-canvas` + `<meta name="theme-color">`，
 * 绝不向 localStorage 回写旧键，避免破坏 `mode: "system"`。
 */
export function appearanceBootScript(): string {
  const themeColors: Record<ThemeId, [string, string]> = {
    sky: ["#9dbddc", "#070d1c"],
    aurora: ["#a8e2d8", "#06151c"],
    porcelain: ["#c4d5ee", "#081226"],
    deepseek: ["#dde6ff", "#1e2025"],
    claude: ["#ece7db", "#1c1b18"],
    cossui: ["#e4e4e7", "#09090b"],
  };
  for (const t of THEMES) {
    themeColors[t.id] = [t.light.themeColor, t.dark.themeColor];
  }

  return `(function(){try{var d=document.documentElement,s=window.localStorage,C=${JSON.stringify(themeColors)},L=${JSON.stringify(LEGACY_THEME_MAP)},M={glass:1,clear:1,solid:1},K={pure:1,sky:1,wallpaper:1},S={auto:1,dawn:1,day:1,dusk:1,night:1},sys=!!(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches),mode="system",dark=sys,theme=${JSON.stringify(DEFAULT_THEME_ID)},mat="glass",canvas="sky",skyScene="auto",stat=false,accent=null,raw=null,p=null,i,m,c,v,k,hasOwn=Object.prototype.hasOwnProperty;function normHex(x){if(typeof x!=="string")return null;x=x.trim();if(/^#[0-9a-fA-F]{6}$/.test(x))return x.toLowerCase();if(/^#[0-9a-fA-F]{3}$/.test(x))return("#"+x[1]+x[1]+x[2]+x[2]+x[3]+x[3]).toLowerCase();return null}try{raw=s.getItem(${JSON.stringify(APPEARANCE_STORAGE_KEY)});if(raw)p=JSON.parse(raw)}catch(e){p=null}if(p&&p.v===2){mode=(p.mode==="dark"||p.mode==="light"||p.mode==="system")?p.mode:"system";dark=mode==="dark"?true:mode==="light"?false:sys;var pt=typeof p.theme==="string"?p.theme:"";var lt=String(p.theme||"").trim().toLowerCase();theme=hasOwn.call(C,pt)?pt:(hasOwn.call(L,lt)?L[lt]:${JSON.stringify(DEFAULT_THEME_ID)});mat=M[p.material]?p.material:"glass";canvas=(p.canvas&&K[p.canvas.kind])?p.canvas.kind:"sky";skyScene=(canvas==="sky"&&p.canvas&&S[p.canvas.scene])?p.canvas.scene:"auto";stat=!!p.staticBackground;accent=normHex(p.customAccent)}else{var rt=s.getItem("chisabot-theme");mode=rt==="dark"?"dark":rt==="light"?"light":"system";dark=mode==="dark"?true:mode==="light"?false:sys;var perf=s.getItem("chisabot.perf-mode")==="on";var rp=s.getItem("chisabot-theme-palette");var rf=(dark?s.getItem("chisabot-theme-family-dark"):s.getItem("chisabot-theme-family-light"))||(dark?s.getItem("chisabot-theme-family-light"):s.getItem("chisabot-theme-family-dark"))||rp||"";var lrf=rf.trim().toLowerCase();var mapped=hasOwn.call(L,lrf)?L[lrf]:null;if(mapped){theme=mapped}else if(rf){try{var cf=JSON.parse(s.getItem("chisabot-theme-families")||"[]");if(Array.isArray(cf)){for(i=0;i<cf.length;i++){if(cf[i]&&cf[i].id===rf){var sl=dark?cf[i].dark:cf[i].light;accent=normHex(sl&&sl.ac);break}}}}catch(e){}}var rg=s.getItem("chisabot-glass-style");mat=perf?"solid":(rg==="crystal"||rg==="liquid"?"clear":"glass");stat=perf;var rw=s.getItem("chisabot-wallpaper-id");var rs=s.getItem("chisabot-sky-source");var rh=s.getItem("chisabot-hark-scene");if(rw&&rw!=="none"){canvas="wallpaper"}else if(rs==="theme"||(!rs&&rp&&rp!=="default")||(!rs&&!rh&&s.getItem("chisabot-sky")==="off")){canvas="pure"}else{canvas="sky";skyScene=(!rh||rh==="auto"||rh==="live")?"auto":"day"}}d.classList.toggle("dark",dark);d.style.colorScheme=dark?"dark":"light";d.setAttribute("data-theme",theme);d.setAttribute("data-material",mat);d.setAttribute("data-canvas",canvas);if(stat)d.setAttribute("data-static-bg","on");else d.removeAttribute("data-static-bg");if(mat==="solid"&&stat)d.setAttribute("data-perf","on");else d.removeAttribute("data-perf");d.setAttribute("data-sky",canvas==="sky"&&!stat?(skyScene==="auto"?"live":"snapshot"):"off");if(accent){var derive=${deriveCustomAccentVars.toString()};v=derive(accent,dark);for(k in v)d.style.setProperty(k,v[k])}c=(C[theme]||C.sky)[dark?1:0];m=document.querySelectorAll('meta[name="theme-color"]');for(i=0;i<m.length;i++)m[i].setAttribute("content",c)}catch(e){}})();`;
}

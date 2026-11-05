/**
 * 液态玻璃（liquid）的边缘透镜与背景自适应（DESIGN.md §10.6）。
 *
 * 两件互补的事，都只对 html[data-glass="liquid"]（或不设 data-glass，liquid 是默认）生效：
 *
 * 1. 边缘透镜（rim lens）：给每个仍在跑 backdrop-filter 的玻璃面生成一张位移图
 *    （红 = 水平弯折、绿 = 垂直弯折、128 = 不动），灌进 svg <filter> 的 feImage +
 *    feDisplacementMap（红通道再放大 15%、蓝通道收 15%，三通道拆开 screen 叠回），
 *    最后把 url(#id) 追加到材质的 backdrop-filter 链尾（--lg-lens-url）。
 *    只有 Chromium 在 backdrop-filter 里画 url()；CSS.supports 不通过就只留 CSS 玻璃。
 *    位移图按 (尺寸, 圆角, 缘宽) 分桶缓存；图解码完成前不指给元素，免得少一帧模糊。
 *    短边 <32px、will-change / 自有合成层（菜单、动画面板）的面板跳过。
 *
 * 2. 背景自适应：把玻璃背后的背景（自定义壁纸 / WebGL 天空 / 天空渐变 + 薄幕）
 *    画进一张缩小 4 倍的离屏画布，对每个玻璃面取 5×3 采样网格——去掉最暗两个和最亮两个
 *    点后取均值得亮度，纹理 = 最亮点减最暗点，色度 = 平均通道饱和度。按亮度决定这块玻璃
 *    用浅釉深墨还是深釉浅墨（浅色模式下 ±0.05 迟滞防闪；深色模式恒浅墨），
 *    按密度公式推釉色浓淡，色度高时压低 saturate() 免得背景染色。
 *    两道保险防「整屏翻暗」：浅色档先按全屏光栅平均亮度一票否决（整体不暗就一律浅釉，
 *    压在暗角上的面板靠升密度保可读）；过闸后同一行的面板要过半共识才统一翻深釉。
 *    墨色写进 data-lg-ink 属性（样式表规则翻整套墨色令牌），密度 / 对比补偿 /
 *    保饱和写成行内数值变量；性能模式 / 减少透明度下撤掉全部行内值。
 *
 * 上半部分的纯函数被 tests/contrast-model.ts 与 tests/liquid-glass.test.ts 复用——
 * 对比度模型跑的就是这里同一份判定和求解，不是另一份近似。
 */

import { GLASS_SURFACE_SELECTOR } from "@/lib/appearance";

/* ------------------------------------------------------------------ *
 * 常量（与 styles.css「3.1 液态玻璃」一节一一对应，模型测试按这些算）。 *
 * ------------------------------------------------------------------ */

/** 位移图里「不动」的通道值。 */
export const LG_MAP_NEUTRAL = 128;
/** 缘宽 = min(44, 短边 / 3.5)，不小于 4px。 */
export const LG_RIM_MAX = 44;
export const LG_RIM_MIN = 4;
export const LG_RIM_DIV = 3.5;
/** 弯折幅度：1.1 × rim × (1 - d/rim)^2.6。 */
export const LG_BEND_GAIN = 1.1;
export const LG_BEND_EXP = 2.6;
/** 色彩分离：红通道多弯 15%，蓝通道少弯 15%。 */
export const LG_SPLIT_R = 1.15;
export const LG_SPLIT_B = 0.85;
/** 小于 32px 的面不上透镜。 */
export const LG_MIN_SIDE = 32;
/** 浅墨 / 深釉的分界与迟滞：浅色档采到 <0.40 才翻深釉，回到 ≥0.50 翻回浅釉。 */
export const LG_INK_LINE = 0.45;
export const LG_INK_HYST = 0.05;
/** 文字对比度目标（WCAG AA 正文）。 */
export const LG_AA_TARGET = 4.5;
/** 记住上一次浅色的墨，下次加载直接打开在它。 */
export const LG_INK_STORAGE_KEY = "chisabot-lg-ink";

export type RGBA = [number, number, number, number];

/** 浅色玻璃上的墨（黑 86% / 次色 70%，multiply）。 */
export const LG_INK_ON_LIGHT: RGBA = [0, 0, 0, 0.86];
/** 深玻璃上的墨（白 94% / 次色 64%，plus-lighter）。 */
export const LG_INK_ON_DARK: RGBA = [255, 255, 255, 0.94];
/**
 * 每档墨里「最淡的那级文字」的代理色：三级 / 副标题令牌比规范墨色淡
 * （浅色 --ink-3 #5f6673、深色 #8b97ab），升密度按它够到 4.5，正文就富余。
 */
export const LG_WORST_INK: Record<GlassInkState, RGBA> = {
  light: [0x5f, 0x66, 0x73, 1],
  dark: [0x8b, 0x97, 0xab, 1],
};

/* ------------------------------------------------------------------ *
 * 边缘透镜：缘宽、弯折曲线、位移图                                    *
 * ------------------------------------------------------------------ */

/** 缘宽（CSS px）：min(44, 短边 / 3.5)，不小于 4。 */
export function rimWidthPx(shortSide: number): number {
  if (!Number.isFinite(shortSide) || shortSide <= 0) return LG_RIM_MIN;
  return Math.max(LG_RIM_MIN, Math.min(LG_RIM_MAX, shortSide / LG_RIM_DIV));
}

/** 距边 d（向内为正）处的弯折量（px）；缘外为 0。 */
export function rimBend(d: number, rim: number): number {
  if (rim <= 0 || d <= 0 || d >= rim) return 0;
  return LG_BEND_GAIN * rim * (1 - d / rim) ** LG_BEND_EXP;
}

/** feDisplacementMap 的 scale = 2 × 最大弯折量。 */
export function displacementScale(rim: number): number {
  return 2 * LG_BEND_GAIN * rim;
}

/** 圆角矩形 SDF（外部为正、内部为负），CSS 普通 border-radius 用这条。 */
function sdRoundBox(
  px: number,
  py: number,
  hw: number,
  hh: number,
  r: number,
): number {
  const qx = Math.abs(px) - (hw - r);
  const qy = Math.abs(py) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * 生成一块玻璃的位移图（RGBA 字节）：R = 水平弯折、G = 垂直弯折、B 恒 128。
 * 只有缘带内弯（向心方向、rimBend 幅度），中间平坦。w/h 为元素 CSS 像素尺寸，
 * radius 为四角里最大的那个 CSS px 圆角；surface 用 superellipse() 时调用方应先
 * 换成等效圆角（本产品不用 corner-shape，恒走圆角矩形）。
 */
export function buildDisplacementMap(
  w: number,
  h: number,
  radius: number,
  rim: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const maxBend = Math.max(LG_BEND_GAIN * rim, 1e-6);
  const cx = w / 2;
  const cy = h / 2;
  const hw = w / 2;
  const hh = h / 2;
  const r = Math.min(radius, Math.min(hw, hh));
  const e = 0.75;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const px = x + 0.5 - cx;
      const py = y + 0.5 - cy;
      const d = -sdRoundBox(px, py, hw, hh, r);
      let red = LG_MAP_NEUTRAL;
      let green = LG_MAP_NEUTRAL;
      const mag = rimBend(d, rim);
      if (mag > 0) {
        const gx =
          sdRoundBox(px + e, py, hw, hh, r) - sdRoundBox(px - e, py, hw, hh, r);
        const gy =
          sdRoundBox(px, py + e, hw, hh, r) - sdRoundBox(px, py - e, hw, hh, r);
        const gl = Math.hypot(gx, gy) || 1;
        // 向内（向心）弯折：边缘处的画面取自缘内侧的场景。
        const ox = (-gx / gl) * mag;
        const oy = (-gy / gl) * mag;
        red = LG_MAP_NEUTRAL + (ox / maxBend) * 127;
        green = LG_MAP_NEUTRAL + (oy / maxBend) * 127;
      }
      out[i] = red;
      out[i + 1] = green;
      out[i + 2] = LG_MAP_NEUTRAL;
      out[i + 3] = 255;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 背景采样与材质判定                                                  *
 * ------------------------------------------------------------------ */

export interface BgStats {
  /** 0..1 亮度（去掉两个最暗、两个最亮点后取均值）。 */
  lum: number;
  /** 最亮点减最暗点（全部采样点）。 */
  texture: number;
  /** 平均通道饱和度 0..1。 */
  chroma: number;
}

/** 5×3 采样点的统计（点 = [r,g,b]，0..255）。 */
export function sampleStats(points: readonly RGBA[]): BgStats {
  if (points.length === 0) return { lum: 0.5, texture: 0, chroma: 0 };
  const lums = points.map(
    (c) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255,
  );
  const idx = lums.map((_, i) => i).sort((a, b) => lums[a] - lums[b]);
  const keep = idx.slice(2, Math.max(2, idx.length - 2));
  let r = 0;
  let g = 0;
  let b = 0;
  for (const i of keep) {
    r += points[i][0];
    g += points[i][1];
    b += points[i][2];
  }
  const n = keep.length;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / (255 * n);
  const texture = lums[idx[idx.length - 1]] - lums[idx[0]];
  let chroma = 0;
  for (const c of points) {
    chroma += (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])) / 255;
  }
  chroma /= points.length;
  return { lum, texture, chroma };
}

/**
 * 整屏光栅的平均亮度（隔 step 个像素抽样，weighted sRGB 与 sampleStats 同公式）。
 * 浅色档的全屏否决线：均值 ≥ LG_INK_LINE 就一块面板都不许翻深釉——半深半浅的壁纸
 * 整体是亮背景，不该把整个界面翻暗；面板压在局部暗角上靠升密度保证读得清。
 */
export function rasterMeanLum(data: Uint8ClampedArray, step = 16): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 2 < data.length; i += 4 * Math.max(1, step)) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    n++;
  }
  return n ? sum / (255 * n) : 0.5;
}

/** 墨的状态：'light' = 浅釉深墨（默认浅色档）；'dark' = 深釉浅墨（浅色压暗底 / 深色模式）。 */
export type GlassInkState = "light" | "dark";

/**
 * 浅色模式：背景亮度 < LG_INK_LINE − 迟滞才用深釉浅墨；亮度在分界线 ±迟滞 内保持上次的墨。
 * 深色模式恒浅墨。
 */
export function decideInk(
  scheme: "light" | "dark",
  lum: number,
  prev: GlassInkState | null,
): GlassInkState {
  if (scheme === "dark") return "dark";
  if (prev === "dark" && lum < LG_INK_LINE + LG_INK_HYST) return "dark";
  if (lum < LG_INK_LINE - LG_INK_HYST) return "dark";
  return "light";
}

/** 密度 0..1：0.55 × 背景与墨色亮度的接近度 + 0.7 × 纹理 + 0.3 × 色度。 */
export function densityOf(ink: GlassInkState, s: BgStats): number {
  const inkLum = ink === "dark" ? 1 : 0;
  const proximity = 1 - Math.abs(s.lum - inkLum);
  return Math.min(
    1,
    Math.max(0, 0.55 * proximity + 0.7 * s.texture + 0.3 * s.chroma),
  );
}

/** 密度 0..1 映射到釉色的浓淡系数（0.7 薄 – 1.3 浓，0.5 时≈1）。 */
export function densityKOf(density: number): number {
  return 0.7 + 0.6 * density;
}

/** 饱和度保留 = 1 - 0.75 × 色度，至少 0.45（高饱和背景不往玻璃里染色）。 */
export function satKeepOf(chroma: number): number {
  return Math.max(0.45, 1 - 0.75 * chroma);
}

export function over(top: RGBA, bottom: RGBA): RGBA {
  const a = top[3];
  return [
    top[0] * a + bottom[0] * (1 - a),
    top[1] * a + bottom[1] * (1 - a),
    top[2] * a + bottom[2] * (1 - a),
    1,
  ];
}

export function luminance(c: RGBA): number {
  const ch = (x: number) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
}

export function contrast(a: RGBA, b: RGBA): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** 内光层在顶上的合成玻璃色（浅态白内光 / 深态弱内光都在这一项里）。 */
export function glassComposite(tint: RGBA, hlAlpha: number, bg: RGBA): RGBA {
  return over([255, 255, 255, hlAlpha], over(tint, bg));
}

/**
 * 「升密度，不动墨色」：给定底色、釉色基色、内光强度和要用的墨，求让墨对比度
 * 达到 LG_AA_TARGET 的最小釉色 alpha。已经够就返回 base；怎么都够不着返回 max。
 * 浅色态（白釉 + 深墨）：alpha↑ → 底变亮 → 对比单调升；深态同理反向。二分求解。
 */
export function alphaForContrast(opts: {
  bg: RGBA;
  tintRGB: [number, number, number];
  hlAlpha: number;
  ink: GlassInkState;
  base: number;
  max?: number;
  target?: number;
  /** 求解用的墨（不传 = 该档规范墨色；产品上按 LG_WORST_INK 求，淡字也达标）。 */
  inkColor?: RGBA;
}): number {
  const max = opts.max ?? 0.85;
  const target = opts.target ?? LG_AA_TARGET;
  const inkColor: RGBA =
    opts.inkColor ?? (opts.ink === "dark" ? LG_INK_ON_DARK : LG_INK_ON_LIGHT);
  const comp = (a: number) =>
    glassComposite(
      [opts.tintRGB[0], opts.tintRGB[1], opts.tintRGB[2], a],
      opts.hlAlpha,
      opts.bg,
    );
  const ratio = (a: number) => {
    const c = comp(a);
    return contrast(over(inkColor, c), c);
  };
  if (ratio(opts.base) >= target) return opts.base;
  let lo = opts.base;
  let hi = max;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    if (ratio(mid) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

/* ================================================================== *
 * 下面是 DOM 安装器（浏览器里才跑）；纯函数到此为止。                  *
 * ================================================================== */

const LENS_SKIP_SELECTOR = [
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="context-menu-content"]',
  '[data-slot="select-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="combobox-content"]',
  '[data-slot="dialog-content"]',
  '[data-slot="sheet-content"]',
  ".glass-toast",
  ".model-popover",
  ".context-popover",
  ".perm-popover",
  ".bm-menu",
  ".chat-spotlight-panel",
  ".sg-savebar",
  "[data-lg-skip]",
].join(",");

const HTML_WATCHED_ATTRS = [
  "class",
  "data-glass",
  "data-perf",
  "data-resizing",
  "data-wallpaper",
  "data-palette",
  "data-theme",
  "data-sky-painted",
  "data-sky-off",
];

/** 玻璃面「背景重采样 / 透镜重建」的间隔下限。 */
const ADAPT_THROTTLE_MS = 160;
const RESCAN_DEBOUNCE_MS = 240;
const LIVE_SKY_RESAMPLE_MS = 12_000;

interface LensEntry {
  id: string;
  key: string;
  svg: SVGSVGElement;
}

function lensUrlSupported(): boolean {
  try {
    return (
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("backdrop-filter", "url(#a)")
    );
  } catch {
    return false;
  }
}

function liquidActive(): boolean {
  const glass = document.documentElement.getAttribute("data-glass");
  return glass === null || glass === "liquid";
}

function darkScheme(): boolean {
  return document.documentElement.classList.contains("dark");
}

function glassSuppressed(): boolean {
  if (document.documentElement.hasAttribute("data-perf")) return true;
  try {
    if (window.matchMedia("(prefers-reduced-transparency: reduce)").matches)
      return true;
  } catch {
    /* matchMedia 不可用时按不抑制处理 */
  }
  return false;
}

class LiquidGlass {
  private enabled = false;
  private destroyed = false;
  private seq = 0;
  private readonly lens = new Map<Element, LensEntry>();
  private readonly mapCache = new Map<string, Promise<string>>();
  private readonly lensRules = new Map<string, string>();
  private lensStyle: HTMLStyleElement | null = null;
  private svgHost: HTMLDivElement | null = null;
  private resizeObs: ResizeObserver | null = null;
  private mutationObs: MutationObserver | null = null;
  private htmlObs: MutationObserver | null = null;
  private rasterCanvas: HTMLCanvasElement | null = null;
  private rasterData: ImageData | null = null;
  private rasterScale = 4;
  private rasterDirty = true;
  private readonly lastInk = new Map<Element, GlassInkState>();
  private readonly wallpaperImg = new Map<string, HTMLImageElement>();
  private pendingRescan = 0;
  private pendingSample = 0;
  private liveSkyTimer = 0;
  private readonly onScroll = () => this.scheduleSample(false);

  start() {
    if (this.destroyed || this.enabled || typeof window === "undefined") return;
    this.enabled = true;
    // 「记住上次的墨」：浅色模式下上次是深釉，先给已存在的面板挂上深釉，第一次采样再纠正。
    try {
      if (
        !darkScheme() &&
        window.localStorage.getItem(LG_INK_STORAGE_KEY) === "dark"
      ) {
        for (const el of document.querySelectorAll(GLASS_SURFACE_SELECTOR)) {
          el.setAttribute("data-lg-ink", "dark");
        }
      }
    } catch {
      /* 存储不可用时跳过 */
    }
    this.htmlObs = new MutationObserver(() => this.refresh());
    this.htmlObs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: HTML_WATCHED_ATTRS,
    });
    this.mutationObs = new MutationObserver(() => this.scheduleRescan());
    this.mutationObs.observe(document.documentElement, {
      subtree: true,
      childList: true,
    });
    this.resizeObs = new ResizeObserver(() => this.refresh());
    this.resizeObs.observe(document.documentElement);
    window.addEventListener("scroll", this.onScroll, {
      passive: true,
      capture: true,
    });
    this.refresh();
  }

  stop() {
    this.destroyed = true;
    this.enabled = false;
    window.clearTimeout(this.pendingRescan);
    window.clearTimeout(this.pendingSample);
    window.clearInterval(this.liveSkyTimer);
    window.removeEventListener("scroll", this.onScroll, {
      capture: true,
    } as EventListenerOptions);
    this.htmlObs?.disconnect();
    this.mutationObs?.disconnect();
    this.resizeObs?.disconnect();
    for (const el of [...this.lens.keys()]) this.removeLens(el);
    this.clearAdapted();
    this.lensStyle?.remove();
    this.svgHost?.remove();
  }

  /** 属性 / 结构 / 尺寸有变化：重采样 + 重挂透镜（各自有节流）。 */
  private refresh() {
    this.rasterDirty = true;
    this.scheduleSample(true);
    this.scheduleRescan();
    this.armLiveSkyTimer();
  }

  private armLiveSkyTimer() {
    window.clearInterval(this.liveSkyTimer);
    this.liveSkyTimer = window.setInterval(() => {
      const gl = document.getElementById("gl");
      if (gl && document.documentElement.hasAttribute("data-sky-painted")) {
        this.rasterDirty = true;
        this.scheduleSample(true);
      }
    }, LIVE_SKY_RESAMPLE_MS);
  }

  private scheduleRescan() {
    if (this.pendingRescan || this.destroyed) return;
    this.pendingRescan = window.setTimeout(() => {
      this.pendingRescan = 0;
      this.rescan();
    }, RESCAN_DEBOUNCE_MS);
  }

  private scheduleSample(full: boolean) {
    if (this.pendingSample || this.destroyed) return;
    this.pendingSample = window.setTimeout(
      () => {
        this.pendingSample = 0;
        this.sample(full);
      },
      full ? ADAPT_THROTTLE_MS : ADAPT_THROTTLE_MS * 2,
    );
  }

  /** 透镜 + 自适应都挂在「此刻真正在跑 backdrop-filter」的元素上。 */
  private surfaces(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(GLASS_SURFACE_SELECTOR)];
  }

  /* ------------------------------ 透镜 ------------------------------ */

  private rescan() {
    if (this.destroyed) return;
    const canLens = liquidActive() && !glassSuppressed() && lensUrlSupported();
    for (const el of this.surfaces()) {
      if (canLens && this.eligible(el)) this.ensureLens(el);
      else this.removeLens(el);
    }
  }

  private eligible(el: HTMLElement): boolean {
    const rect = el.getBoundingClientRect();
    if (Math.min(rect.width, rect.height) < LG_MIN_SIDE) return false;
    const cs = getComputedStyle(el);
    // --lg-blur: none（渲染预算关掉的小元素 / 滚动区）上透镜自然缺席。
    if (cs.getPropertyValue("backdrop-filter") === "none") return false;
    // will-change / 变换 / 固定定位 / 弹层菜单：Chromium 会画出位移图而不是弯折后的背景。
    if (
      cs.willChange !== "auto" ||
      cs.transform !== "none" ||
      cs.filter !== "none"
    )
      return false;
    if (cs.position === "fixed" || cs.position === "sticky") return false;
    if (el.closest(LENS_SKIP_SELECTOR)) return false;
    return true;
  }

  private lensKey(el: HTMLElement): {
    key: string;
    w: number;
    h: number;
    rim: number;
  } {
    const rect = el.getBoundingClientRect();
    const w = Math.max(8, Math.round(rect.width / 8) * 8);
    const h = Math.max(8, Math.round(rect.height / 8) * 8);
    const cs = getComputedStyle(el);
    const radii = [
      cs.borderTopLeftRadius,
      cs.borderTopRightRadius,
      cs.borderBottomRightRadius,
      cs.borderBottomLeftRadius,
    ].map((v) => {
      const n = Number.parseFloat(v);
      return Number.isFinite(n) ? n : 0;
    });
    const radius = Math.min(Math.max(...radii, 0), Math.min(w, h) / 2);
    const rim = rimWidthPx(Math.min(w, h));
    return {
      key: `${w}x${h}r${Math.round(radius)}m${Math.round(rim)}`,
      w,
      h,
      rim,
    };
  }

  private mapFor(
    key: string,
    w: number,
    h: number,
    radius: number,
    rim: number,
  ): Promise<string> {
    const cached = this.mapCache.get(key);
    if (cached) return cached;
    const promise = (async () => {
      const data = buildDisplacementMap(w, h, radius, rim);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const imgData = new ImageData(w, h);
      imgData.data.set(data);
      canvas.getContext("2d")?.putImageData(imgData, 0, 0);
      const url = canvas.toDataURL("image/png");
      // 等图解码完再把元素指过去，不然第一帧按「没有模糊」画。
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
      } catch {
        /* 解码失败也照常：位移图是 PNG data URL，失败即退回无透镜 */
      }
      return url;
    })();
    this.mapCache.set(key, promise);
    if (this.mapCache.size > 32) {
      const first = this.mapCache.keys().next().value;
      if (first) this.mapCache.delete(first);
    }
    return promise;
  }

  private ensureLens(el: HTMLElement) {
    const { key, w, h, rim } = this.lensKey(el);
    const cs = getComputedStyle(el);
    const radius = Math.min(
      Math.max(
        Number.parseFloat(cs.borderTopLeftRadius) || 0,
        Number.parseFloat(cs.borderTopRightRadius) || 0,
        Number.parseFloat(cs.borderBottomRightRadius) || 0,
        Number.parseFloat(cs.borderBottomLeftRadius) || 0,
      ),
      Math.min(w, h) / 2,
    );
    const existing = this.lens.get(el);
    if (existing?.key === key) return;
    if (existing) this.removeLens(el);
    const id = `lgf${this.seq++}`;
    const scale = displacementScale(rim);
    void this.mapFor(key, w, h, radius, rim)
      .then((url) => {
        // 解码期间元素可能已挂过新透镜 / 被卸载：已有一条就不再叠第二个 svg。
        if (this.destroyed || this.lens.has(el)) return;
        const host = this.ensureSvgHost();
        const svg = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        svg.setAttribute("width", "0");
        svg.setAttribute("height", "0");
        svg.setAttribute("aria-hidden", "true");
        svg.style.position = "absolute";
        svg.innerHTML =
          `<filter id="${id}" filterUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}" color-interpolation-filters="sRGB">` +
          `<feImage href="${url}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="lgmap"/>` +
          `<feDisplacementMap in="SourceGraphic" in2="lgmap" scale="${(scale * LG_SPLIT_R).toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="dR"/>` +
          `<feColorMatrix in="dR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cR"/>` +
          `<feDisplacementMap in="SourceGraphic" in2="lgmap" scale="${scale.toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="dG"/>` +
          `<feColorMatrix in="dG" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="cG"/>` +
          `<feDisplacementMap in="SourceGraphic" in2="lgmap" scale="${(scale * LG_SPLIT_B).toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="dB"/>` +
          `<feColorMatrix in="dB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="cB"/>` +
          `<feBlend in="cR" in2="cG" mode="screen" result="rg"/>` +
          `<feBlend in="rg" in2="cB" mode="screen"/>` +
          `</filter>`;
        host.appendChild(svg);
        this.lens.set(el, { id, key, svg });
        this.lensRules.set(
          id,
          `[data-lg-lens="${id}"]{--lg-lens-url:url(#${id});}`,
        );
        this.rewriteLensStyle();
        el.setAttribute("data-lg-lens", id);
      })
      .catch(() => {
        /* 位移图构建失败（canvas 不可用等）：退回无透镜的 CSS 玻璃 */
      });
  }

  private removeLens(el: Element) {
    const entry = this.lens.get(el);
    el.removeAttribute("data-lg-lens");
    if (!entry) return;
    entry.svg.remove();
    this.lens.delete(el);
    this.lensRules.delete(entry.id);
    this.rewriteLensStyle();
  }

  private ensureSvgHost(): HTMLDivElement {
    if (!this.svgHost) {
      this.svgHost = document.createElement("div");
      this.svgHost.setAttribute("aria-hidden", "true");
      this.svgHost.style.cssText =
        "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
      document.body.appendChild(this.svgHost);
    }
    return this.svgHost;
  }

  private rewriteLensStyle() {
    if (!this.lensStyle) {
      this.lensStyle = document.createElement("style");
      this.lensStyle.id = "chisabot-lg-lens";
      document.head.appendChild(this.lensStyle);
    }
    this.lensStyle.textContent = [...this.lensRules.values()].join("\n");
  }

  /* ------------------------------ 自适应 ------------------------------ */

  private sample(_full: boolean) {
    if (this.destroyed) return;
    if (!liquidActive() || glassSuppressed()) {
      this.clearAdapted();
      return;
    }
    const els = this.surfaces().filter((el) => el.offsetParent !== null);
    if (els.length === 0) return;
    const raster = this.raster();
    const scheme = darkScheme() ? "dark" : "light";
    // 全屏否决：整体底色不算暗就不许任何面板翻深釉（半深半浅的壁纸不该把整屏翻暗）。
    const globalDark =
      scheme === "dark" ||
      (raster !== null && rasterMeanLum(raster.data) < LG_INK_LINE);
    // 同一行（中心 y 差 < 24px）的面板共享一次判定。
    const rows = new Map<number, GlassInkState[]>();
    const decided = new Map<Element, { stats: BgStats; ink: GlassInkState }>();
    for (const el of els) {
      const stats = raster ? this.sampleUnder(el, raster) : null;
      const prev = this.lastInk.get(el) ?? null;
      const lum = stats?.lum ?? 0.5;
      const ink = stats
        ? decideInk(scheme, lum, prev)
        : scheme === "dark"
          ? "dark"
          : "light";
      decided.set(el, {
        stats: stats ?? { lum: 0.5, texture: 0.4, chroma: 0.4 },
        ink,
      });
      const rowKey = Math.round(el.getBoundingClientRect().top / 24);
      const list = rows.get(rowKey) ?? [];
      list.push(ink);
      rows.set(rowKey, list);
    }
    let darkCount = 0;
    let lightCount = 0;
    for (const el of els) {
      const rowKey = Math.round(el.getBoundingClientRect().top / 24);
      const row = rows.get(rowKey) ?? [];
      const rowDark = row.filter((i) => i === "dark").length;
      const rowLight = row.length - rowDark;
      // 同一行共享一个判定：要过半共识才统一翻；两边都不过半保留这块面板自己的判定。
      let ink: GlassInkState;
      if (scheme === "dark") ink = "dark";
      else if (!globalDark) ink = "light";
      else if (rowDark * 2 > row.length) ink = "dark";
      else if (rowLight * 2 > row.length) ink = "light";
      else ink = decided.get(el)?.ink ?? "light";
      if (ink === "dark") darkCount++;
      else lightCount++;
      const decision = decided.get(el);
      if (decision) this.applyAdapt(el, ink, decision.stats, scheme);
      this.lastInk.set(el, ink);
    }
    // 记住浅色模式下多数面板的墨，下次加载直接打开在它。
    try {
      if (scheme === "light") {
        window.localStorage.setItem(
          LG_INK_STORAGE_KEY,
          darkCount > lightCount ? "dark" : "light",
        );
      }
    } catch {
      /* 存储不可用跳过 */
    }
  }

  private applyAdapt(
    el: HTMLElement,
    ink: GlassInkState,
    stats: BgStats,
    scheme: "light" | "dark",
  ) {
    if (ink === "dark" && scheme === "light")
      el.setAttribute("data-lg-ink", "dark");
    else el.removeAttribute("data-lg-ink");
    const density = densityOf(ink, stats);
    const densityK = densityKOf(density);
    const satKeep = satKeepOf(stats.chroma);
    // 「升密度不动墨色」：不够对比时把釉再压一档（aa-boost 乘进 --lg-tint-a）。
    const alpha = this.currentAlpha(el);
    const mul = scheme === "dark" ? 1.75 : ink === "dark" ? 1.4 : 1;
    const raw = alpha * mul * densityK;
    const bgColor = this.averageColor(el);
    const needed = alphaForContrast({
      bg: bgColor,
      tintRGB:
        scheme === "dark" || ink === "dark" ? [16, 18, 22] : [255, 255, 255],
      hlAlpha: scheme === "dark" ? 0.1 : ink === "dark" ? 0.08 : 0.3,
      ink,
      base: raw,
      // 深釉档的 clamp 上限放到 0.95（--lg-tint-hi），边界亮度也能升密度升到 4.5。
      max: scheme === "dark" ? 0.9 : ink === "dark" ? 0.95 : 0.85,
      inkColor: LG_WORST_INK[ink],
    });
    const boost = raw > 0 ? Math.min(4, needed / raw) : 1;
    el.style.setProperty("--lg-density-k", densityK.toFixed(3));
    el.style.setProperty("--lg-aa-boost", boost.toFixed(3));
    el.style.setProperty("--lg-sat-keep", satKeep.toFixed(3));
  }

  /** 元素当前的 --lg-alpha 计算值（滑块实时值），行内数值变量以它为底。 */
  private currentAlpha(el: HTMLElement): number {
    const v = Number.parseFloat(
      getComputedStyle(el).getPropertyValue("--lg-alpha"),
    );
    return Number.isFinite(v) ? v : 0.16;
  }

  private averageColor(el: HTMLElement): RGBA {
    const raster = this.raster();
    if (!raster) return darkScheme() ? [10, 14, 24, 1] : [180, 200, 225, 1];
    // 平均色不逐点平均，用中心点近似（底色变化平缓时误差可忽略）。
    const rect = el.getBoundingClientRect();
    const x = Math.min(
      raster.width - 1,
      Math.max(0, Math.round((rect.left + rect.width / 2) / this.rasterScale)),
    );
    const y = Math.min(
      raster.height - 1,
      Math.max(0, Math.round((rect.top + rect.height / 2) / this.rasterScale)),
    );
    const i = (y * raster.width + x) * 4;
    return [raster.data[i], raster.data[i + 1], raster.data[i + 2], 1];
  }

  private clearAdapted() {
    for (const el of document.querySelectorAll<HTMLElement>(
      `${GLASS_SURFACE_SELECTOR}, [data-lg-ink]`,
    )) {
      el.removeAttribute("data-lg-ink");
      el.style.removeProperty("--lg-density-k");
      el.style.removeProperty("--lg-aa-boost");
      el.style.removeProperty("--lg-sat-keep");
    }
    this.lastInk.clear();
  }

  /* --------------------------- 背景光栅 --------------------------- */

  private raster(): ImageData | null {
    if (!this.rasterDirty && this.rasterData) return this.rasterData;
    this.rasterData = this.buildRaster();
    this.rasterDirty = false;
    return this.rasterData;
  }

  private buildRaster(): ImageData | null {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (vw < 2 || vh < 2) return null;
    const scale = this.rasterScale;
    const cw = Math.max(2, Math.round(vw / scale));
    const ch = Math.max(2, Math.round(vh / scale));
    if (!this.rasterCanvas)
      this.rasterCanvas = document.createElement("canvas");
    const canvas = this.rasterCanvas;
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.setTransform(1 / scale, 0, 0, 1 / scale, 0, 0);
    const dark = darkScheme();
    if (!this.drawWallpaper(ctx, vw, vh, dark)) {
      if (!this.drawSky(ctx, vw, vh))
        this.drawSkyPlaceholder(ctx, vw, vh, dark);
      this.drawOrbs(ctx, vw, vh, dark);
    }
    this.drawVeil(ctx, vw, vh, dark);
    try {
      return ctx.getImageData(0, 0, cw, ch);
    } catch {
      return null;
    }
  }

  /** 自定义 / 预设壁纸：封面裁图画 + 压暗遮罩 + 薄幕。读不了（跨域 / 未载）返回 false。 */
  private drawWallpaper(
    ctx: CanvasRenderingContext2D,
    vw: number,
    vh: number,
    dark: boolean,
  ): boolean {
    const layer = document.querySelector<HTMLElement>(
      ".chisabot-wallpaper-img",
    );
    if (!layer) return false;
    const bg = getComputedStyle(layer).backgroundImage;
    const url = /^url\((['"]?)(.*)\1\)$/.exec(bg)?.[2];
    if (!url) return false;
    let img = this.wallpaperImg.get(url);
    if (!img) {
      img = new Image();
      if (/^https?:/i.test(url)) img.crossOrigin = "anonymous";
      img.src = url;
      this.wallpaperImg.set(url, img);
      // 载完 / 失败都重采一次。
      img.onload = () => this.refresh();
      img.onerror = () => {
        this.wallpaperImg.delete(url);
        this.refresh();
      };
    }
    if (!img.complete || img.naturalWidth === 0) return false;
    drawCover(ctx, img, 0, 0, vw, vh);
    // 压暗遮罩（radial at 50% 45%，与 styles.css .chisabot-wallpaper-dim 同两色标）。
    const dimEl = document.querySelector<HTMLElement>(
      ".chisabot-wallpaper-dim",
    );
    const dimOpacity = dimEl
      ? Number.parseFloat(getComputedStyle(dimEl).opacity) || 0
      : 0;
    if (dimOpacity > 0) {
      const g = ctx.createRadialGradient(
        vw * 0.5,
        vh * 0.45,
        0,
        vw * 0.5,
        vh * 0.45,
        Math.max(vw, vh) * 0.75,
      );
      if (dark) {
        g.addColorStop(0, `rgba(6, 10, 22, ${(0.42 * dimOpacity).toFixed(3)})`);
        g.addColorStop(1, `rgba(4, 8, 18, ${(0.72 * dimOpacity).toFixed(3)})`);
      } else {
        g.addColorStop(
          0,
          `rgba(244, 248, 255, ${(0.46 * dimOpacity).toFixed(3)})`,
        );
        g.addColorStop(
          1,
          `rgba(228, 238, 252, ${(0.58 * dimOpacity).toFixed(3)})`,
        );
      }
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, vw, vh);
    }
    // 壁纸薄幕 .chisabot-wallpaper::after（--wallpaper-scrim）。
    const scrim = getComputedStyle(document.documentElement)
      .getPropertyValue("--wallpaper-scrim")
      .trim();
    if (scrim) {
      ctx.fillStyle = scrim;
      ctx.fillRect(0, 0, vw, vh);
    }
    return true;
  }

  /** WebGL 天空画布（#gl）直接拷；读不了（缓冲被清 / 未上屏）返回 false。 */
  private drawSky(
    ctx: CanvasRenderingContext2D,
    vw: number,
    vh: number,
  ): boolean {
    const gl = document.getElementById("gl") as HTMLCanvasElement | null;
    if (
      !gl ||
      !document.documentElement.hasAttribute("data-sky-painted") ||
      document.documentElement.hasAttribute("data-sky-off")
    ) {
      return false;
    }
    try {
      ctx.drawImage(gl, 0, 0, vw, vh);
      const px = ctx.getImageData(
        Math.floor(ctx.canvas.width / 2),
        Math.floor(ctx.canvas.height / 2),
        1,
        1,
      ).data;
      // 全透明说明 WebGL 缓冲不可读，退回占位渐变。
      return px[3] > 8;
    } catch {
      return false;
    }
  }

  /** 天空兜底：#skyph 的计算渐变（默认蓝天 / 主题渐变都由它给）。 */
  private drawSkyPlaceholder(
    ctx: CanvasRenderingContext2D,
    vw: number,
    vh: number,
    _dark: boolean,
  ): void {
    const ph = document.getElementById("skyph");
    const bg = ph ? getComputedStyle(ph).backgroundImage : "";
    const stops = parseLinearGradient(bg);
    const g = ctx.createLinearGradient(0, 0, 0, vh);
    for (const s of stops) g.addColorStop(s.at, s.color);
    ctx.fillStyle = stops.length ? g : darkScheme() ? "#12203a" : "#9dbddc";
    ctx.fillRect(0, 0, vw, vh);
  }

  /** 环境流光球（styles.css .chisabot-ambient-orbs 的三团径向柔光，近似画）。 */
  private drawOrbs(
    ctx: CanvasRenderingContext2D,
    vw: number,
    vh: number,
    dark: boolean,
  ) {
    const orbs = dark
      ? ([
          [0.2, 0.24, 0.34, "rgba(56, 189, 248, 0.14)"],
          [0.8, 0.3, 0.38, "rgba(129, 140, 248, 0.14)"],
          [0.48, 0.8, 0.36, "rgba(45, 212, 191, 0.1)"],
        ] as const)
      : ([
          [0.18, 0.22, 0.31, "rgba(255, 255, 255, 0.36)"],
          [0.82, 0.28, 0.37, "rgba(186, 230, 253, 0.34)"],
          [0.52, 0.78, 0.34, "rgba(255, 255, 255, 0.26)"],
        ] as const);
    for (const [fx, fy, fr, color] of orbs) {
      const r = Math.max(vw, vh) * fr;
      const g = ctx.createRadialGradient(
        vw * fx,
        vh * fy,
        0,
        vw * fx,
        vh * fy,
        r,
      );
      g.addColorStop(0, color);
      g.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, vw, vh);
    }
  }

  /** 天幕薄纱 #sky-root::after（浅色提亮 / 深色压暗的线性渐变）。 */
  private drawVeil(
    ctx: CanvasRenderingContext2D,
    vw: number,
    vh: number,
    dark: boolean,
  ) {
    const g = ctx.createLinearGradient(0, 0, 0, vh);
    if (dark) {
      g.addColorStop(0, "rgba(5, 9, 18, 0.5)");
      g.addColorStop(0.55, "rgba(7, 12, 24, 0.58)");
      g.addColorStop(1, "rgba(9, 15, 28, 0.66)");
    } else {
      g.addColorStop(0, "rgba(220, 237, 255, 0.44)");
      g.addColorStop(0.52, "rgba(232, 244, 255, 0.38)");
      g.addColorStop(1, "rgba(244, 250, 255, 0.34)");
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, vw, vh);
  }

  /** 元素下的 5×3 采样网格 → 亮度 / 纹理 / 色度。 */
  private sampleUnder(el: HTMLElement, raster: ImageData): BgStats {
    const rect = el.getBoundingClientRect();
    const xs = [0.08, 0.28, 0.5, 0.72, 0.92];
    const ys = [0.18, 0.5, 0.82];
    const pts: RGBA[] = [];
    for (const fy of ys) {
      for (const fx of xs) {
        const x = Math.min(
          raster.width - 1,
          Math.max(
            0,
            Math.round((rect.left + rect.width * fx) / this.rasterScale),
          ),
        );
        const y = Math.min(
          raster.height - 1,
          Math.max(
            0,
            Math.round((rect.top + rect.height * fy) / this.rasterScale),
          ),
        );
        const i = (y * raster.width + x) * 4;
        pts.push([raster.data[i], raster.data[i + 1], raster.data[i + 2], 1]);
      }
    }
    return sampleStats(pts);
  }
}

/* ------------------------------ 工具 ------------------------------ */

function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih) return;
  const s = Math.max(w / iw, h / ih);
  const sw = w / s;
  const sh = h / s;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

/** getComputedStyle().backgroundImage 的 linear-gradient(...) → 色标列表。 */
function parseLinearGradient(bg: string): { at: number; color: string }[] {
  const m = /^linear-gradient\((.*)\)$/s.exec(bg.trim());
  if (!m) return [];
  const body = m[1];
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  const stops: { at: number; color: string }[] = [];
  for (const raw of parts.slice(1)) {
    const mm = /^(.*?)\s+([\d.]+)%$/.exec(raw);
    if (mm) stops.push({ at: Number(mm[2]) / 100, color: mm[1] });
    else
      stops.push({
        at: stops.length ? stops[stops.length - 1].at : 0,
        color: raw,
      });
  }
  return stops;
}

/** 安装入口：SkyBackground 挂载时调一次（返回解绑函数）。 */
export function installLiquidGlass(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  const inst = new LiquidGlass();
  inst.start();
  return () => inst.stop();
}

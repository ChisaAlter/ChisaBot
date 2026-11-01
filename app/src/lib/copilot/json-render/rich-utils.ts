// biome-ignore-all lint/style/noNonNullAssertion: indexes are bounded by the loop / length checks right above each access.
/**
 * 富组件（DESIGN.md §32）用到的纯函数：数字解析 / 格式化、SVG 路径、相对时间、倒计时、链接与配色。
 * 不依赖 React，也不碰 DOM，所以单元测试直接测（app/tests/json-render-rich.test.ts）。
 */

/** "81,272" / "$81,272.5" / "-3.1%" / 42 → 数字；读不出来 → null。 */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const m = value.replace(/[\s\u00a0]/g, "").replace(/−/g, "-").match(/[+-]?\d[\d,]*(?:\.\d+)?|[+-]?\.\d+/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** 数列 → 数字数组（读不出来的点变成 null，保留位置）。 */
export function toSeries(values: unknown): (number | null)[] {
  return Array.isArray(values) ? values.map((v) => (v === null || v === undefined || v === "" ? null : toNumber(v))) : [];
}

export type ParsedNumeric = { prefix: string; value: number; decimals: number; grouped: boolean; suffix: string; plus?: boolean; minus?: string };

/**
 * 把一个显示用的数值拆成「前缀 + 数字 + 后缀」，好在刷新时只滚动数字部分：
 * "$81,272" → { prefix: "$", value: 81272, grouped: true }；"26.9℃" → { value: 26.9, decimals: 1, suffix: "℃" }。
 * 里面有两个数（"31°/24°"、"10/13"）或者根本没有数字时返回 null（这种值只闪一下，不滚动）。
 */
export function parseNumeric(value: unknown): ParsedNumeric | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const decimals = (String(value).split(".")[1] ?? "").length;
    return { prefix: "", value, decimals: Math.min(decimals, 6), grouped: false, suffix: "" };
  }
  if (typeof value !== "string") return null;
  const m = value.match(/^(\D*?)([+\-−]?)(\d[\d,]*)(?:\.(\d+))?(\D*)$/u);
  if (!m) return null;
  const [, prefix = "", sign = "", whole = "", fraction = "", suffix = ""] = m;
  // "1,2,3" 这种不是千分位的写法不滚动。
  if (whole.includes(",") && !/^\d{1,3}(,\d{3})+$/.test(whole)) return null;
  const n = Number(`${sign === "−" ? "-" : sign}${whole.replace(/,/g, "")}${fraction ? `.${fraction}` : ""}`);
  if (!Number.isFinite(n)) return null;
  return { prefix, value: n, decimals: fraction.length, grouped: whole.includes(","), suffix, plus: sign === "+", minus: sign === "−" ? "−" : "-" };
}

/** 按 parsed 的样子把数字写回去（同样的小数位、千分位、前后缀）。 */
export function formatLike(n: number, like: ParsedNumeric): string {
  const fixed = Math.abs(n).toFixed(like.decimals);
  const [int = "0", frac] = fixed.split(".");
  const body = like.grouped ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : int;
  const sign = n < 0 && Number(fixed) !== 0 ? (like.minus ?? "-") : like.plus && n > 0 ? "+" : "";
  return `${like.prefix}${sign}${body}${frac !== undefined ? `.${frac}` : ""}${like.suffix}`;
}

/** 两个值能不能平滑滚动：前后缀、小数位都一样，只有数字变了。 */
export function canTween(from: ParsedNumeric | null, to: ParsedNumeric | null): boolean {
  return Boolean(from && to && from.prefix === to.prefix && from.suffix === to.suffix && from.value !== to.value);
}

/** 缓动：先快后慢。 */
export const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** 显示用的短数字：12,345 → 1.2万；0.000123 保留有效位。悬停提示和坐标轴用。 */
export function shortNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${trim(n / 1e8)}亿`;
  if (abs >= 1e6) return `${trim(n / 1e4, 0)}万`;
  if (abs >= 100) return Math.round(n).toLocaleString("en-US");
  if (abs >= 1) return trim(n, 2);
  if (abs === 0) return "0";
  return Number(n.toPrecision(3)).toString();
}
function trim(n: number, digits = 1): string {
  return Number(n.toFixed(digits)).toString();
}

export type Point = { x: number; y: number };

/**
 * 单调三次样条（Fritsch–Carlson）：曲线经过每个点，而且不会在两点之间冲过头（价格不会画出不存在的尖）。
 * 点按 x 递增；少于 2 个点返回空串。
 */
export function monotonePath(points: Point[]): string {
  const n = points.length;
  if (n === 0) return "";
  const f = (v: number) => Number(v.toFixed(2));
  if (n === 1) return `M${f(points[0]!.x)},${f(points[0]!.y)}`;
  if (n === 2) return `M${f(points[0]!.x)},${f(points[0]!.y)}L${f(points[1]!.x)},${f(points[1]!.y)}`;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    dx.push(b.x - a.x);
    slope.push(b.x === a.x ? 0 : (b.y - a.y) / (b.x - a.x));
  }
  const tangent: number[] = [slope[0]!];
  for (let i = 1; i < n - 1; i++) {
    const s0 = slope[i - 1]!;
    const s1 = slope[i]!;
    tangent.push(s0 * s1 <= 0 ? 0 : (3 * (dx[i - 1]! + dx[i]!)) / ((2 * dx[i]! + dx[i - 1]!) / s0 + (dx[i]! + 2 * dx[i - 1]!) / s1));
  }
  tangent.push(slope[n - 2]!);
  let d = `M${f(points[0]!.x)},${f(points[0]!.y)}`;
  for (let i = 0; i < n - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const h = dx[i]! / 3;
    d += `C${f(a.x + h)},${f(a.y + tangent[i]! * h)} ${f(b.x - h)},${f(b.y - tangent[i + 1]! * h)} ${f(b.x)},${f(b.y)}`;
  }
  return d;
}

/**
 * 把数列放进 width × height 的画布（上下留 pad）。null 点跳过（线在那里断开）。
 * 返回每一段连续的点，和所用的上下限。
 */
export function layoutSeries(
  series: (number | null)[][],
  width: number,
  height: number,
  pad = 4,
  floor?: number | null,
): { segments: Point[][][]; min: number; max: number; x: (i: number) => number; y: (v: number) => number } {
  const all = series.flat().filter((v): v is number => v !== null);
  let min = all.length ? Math.min(...all) : 0;
  let max = all.length ? Math.max(...all) : 1;
  if (floor !== undefined && floor !== null) min = Math.min(min, floor);
  if (min === max) {
    const bump = Math.abs(min) * 0.05 || 1;
    min -= bump;
    max += bump;
  }
  const count = Math.max(...series.map((s) => s.length), 1);
  const x = (i: number) => (count === 1 ? width / 2 : (i / (count - 1)) * width);
  const y = (v: number) => pad + (1 - (v - min) / (max - min)) * (height - pad * 2);
  const segments = series.map((s) => {
    const parts: Point[][] = [];
    let current: Point[] = [];
    s.forEach((v, i) => {
      if (v === null) {
        if (current.length) parts.push(current);
        current = [];
      } else current.push({ x: x(i), y: y(v) });
    });
    if (current.length) parts.push(current);
    return parts;
  });
  return { segments, min, max, x, y };
}

/** 首尾比较：涨 / 跌 / 平。 */
export function seriesTrend(values: (number | null)[]): "up" | "down" | "flat" {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return "flat";
  const diff = nums[nums.length - 1]! - nums[0]!;
  if (Math.abs(diff) < 1e-12) return "flat";
  return diff > 0 ? "up" : "down";
}

/** "+3.2%" → up，"-120" / "−5" → down，"0" → flat。 */
export function trendOfText(value: unknown): "up" | "down" | "flat" {
  const text = String(value ?? "").trim();
  if (/^[+▲↑]/.test(text)) return "up";
  if (/^[-−▼↓]/.test(text)) return "down";
  const n = toNumber(text);
  if (n === null || n === 0) return "flat";
  return n > 0 ? "up" : "down";
}

/** 相对时间：「刚刚」「3 分钟前」「2 小时后」「10/13」。 */
export function relativeTime(iso: string | number | Date, now = Date.now()): string {
  const t = iso instanceof Date ? iso.getTime() : typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return typeof iso === "string" ? iso : "";
  const diff = (now - t) / 1000;
  const future = diff < 0;
  const s = Math.abs(diff);
  const say = (n: number, unit: string) => `${n} ${unit}${future ? "后" : "前"}`;
  if (s < 45) return future ? "马上" : "刚刚";
  if (s < 3600) return say(Math.max(1, Math.round(s / 60)), "分钟");
  if (s < 86_400) return say(Math.round(s / 3600), "小时");
  if (s < 7 * 86_400) return say(Math.round(s / 86_400), "天");
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return sameYear ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 列表 / 时间线里的时间：过去的写相对时间（「3 分钟前」）；将来的（模型把时区写错、或者本来就是日程）写绝对时间
 * 「今天 20:00」「10/14 09:00」，免得新闻显示成「10 小时后」。
 */
export function itemTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  if (t - now <= 5 * 60_000) return relativeTime(t, now);
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  const same = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return same ? `今天 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 相对时间多久需要重算一次（毫秒）：一分钟内每 15 秒，一小时内每分钟，其余每 10 分钟。 */
export function relativeTick(iso: string | number | Date, now = Date.now()): number {
  const t = iso instanceof Date ? iso.getTime() : typeof iso === "number" ? iso : Date.parse(iso);
  const s = Math.abs(now - t) / 1000;
  if (!Number.isFinite(s)) return 600_000;
  if (s < 90) return 15_000;
  if (s < 3600) return 60_000;
  return 600_000;
}

export type CountdownParts = { done: boolean; days: number; hours: number; minutes: number; seconds: number; total: number };

export function countdownParts(target: string | number, now = Date.now()): CountdownParts | null {
  const t = typeof target === "number" ? target : Date.parse(target);
  if (!Number.isFinite(t)) return null;
  const total = Math.max(0, Math.floor((t - now) / 1000));
  return {
    done: total === 0,
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
    total,
  };
}

/** 只放行 http(s)；其余（javascript:、data:、相对地址）返回 null。 */
export function safeHttp(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    return new URL(trimmed).toString();
  } catch {
    return null;
  }
}
/** 图片只认 https（与目录校验一致）。 */
export function safeHttps(url: unknown): string | null {
  const ok = safeHttp(url);
  return ok && /^https:/i.test(ok) ? ok : null;
}

/** 链接的域名（去掉 www.）。 */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

const CJK_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3005\u3006]/u;
/** 字母、数字（含组合附加符号）；标点 \p{P}、符号 \p{S}、emoji \p{Extended_Pictographic}、空白都不算。 */
const WORD_CHAR = /[\p{L}\p{N}]/u;
const MARK = /\p{M}/u;
/** 一个词的第一个字（带上跟在后面的组合附加符号，「é」拆成 e + ◌́ 时也完整）。 */
const firstGrapheme = (word: string) => word.match(/^\P{M}\p{M}*/u)?.[0] ?? "";

/**
 * 名字的首字（Avatar / List 图位 / Products 共用）：中日韩取第一个字，其他取前两个单词的首字母。
 * 按码点处理（Array.from），不会切出半个 emoji；开头的标点、符号、emoji 跳过（「🎧 降噪耳机」→「降」，
 * 「【推荐】小米」→「推」）。名字为空或全是符号时返回空串，调用方画中性占位图标（不画「?」）。
 */
export function initials(name: string): string {
  const chars = Array.from(typeof name === "string" ? name : "");
  const start = chars.findIndex((ch) => WORD_CHAR.test(ch));
  if (start < 0) return "";
  const rest = chars.slice(start);
  if (CJK_START.test(rest[0] ?? "")) return rest[0] ?? "";
  const words: string[] = [];
  let current = "";
  for (const ch of rest) {
    if (WORD_CHAR.test(ch) || (current && MARK.test(ch))) current += ch;
    else {
      // 标点、符号、emoji（及其 ZWJ / 变体选择符）、空白：都当分隔。
      if (current) words.push(current);
      current = "";
    }
  }
  if (current) words.push(current);
  const firstWord = words[0] ?? "";
  const first = firstGrapheme(firstWord);
  // 第二个字母：第一个词以数字开头且后面紧跟字母（「1More」「3M」）时取这个字母（→「1M」），
  // 否则取第二个词的首字母；第二个词是中日韩（「Apple 苹果」）时不拼，避免「A苹」。
  const afterDigit = DIGIT.test(first) ? firstGrapheme(firstWord.slice(first.length)) : "";
  const secondChar = afterDigit && LETTER.test(afterDigit) ? afterDigit : firstGrapheme(words[1] ?? "");
  const second = secondChar && !CJK_START.test(secondChar) ? secondChar : "";
  return upperOne(first) + upperOne(second);
}

const DIGIT = /^\p{N}/u;
const LETTER = /^\p{L}/u;
/** 逐字大写，且保持一个字一个字：toLocaleUpperCase 会把「ß」展开成「SS」，这种就保留原字。 */
function upperOne(grapheme: string): string {
  const upper = grapheme.toLocaleUpperCase();
  return Array.from(upper).length === Array.from(grapheme).length ? upper : grapheme;
}

/** 名字 → 稳定的色相（头像底色），同一个名字永远同一个颜色。 */
export function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return h;
}

/** 热力格的深浅等级 0–4（0 = 没有 / 0 值）。 */
export function heatLevel(value: number | null, max: number): number {
  if (value === null || value <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
}

/** 横轴标签抽样：最多 maxLabels 个，首尾一定在。 */
export function sampleLabels(count: number, maxLabels: number): number[] {
  if (count <= 0) return [];
  if (count <= maxLabels) return Array.from({ length: count }, (_, i) => i);
  const step = (count - 1) / (maxLabels - 1);
  return Array.from({ length: maxLabels }, (_, i) => Math.round(i * step));
}

/** 环形图：每段的起止（0–1）。value ≤ 0 的段跳过。 */
export function ringSegments(values: number[]): { start: number; end: number; index: number }[] {
  const total = values.reduce((a, v) => a + Math.max(0, v), 0);
  if (total <= 0) return [];
  let at = 0;
  const out: { start: number; end: number; index: number }[] = [];
  values.forEach((v, index) => {
    if (v <= 0) return;
    const share = v / total;
    out.push({ start: at, end: at + share, index });
    at += share;
  });
  return out;
}

/** 仪表的颜色：过了 dangerAt 红，过了 warnAt 黄，否则用给定 tone。 */
export function gaugeTone(value: number, warnAt: number | null | undefined, dangerAt: number | null | undefined, fallback: string): string {
  if (dangerAt !== null && dangerAt !== undefined && value >= dangerAt) return "danger";
  if (warnAt !== null && warnAt !== undefined && value >= warnAt) return "warn";
  return fallback;
}

/**
 * 「当前降水 0 mm · 风速 5.4 km/h」拆成几项（DESIGN.md §77.3）：每项不拆开换行，只在「·」处换。
 * 只有一项时返回 null（照常排）。
 */
export function splitDotted(text: string): string[] | null {
  if (!text.includes("·")) return null;
  const parts = text.split(/\s*·\s*/u).filter((part) => part.length > 0);
  return parts.length > 1 ? parts : null;
}

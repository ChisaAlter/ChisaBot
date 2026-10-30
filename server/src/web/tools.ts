import { z } from "zod";
import { BlockedUrlError, guardedFetch, resolvePublic } from "../../../shared/net/guarded-fetch";
import { checkPublicUrl } from "../../../shared/net/ssrf";
import { currentConfirmTurn, currentToolAbort, TOOL_STOPPED_ZH } from "../confirmations/context";
import { REFUSAL_MARKER, type GrantedTool } from "../plugins/tools";
import { markUntrusted } from "../untrusted-content";

/**
 * 内置联网：`web_search` + `web_fetch`（2026-10-13，向 Hark 的体验看齐）。
 *
 * 以前机器人查任何东西都只能开浏览器：慢（每一步一个回合）、贵（截图、快照），面板刷新这种后台任务
 * 更是没有浏览器可用就什么也查不到。现在先搜、再读网页 / 接口，只有需要点击、登录、填表或给用户看
 * 页面时才用浏览器。两个工具都只读、不带用户的身份、只访问公网地址（拒绝内网 / 本机，防 SSRF）。
 *
 * 搜索用 DuckDuckGo 的 HTML 版（不需要密钥）；拿不到结果时退回 Bing。结果和网页内容都按外部内容
 * 包进 untrusted 信封。
 */

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 ChisaBot/0.1";
const MAX_BYTES = 2_000_000;
const MAX_TEXT = 12_000;

/**
 * 只放行公网 http(s)；内网 / 本机 / 元数据 / 映射写法一律拒绝。
 * 实现走 shared/net（与链接预览同一套），不再维护本地弱副本（CR-P0-01 / CR-P1-01）。
 * 真正下载请用 {@link guardedFetch}（DNS 钉死 + 逐跳重定向），本函数只做「能不能连」的前置检查
 *（vault / media-models 在自带 fetch 前调用）。
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const verdict = checkPublicUrl(raw);
  if (!verdict.ok) throw new Error(verdict.reason);
  await resolvePublic(verdict.url.hostname);
  return verdict.url;
}

async function fetchPublic(raw: string, signal?: AbortSignal, accept = "text/html,application/json;q=0.9,*/*;q=0.8", userAgent = UA, timeoutMs = 20_000) {
  try {
    const response = await guardedFetch(raw, {
      maxBytes: MAX_BYTES,
      timeoutMs,
      maxRedirects: 4,
      headers: { "user-agent": userAgent, accept, "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" },
      ...(signal ? { signal } : {}),
    });
    const body = new TextDecoder("utf-8", { fatal: false }).decode(response.body);
    return { url: response.url, status: response.status, contentType: response.contentType, body };
  } catch (error) {
    if (error instanceof BlockedUrlError) throw new Error(error.message);
    throw error;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z#0-9]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** 粗略的 HTML → 可读文字：去掉脚本 / 样式 / 导航，保留标题、段落、列表、表格的换行和链接文字。 */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "").replace(/\s+/g, " ");
  let body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  body = body
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(nav|footer)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|table|ul|ol|header|blockquote|pre)>/gi, "\n")
    .replace(/<(td|th)[^>]*>/gi, " | ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n${"#".repeat(Number(n))} `)
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line, i, all) => line || (all[i - 1] ?? "") !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

export type SearchHit = { title: string; url: string; snippet: string };

export function parseDuckDuckGo(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.split(/<div class="result results_links/).slice(1);
  for (const block of blocks) {
    const a = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    let href = decodeEntities(a[1] ?? "");
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1] ?? "");
    if (href.startsWith("//")) href = `https:${href}`;
    if (/duckduckgo\.com\/y\.js/.test(href)) continue; // 广告
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? "";
    hits.push({
      title: decodeEntities((a[2] ?? "").replace(/<[^>]+>/g, "")).trim(),
      url: href,
      snippet: decodeEntities(snippet.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
    });
  }
  return hits;
}

/**
 * Bing 的结果链接是 `bing.com/ck/a?...&u=a1<base64url>` 跳转（2026-10-29 线上实测，全部如此），真实地址藏在
 * `u` 里。不还原的话，模型看到的每条来源都是 bing.com，既没法注明来源网站，也没法分辨是不是同一家。
 */
export function unwrapBingUrl(href: string): string {
  try {
    const url = new URL(href);
    if (!/(^|\.)bing\.com$/i.test(url.hostname) || url.pathname !== "/ck/a") return href;
    const u = url.searchParams.get("u");
    if (!u?.startsWith("a1")) return href;
    const real = Buffer.from(u.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    // 解出来的地址若指向内网 / 本机，就留着原来的 Bing 链接：不把这种地址当来源交给模型。
    return /^https?:\/\/[^\s]+$/i.test(real) && checkPublicUrl(real).ok ? real : href;
  } catch {
    return href;
  }
}

/**
 * 只看词不看意思的泛词：命中它们不能说明结果和问题有关（「价格」「推荐」「2026」哪儿都有）。
 */
const GENERIC_UNITS = new Set([
  "推荐", "价格", "官方", "官网", "最新", "评测", "以内", "以下", "以上", "哪家", "哪些", "哪个", "什么", "怎么", "如何", "必去", "本地", "地址", "排名", "排行",
  "the", "and", "for", "with", "best", "top", "latest", "official", "price", "review", "vs",
]);

/** 查询里拿来判断相关性的词：英文 / 数字按词，中文按相邻两字；去掉 site: 这类搜索语法和泛词。 */
export function queryUnits(query: string): string[] {
  const text = query.toLowerCase().replace(/\b[a-z]+:\S+/g, " ");
  const units = new Set<string>();
  for (const word of text.match(/[a-z0-9][a-z0-9+#.-]*/g) ?? []) {
    const w = word.replace(/[.-]+$/, "");
    if (w.length >= 2 && !GENERIC_UNITS.has(w) && !/^20\d\d$/.test(w)) units.add(w);
  }
  for (const run of text.match(/\p{Script=Han}+/gu) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) {
      const pair = run.slice(i, i + 2);
      if (!GENERIC_UNITS.has(pair)) units.add(pair);
    }
  }
  // 纯数字（「500」）太容易撞上无关页面（Plus500、500 彩票网），有别的词时不拿它判断。
  const words = [...units].filter((unit) => !/^\d+$/.test(unit));
  return words.length ? words : [...units];
}

/** 查询里按空格分开的完整词（去掉 site: 语法、泛词、年份日期和纯数字），用来判断结果是否相关。 */
export function queryWords(query: string): string[] {
  const words = new Set<string>();
  for (const raw of query.toLowerCase().replace(/\b[a-z]+:\S+/g, " ").split(/\s+/)) {
    const word = raw.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
    if (word.length < 2 || GENERIC_UNITS.has(word) || /^[\d.,]+$/.test(word) || /^[\d年月日号./-]+$/.test(word)) continue;
    words.add(word);
  }
  return [...words];
}

/** 英文 / 数字词按整词匹配（「ai」不算命中「mail」），中文词按包含。 */
function containsWord(haystack: string, word: string): boolean {
  if (!/^[a-z0-9]/.test(word) || /\p{Script=Han}/u.test(word)) return haystack.includes(word);
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(haystack);
}

/**
 * Bing 回退的结果先过一遍相关性（2026-10-29，hark 对比 #3 #8 #11）。
 *
 * 线上 DuckDuckGo 基本拿不到结果，搜索全落到 Bing；而 Bing 对不带 cookie 的抓取经常给出和问题无关的页面
 *（「500 元以内 降噪耳机」回 Plus500 和彩票网，「科技新闻」回 QQ 邮箱登录页）。模型拿着这些什么也用不上，
 * 就一遍遍换词重搜。
 *
 * 规则（小爱审查 #407 后放宽，2026-10-29）：查询里任一按空格分开的完整词出现在结果里就保留；都没出现时用
 * 关键词（英文按词、中文按相邻两字）兜底，命中一个就保留。最初要求命中两个，对中文太严：「科技新闻 今天」
 * 会把「IT之家 科技资讯」丢掉。留下的结果按命中多少排序（完整词权重大），同分保持原顺序。
 */
export function relevantHits(query: string, hits: SearchHit[]): SearchHit[] {
  const words = queryWords(query);
  const units = queryUnits(query);
  if (words.length === 0 && units.length === 0) return hits;
  return hits
    .map((hit, index) => {
      const haystack = `${hit.title} ${hit.snippet} ${hit.url}`.toLowerCase();
      const score =
        10 * words.filter((word) => containsWord(haystack, word)).length +
        units.filter((unit) => containsWord(haystack, unit)).length;
      return { hit, index, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.hit);
}

export function parseBing(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const block of html.split(/<li class="b_algo/).slice(1)) {
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1] ?? "";
    hits.push({
      title: decodeEntities((a[2] ?? "").replace(/<[^>]+>/g, "")).trim(),
      url: unwrapBingUrl(decodeEntities(a[1] ?? "")),
      snippet: decodeEntities(snippet.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
    });
  }
  return hits;
}

const lastMissLog = new Map<string, number>();
/**
 * DuckDuckGo 拿不到结果时在服务器日志里记一行（同一种情况最多每 10 分钟一行，不带查询内容）。2026-10-29
 * 发现线上搜索结果全是 Bing 的跳转链接，也就是 DuckDuckGo 一直失败，而之前失败被静默吞掉，没人知道。
 */
function noteSearchMiss(engine: string, reason: string, detail: string, now = Date.now()) {
  const key = `${engine}:${reason}`;
  if (now - (lastMissLog.get(key) ?? Number.NEGATIVE_INFINITY) < 600_000) return;
  lastMissLog.set(key, now);
  console.warn(JSON.stringify({ type: "web-search-engine-miss", engine, reason, detail: detail.replace(/https?:\/\/\S+/g, "<url>").slice(0, 200) }));
}

/**
 * DuckDuckGo 的反爬页（2026-10-29，在 Haupt 上只读核实）：对生产出口 IP，HTML 端点回 HTTP 202，页面里是
 * `anomaly` 验证脚本，一条结果也没有。这不是「没搜到」，是被拦了，而且一拦就是一阵子。
 */
export function isDuckDuckGoChallenge(page: { status: number; body: string }): boolean {
  // 只看 202 不够（小爱审查 #407）：202 也可能是正常页面，要同时有 anomaly 验证脚本、且没有一条结果才算被拦。
  return /anomaly/i.test(page.body) && !/class="result__a"/.test(page.body);
}

/** 被拦之后多久内不再去敲 DuckDuckGo：每次搜索白等一个来回，还会让拦截持续下去。 */
export const DDG_COOLDOWN_MS = 10 * 60_000;
let ddgBlockedUntil = 0;

/** 测试用：清掉冷却和日志节流。 */
export function resetSearchState() {
  ddgBlockedUntil = 0;
  lastMissLog.clear();
}

/**
 * 一次搜索的结果，外加「搜索源这次能不能用」。
 *
 * `sourceDown`：DuckDuckGo 失败（连不上、被拦、回了验证页），并且 Bing 也失败或一条结果都没给。这时
 * 再换关键词搜也是同样的结果，所以工具直接告诉模型搜索源不可用、别再搜（{@link SEARCH_SOURCE_DOWN}）。
 * DuckDuckGo 正常回了页面只是没有结果，或者 Bing 给了结果但都和问题无关（被 {@link relevantHits} 滤空），
 * 算没搜到相关结果（{@link NO_SEARCH_HITS}），不算源不可用。
 */
export type SearchOutcome = { hits: SearchHit[]; sourceDown: boolean };

type PageFetcher = (url: string, signal?: AbortSignal, accept?: string, userAgent?: string, timeoutMs?: number) => Promise<{ status: number; body: string }>;

export async function searchWeb(
  query: string,
  count = 6,
  signal?: AbortSignal,
  deps: { fetchPage?: PageFetcher; now?: () => number; timeoutMs?: number } = {},
): Promise<SearchOutcome> {
  const fetchPage = deps.fetchPage ?? fetchPublic;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 20_000;
  let hits: SearchHit[] = [];
  let ddgDown = true;
  if (now() >= ddgBlockedUntil) {
    // DuckDuckGo 对浏览器式 UA 会回「异常流量」验证页（2026-10-13 实测），用最简 UA。
    const ddg = await fetchPage(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, signal, undefined, "Mozilla/5.0", timeoutMs).catch((error: unknown) => {
      if (!signal?.aborted) noteSearchMiss("duckduckgo", "error", error instanceof Error ? error.message : String(error), now());
      return null;
    });
    if (ddg && isDuckDuckGoChallenge(ddg)) {
      ddgBlockedUntil = now() + DDG_COOLDOWN_MS;
      noteSearchMiss("duckduckgo", "challenge", `status ${ddg.status}, anti-bot page; skipping DuckDuckGo for ${DDG_COOLDOWN_MS / 60_000} min`, now());
    } else if (ddg) {
      hits = parseDuckDuckGo(ddg.body);
      ddgDown = ddg.status !== 200 && hits.length === 0;
      if (hits.length === 0) noteSearchMiss("duckduckgo", "empty", `status ${ddg.status}, no results`, now());
    }
  }
  let bingRaw = 0;
  if (hits.length === 0) {
    const bing = await fetchPage(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`, signal, undefined, UA, timeoutMs).catch(() => null);
    const raw = bing ? parseBing(bing.body) : [];
    bingRaw = raw.length;
    hits = relevantHits(query, raw);
  }
  return { hits: hits.slice(0, Math.max(1, Math.min(count, 10))), sourceDown: ddgDown && hits.length === 0 && bingRaw === 0 };
}

export async function webSearch(query: string, count = 6, signal?: AbortSignal, timeoutMs = 20_000): Promise<SearchHit[]> {
  return (await searchWeb(query, count, signal, { timeoutMs })).hits;
}

export async function webFetch(raw: string, signal?: AbortSignal, timeoutMs = 20_000) {
  const page = await fetchPublic(raw, signal, undefined, UA, timeoutMs);
  const type = page.contentType.toLowerCase();
  if (type.includes("json") || /^\s*[[{]/.test(page.body.slice(0, 20))) {
    return { url: page.url, status: page.status, kind: "json" as const, title: "", text: page.body.slice(0, MAX_TEXT), truncated: page.body.length > MAX_TEXT };
  }
  if (type.includes("html") || /<html|<body|<div/i.test(page.body.slice(0, 2000))) {
    const { title, text } = htmlToText(page.body);
    return { url: page.url, status: page.status, kind: "html" as const, title, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
  }
  return { url: page.url, status: page.status, kind: "text" as const, title: "", text: page.body.slice(0, MAX_TEXT), truncated: page.body.length > MAX_TEXT };
}

/** 第一次读网页的超时；超时 / 断线再试一次，第二次给短一点的时间（A4）。 */
const FETCH_TIMEOUT_MS = 12_000;
const RETRY_TIMEOUT_MS = 8_000;
/** 降级搜索每个搜索引擎的超时：整个 web_fetch 最坏约 12 + 8 + 2×8 秒，留在卡死看门狗（默认 60 秒）之内。 */
const FALLBACK_SEARCH_TIMEOUT_MS = 8_000;
const FETCH_ATTEMPTS = 2;

/** 超时、断线、DNS 抖动这类值得再试一次的错误；被拦截的地址、格式错误不重试。 */
export function isTransientFetchError(error: unknown): boolean {
  if (error instanceof BlockedUrlError) return false;
  const text = error instanceof Error ? `${error.name} ${error.message} ${(error as { code?: unknown }).code ?? ""}` : String(error);
  return /超时|timed? ?out|timeout|abort|reset|ECONN|EAI_AGAIN|ENOTFOUND|socket|network|fetch failed|closed/i.test(text);
}

/** 网页读不到时拿来搜索的词：维基这类 /wiki/标题 用标题，其余用「域名 + 路径」。 */
export function searchQueryForUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "");
  const segments = url.pathname.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  const wiki = /(^|\.)wikipedia\.org$/.test(host) && segments[0] === "wiki" ? segments[1] : undefined;
  if (wiki) return `${wiki.replace(/_/g, " ")} wikipedia`;
  const words = segments.slice(-2).join(" ").replace(/[-_]+/g, " ").replace(/\.[a-z0-9]+$/i, "").trim();
  return words ? `${host} ${words}` : host;
}

const searchParameters = z.object({
  query: z.string().min(1).max(300).describe("搜索词，中文或英文都可以"),
  count: z.number().int().min(1).max(10).optional().describe("要几条结果，默认 6"),
});
const fetchParameters = z.object({
  url: z.string().min(4).max(2000).describe("完整网址（https://…），可以是网页，也可以是返回 JSON 的公开接口"),
});

export const WEB_GUIDANCE =
  "联网顺序：查资料、价格、天气、新闻等事实，先用 web_search 找来源，再用 web_fetch 读网页或公开 JSON 接口（例如 api.coingecko.com、api.open-meteo.com），直接在对话里回答并注明来源。只有需要点击、登录、填表、截图，或者用户要看页面时，才用浏览器（computer_*）。";

/**
 * 没搜到时给模型的话。以前是「换个说法再搜一次」，等于叫它重搜：线上一轮搜 6–9 次、30–45 秒才开口的
 * 主要原因就是这句话加上搜索本身不可用（见 {@link relevantHits}）。现在限定最多再换一次，之后读确定的
 * 网址或者按已知信息回答并说明没核实。
 */
export const NO_SEARCH_HITS =
  "没有搜到相关结果（这次搜索没给出可用结果，不代表网上没有）。不要接着换关键词连搜：最多再换一次更短、更具体的关键词；还没有就 web_fetch 一个你确定的官网或权威页面，或者按已知信息回答，并说明没有联网核实。";

/**
 * 搜索源整个不可用时给模型的话（2026-10-29，hark 对比 #5 #8 #11）。和 {@link NO_SEARCH_HITS} 分开：那是
 * 「这个说法没搜到」，换一次关键词还有意义；这是「搜什么都一样」，再搜只是让用户多等一轮模型。
 */
export const SEARCH_SOURCE_DOWN =
  "当前搜索源不可用（不是网上没有这类信息，换关键词也一样）。这一轮不要再调用 web_search：需要的话 web_fetch 一个你确定的官网或权威页面；否则按已知信息回答，并说明没有联网核实。";

/** web_search 工具结果的文字：命中的结果包进 untrusted 信封；没有结果时按「源不可用 / 没搜到」分别说。 */
export function searchResultText(outcome: SearchOutcome): string {
  if (outcome.hits.length === 0) return outcome.sourceDown ? SEARCH_SOURCE_DOWN : NO_SEARCH_HITS;
  return markUntrusted(
    outcome.hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n"),
    "web search results",
  );
}

/**
 * 本轮不再搜索（小爱审查 #407，2026-10-29）：「没搜到最多再换一次词」以前只写在提示词里，模型不照做时
 * 照样一轮连搜 6–9 次。现在在代码里按轮计数：这一轮已有 {@link SEARCH_TURN_MISS_LIMIT} 次没搜到相关结果，
 * 或者已经确认搜索源不可用，之后的 web_search 不再联网，直接返回下面的话。
 */
export const SEARCH_TURN_MISS_LIMIT = 2;
export const SEARCH_TURN_STOPPED =
  "本轮不再搜索：这一轮已经有 2 次没搜到相关结果，再换关键词也只是让用户多等。需要的话 web_fetch 一个你确定的官网或权威页面；否则按已知信息回答，并说明没有联网核实。";
export const SEARCH_TURN_STOPPED_DOWN =
  "本轮不再搜索：这一轮已经确认当前搜索源不可用。需要的话 web_fetch 一个你确定的官网或权威页面；否则按已知信息回答，并说明没有联网核实。";

type SearchTurnState = { misses: number; down: boolean };
/** 按轮记：键是这一轮的取消信号（每轮一个），没有信号时用确认上下文里的这一轮；都没有就不限制。 */
const searchTurns = new WeakMap<object, SearchTurnState>();
function searchTurnState(signal?: AbortSignal): SearchTurnState | undefined {
  const key: object | undefined = signal ?? currentConfirmTurn();
  if (!key) return undefined;
  let state = searchTurns.get(key);
  if (!state) {
    state = { misses: 0, down: false };
    searchTurns.set(key, state);
  }
  return state;
}

/** 网络这一层，测试里可以换成模拟的超时 / 搜索结果。`outcome` 带上「搜索源能不能用」，没给就按 `search` 的结果算。 */
export type WebIo = {
  fetch: typeof webFetch;
  search: typeof webSearch;
  outcome?: (query: string, count: number, signal?: AbortSignal) => Promise<SearchOutcome>;
};
const REAL_IO: WebIo = { fetch: webFetch, search: webSearch, outcome: (query, count, signal) => searchWeb(query, count, signal) };

export function webTools(io: WebIo = REAL_IO): GrantedTool[] {
  return [
    {
      name: "web_search",
      ref: "web/web_search",
      description:
        "联网搜索（只读，不带用户身份）。返回标题、网址和摘要。查事实、新闻、价格、天气、某个网站的地址，或者查一个外部服务（腾讯 ima、Notion、Gmail……）怎么接入、有没有官方 API / MCP / 开放平台时，先用它；需要细节再用 web_fetch 读其中一个网址。比打开浏览器快得多。一轮里一般搜 1–3 次就够：推荐类问题（买什么、去哪家）拿到几个候选就停，直接给 2–3 个带大致价格的选项，不要反复换关键词重搜。某次没搜到相关结果，最多再换一次关键词。列多条新闻或推荐时，尽量来自不同网站，每条注明来源网站。",
      parameters: searchParameters,
      execute: async (args, ctx) => {
        const signal = ctx?.signal ?? currentToolAbort();
        if (signal?.aborted) return `${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`;
        const parsed = searchParameters.safeParse(args);
        if (!parsed.success) return `${REFUSAL_MARKER} web_search 需要 query。`;
        try {
          const { query, count = 6 } = parsed.data;
          const turn = searchTurnState(signal);
          if (turn?.down) return SEARCH_TURN_STOPPED_DOWN;
          if (turn && turn.misses >= SEARCH_TURN_MISS_LIMIT) return SEARCH_TURN_STOPPED;
          const outcome = io.outcome ? await io.outcome(query, count, signal) : { hits: await io.search(query, count, signal), sourceDown: false };
          if (turn && outcome.sourceDown) turn.down = true;
          else if (turn && outcome.hits.length === 0) turn.misses++;
          return searchResultText(outcome);
        } catch (error) {
          if (signal?.aborted || (error instanceof Error && /abort/i.test(error.name + error.message)))
            return `${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`;
          return `${REFUSAL_MARKER} 搜索失败：${error instanceof Error ? error.message : "未知原因"}`;
        }
      },
    },
    {
      name: "web_fetch",
      ref: "web/web_fetch",
      description:
        "读取一个公开网址的内容（只读，不带用户身份，不执行脚本）。网页返回标题和正文文字，接口返回原始 JSON。适合读文章、文档、公开数据接口（行情、天气等）。需要登录、点击或脚本渲染的页面才用浏览器。",
      parameters: fetchParameters,
      execute: async (args, ctx) => {
        const signal = ctx?.signal ?? currentToolAbort();
        if (signal?.aborted) return `${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`;
        const parsed = fetchParameters.safeParse(args);
        if (!parsed.success) return `${REFUSAL_MARKER} web_fetch 需要 url。`;
        const stopped = () => `${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`;
        let lastError: unknown;
        for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
          try {
            const page = await io.fetch(parsed.data.url, signal, attempt === 0 ? FETCH_TIMEOUT_MS : RETRY_TIMEOUT_MS);
            const head = `网址：${page.url}\n状态：${page.status}${page.title ? `\n标题：${page.title}` : ""}${page.truncated ? "\n（内容过长，已截断）" : ""}`;
            return `${head}\n${markUntrusted(page.text || "（没有可读文字，可能需要浏览器渲染）", page.url)}`;
          } catch (error) {
            // 只有这一轮真的被停了才说「用户已停止」。以前凡是报错里带 abort（连接中途被掐断的 "aborted"、
            // 超时的 AbortError）都会被说成用户停了，模型信了就不再回答（Hark 对比 A4）。
            if (signal?.aborted) return stopped();
            lastError = error;
            if (!isTransientFetchError(error)) break;
          }
        }
        const reason = lastError instanceof Error ? lastError.message : "未知原因";
        // 降级：网页读不到时，用搜索结果摘要先回答，并告诉模型这只是摘要（2026-10-29，A4）。
        const query = searchQueryForUrl(parsed.data.url);
        if (query && isTransientFetchError(lastError)) {
          const hits = await io.search(query, 5, signal, FALLBACK_SEARCH_TIMEOUT_MS).catch(() => []);
          if (signal?.aborted) return stopped();
          if (hits.length > 0)
            return `网页没有读到（${reason}），下面是搜索「${query}」得到的结果摘要。请据此回答用户，并说明这是根据搜索摘要整理的、没有读到原网页全文。\n${markUntrusted(
              hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n"),
              "web search results",
            )}`;
        }
        return `${REFUSAL_MARKER} 读取失败：${reason}。请直接告诉用户这个网页暂时读不到、原因是什么，不要再重复读取同一个网址。`;
      },
    },
  ];
}

import { z } from "zod";
import { BlockedUrlError, guardedFetch, resolvePublic } from "../../../shared/net/guarded-fetch";
import { checkPublicUrl } from "../../../shared/net/ssrf";
import { currentToolAbort, TOOL_STOPPED_ZH } from "../confirmations/context";
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

async function fetchPublic(raw: string, signal?: AbortSignal, accept = "text/html,application/json;q=0.9,*/*;q=0.8", userAgent = UA) {
  try {
    const response = await guardedFetch(raw, {
      maxBytes: MAX_BYTES,
      timeoutMs: 20_000,
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
    return /^https?:\/\/[^\s]+$/i.test(real) ? real : href;
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

/**
 * Bing 回退的结果先过一遍相关性（2026-10-29，hark 对比 #3 #8 #11）。
 *
 * 线上 DuckDuckGo 基本拿不到结果，搜索全落到 Bing；而 Bing 对不带 cookie 的抓取经常给出和问题无关的页面
 *（「上海 咖啡店」回成人站，「500 元以内 降噪耳机」回 Plus500 和彩票网，「漫步者 W820NB」回星巴克）。模型
 * 拿着这些什么也用不上，就一遍遍换词重搜，最后只能写「未核实」。所以至少命中查询里两个关键词（查询只有
 * 一个关键词就命中那一个）的结果才留下；全都不相关就如实说没搜到，比把无关页面当结果交给模型强。
 */
export function relevantHits(query: string, hits: SearchHit[]): SearchHit[] {
  const units = queryUnits(query);
  if (units.length === 0) return hits;
  const need = Math.min(2, units.length);
  return hits.filter((hit) => {
    const haystack = `${hit.title} ${hit.snippet} ${hit.url}`.toLowerCase();
    let found = 0;
    for (const unit of units) if (haystack.includes(unit) && ++found >= need) return true;
    return false;
  });
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

let lastMissLog = 0;
/**
 * DuckDuckGo 拿不到结果时在服务器日志里记一行（最多每 10 分钟一行，不带查询内容）。2026-10-29 发现线上
 * 搜索结果全是 Bing 的跳转链接，也就是 DuckDuckGo 一直失败，而之前失败被静默吞掉，没人知道。
 */
function noteSearchMiss(engine: string, detail: string) {
  const now = Date.now();
  if (now - lastMissLog < 600_000) return;
  lastMissLog = now;
  console.warn(JSON.stringify({ type: "web-search-engine-miss", engine, detail: detail.replace(/https?:\/\/\S+/g, "<url>").slice(0, 200) }));
}

export async function webSearch(query: string, count = 6, signal?: AbortSignal): Promise<SearchHit[]> {
  // DuckDuckGo 对浏览器式 UA 会回「异常流量」验证页（2026-10-13 实测），用最简 UA。
  const ddg = await fetchPublic(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, signal, undefined, "Mozilla/5.0").catch((error: unknown) => {
    if (!signal?.aborted) noteSearchMiss("duckduckgo", error instanceof Error ? error.message : String(error));
    return null;
  });
  let hits = ddg ? parseDuckDuckGo(ddg.body) : [];
  if (ddg && hits.length === 0) noteSearchMiss("duckduckgo", `status ${ddg.status}, no results`);
  if (hits.length === 0) {
    const bing = await fetchPublic(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`, signal).catch(() => null);
    hits = bing ? relevantHits(query, parseBing(bing.body)) : [];
  }
  return hits.slice(0, Math.max(1, Math.min(count, 10)));
}

export async function webFetch(raw: string, signal?: AbortSignal) {
  const page = await fetchPublic(raw, signal);
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

export function webTools(): GrantedTool[] {
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
          const hits = await webSearch(parsed.data.query, parsed.data.count ?? 6, signal);
          if (hits.length === 0) return NO_SEARCH_HITS;
          return markUntrusted(
            hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n"),
            "web search results",
          );
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
        try {
          const page = await webFetch(parsed.data.url, signal);
          const head = `网址：${page.url}\n状态：${page.status}${page.title ? `\n标题：${page.title}` : ""}${page.truncated ? "\n（内容过长，已截断）" : ""}`;
          return `${head}\n${markUntrusted(page.text || "（没有可读文字，可能需要浏览器渲染）", page.url)}`;
        } catch (error) {
          if (signal?.aborted || (error instanceof Error && /abort/i.test(error.name + error.message)))
            return `${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`;
          return `${REFUSAL_MARKER} 读取失败：${error instanceof Error ? error.message : "未知原因"}`;
        }
      },
    },
  ];
}

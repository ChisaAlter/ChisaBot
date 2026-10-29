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

export function parseBing(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const block of html.split(/<li class="b_algo/).slice(1)) {
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1] ?? "";
    hits.push({
      title: decodeEntities((a[2] ?? "").replace(/<[^>]+>/g, "")).trim(),
      url: decodeEntities(a[1] ?? ""),
      snippet: decodeEntities(snippet.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
    });
  }
  return hits;
}

export async function webSearch(query: string, count = 6, signal?: AbortSignal, timeoutMs = 20_000): Promise<SearchHit[]> {
  // DuckDuckGo 对浏览器式 UA 会回「异常流量」验证页（2026-10-13 实测），用最简 UA。
  const ddg = await fetchPublic(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, signal, undefined, "Mozilla/5.0", timeoutMs).catch(() => null);
  let hits = ddg ? parseDuckDuckGo(ddg.body) : [];
  if (hits.length === 0) {
    const bing = await fetchPublic(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`, signal, undefined, UA, timeoutMs).catch(() => null);
    hits = bing ? parseBing(bing.body) : [];
  }
  return hits.slice(0, Math.max(1, Math.min(count, 10)));
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

/** 网络这一层，测试里可以换成模拟的超时 / 搜索结果。 */
export type WebIo = { fetch: typeof webFetch; search: typeof webSearch };
const REAL_IO: WebIo = { fetch: webFetch, search: webSearch };

export function webTools(io: WebIo = REAL_IO): GrantedTool[] {
  return [
    {
      name: "web_search",
      ref: "web/web_search",
      description:
        "联网搜索（只读，不带用户身份）。返回标题、网址和摘要。查事实、新闻、价格、天气、某个网站的地址，或者查一个外部服务（腾讯 ima、Notion、Gmail……）怎么接入、有没有官方 API / MCP / 开放平台时，先用它；需要细节再用 web_fetch 读其中一个网址。比打开浏览器快得多。一轮里一般搜 1–3 次就够：推荐类问题（买什么、去哪家）拿到几个候选就停，直接给 2–3 个带大致价格的选项，不要反复换关键词重搜。",
      parameters: searchParameters,
      execute: async (args, ctx) => {
        const signal = ctx?.signal ?? currentToolAbort();
        if (signal?.aborted) return `${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`;
        const parsed = searchParameters.safeParse(args);
        if (!parsed.success) return `${REFUSAL_MARKER} web_search 需要 query。`;
        try {
          const hits = await io.search(parsed.data.query, parsed.data.count ?? 6, signal);
          if (hits.length === 0) return "没有搜到结果。换个说法再搜一次，或者直接 web_fetch 一个你知道的网址。";
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

import { domainToUnicode } from "node:url";

/**
 * 从网页 HTML 里取链接预览卡要的东西（标题、站点名、说明、预览图、图标），纯函数，能单测。
 *
 * 优先级：og:* → twitter:* → <title> / meta description；预览图 og:image(:secure_url) → twitter:image(:src)
 * → link rel=image_src；图标按 <link rel="icon" / "shortcut icon" / "apple-touch-icon"> 选最合适的一个，
 * 都没有就用 /favicon.ico。所有相对地址按页面地址（或 <base href>）补全，只保留 http / https。
 */

export type ParsedPage = {
  title: string;
  siteName: string;
  description: string;
  image: string | null;
  icons: string[];
};

/**
 * All 252 HTML 4 named character references (`&rsquo;`, `&eacute;`, `&hellip;` …), packed as
 * `name:hex-codepoint`. Titles from WordPress and English blogs use them constantly; a short hand
 * list left most of them on the card verbatim. HTML5 adds ~2000 more, practically never seen in
 * `<title>` / meta. Names are case-sensitive (`&Eacute;` ≠ `&eacute;`), exactly as in HTML.
 */
const PACKED_ENTITIES =
  "quot:22 amp:26 lt:3c gt:3e nbsp:a0 iexcl:a1 cent:a2 pound:a3 curren:a4 yen:a5 brvbar:a6 sect:a7 " +
  "uml:a8 copy:a9 ordf:aa laquo:ab not:ac shy:ad reg:ae macr:af deg:b0 plusmn:b1 sup2:b2 sup3:b3 " +
  "acute:b4 micro:b5 para:b6 middot:b7 cedil:b8 sup1:b9 ordm:ba raquo:bb frac14:bc frac12:bd " +
  "frac34:be iquest:bf Agrave:c0 Aacute:c1 Acirc:c2 Atilde:c3 Auml:c4 Aring:c5 AElig:c6 Ccedil:c7 " +
  "Egrave:c8 Eacute:c9 Ecirc:ca Euml:cb Igrave:cc Iacute:cd Icirc:ce Iuml:cf ETH:d0 Ntilde:d1 " +
  "Ograve:d2 Oacute:d3 Ocirc:d4 Otilde:d5 Ouml:d6 times:d7 Oslash:d8 Ugrave:d9 Uacute:da Ucirc:db " +
  "Uuml:dc Yacute:dd THORN:de szlig:df agrave:e0 aacute:e1 acirc:e2 atilde:e3 auml:e4 aring:e5 " +
  "aelig:e6 ccedil:e7 egrave:e8 eacute:e9 ecirc:ea euml:eb igrave:ec iacute:ed icirc:ee iuml:ef " +
  "eth:f0 ntilde:f1 ograve:f2 oacute:f3 ocirc:f4 otilde:f5 ouml:f6 divide:f7 oslash:f8 ugrave:f9 " +
  "uacute:fa ucirc:fb uuml:fc yacute:fd thorn:fe yuml:ff OElig:152 oelig:153 Scaron:160 scaron:161 " +
  "Yuml:178 fnof:192 circ:2c6 tilde:2dc Alpha:391 Beta:392 Gamma:393 Delta:394 Epsilon:395 Zeta:396 " +
  "Eta:397 Theta:398 Iota:399 Kappa:39a Lambda:39b Mu:39c Nu:39d Xi:39e Omicron:39f Pi:3a0 Rho:3a1 " +
  "Sigma:3a3 Tau:3a4 Upsilon:3a5 Phi:3a6 Chi:3a7 Psi:3a8 Omega:3a9 alpha:3b1 beta:3b2 gamma:3b3 " +
  "delta:3b4 epsilon:3b5 zeta:3b6 eta:3b7 theta:3b8 iota:3b9 kappa:3ba lambda:3bb mu:3bc nu:3bd " +
  "xi:3be omicron:3bf pi:3c0 rho:3c1 sigmaf:3c2 sigma:3c3 tau:3c4 upsilon:3c5 phi:3c6 chi:3c7 " +
  "psi:3c8 omega:3c9 thetasym:3d1 upsih:3d2 piv:3d6 ensp:2002 emsp:2003 thinsp:2009 zwnj:200c " +
  "zwj:200d lrm:200e rlm:200f ndash:2013 mdash:2014 lsquo:2018 rsquo:2019 sbquo:201a ldquo:201c " +
  "rdquo:201d bdquo:201e dagger:2020 Dagger:2021 bull:2022 hellip:2026 permil:2030 prime:2032 " +
  "Prime:2033 lsaquo:2039 rsaquo:203a oline:203e frasl:2044 euro:20ac image:2111 weierp:2118 " +
  "real:211c trade:2122 alefsym:2135 larr:2190 uarr:2191 rarr:2192 darr:2193 harr:2194 crarr:21b5 " +
  "lArr:21d0 uArr:21d1 rArr:21d2 dArr:21d3 hArr:21d4 forall:2200 part:2202 exist:2203 empty:2205 " +
  "nabla:2207 isin:2208 notin:2209 ni:220b prod:220f sum:2211 minus:2212 lowast:2217 radic:221a " +
  "prop:221d infin:221e ang:2220 and:2227 or:2228 cap:2229 cup:222a int:222b there4:2234 sim:223c " +
  "cong:2245 asymp:2248 ne:2260 equiv:2261 le:2264 ge:2265 sub:2282 sup:2283 nsub:2284 sube:2286 " +
  "supe:2287 oplus:2295 otimes:2297 perp:22a5 sdot:22c5 lceil:2308 rceil:2309 lfloor:230a " +
  "rfloor:230b lang:2329 rang:232a loz:25ca spades:2660 clubs:2663 hearts:2665 diams:2666 ";
const ENTITIES: Record<string, string> = Object.fromEntries(
  PACKED_ENTITIES.trim()
    .split(/\s+/)
    .map((pair) => {
      const [name, hex] = pair.split(":") as [string, string];
      return [name, String.fromCodePoint(Number.parseInt(hex, 16))];
    }),
);
ENTITIES.apos = "'";

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);?/g, (m, n) => {
      const code = Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/&#x([0-9a-f]+);?/gi, (m, n) => {
      const code = Number.parseInt(n, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(
      /&([a-z][a-z0-9]*);/gi,
      (m, name: string) => ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? m,
    );
}

function clean(text: string | undefined, max: number): string {
  if (!text) return "";
  const flat = decodeEntities(text)
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 解析一个标签里的属性（不区分大小写，值可带单 / 双引号或不带引号）。 */
export function parseAttributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  // 跳过标签名
  const body = tag.replace(/^<\s*[a-zA-Z]+/, "").replace(/\/?>$/, "");
  for (const m of body.matchAll(re)) {
    const key = (m[1] ?? "").toLowerCase();
    if (key && !(key in out)) out[key] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

export function resolveHttpUrl(
  raw: string | undefined,
  base: string,
): string | null {
  if (!raw) return null;
  const value = decodeEntities(raw.trim());
  if (!value || value.startsWith("data:") || value.startsWith("javascript:"))
    return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** 只看 <head>（没有就看前 256KB），预览需要的东西都在那里。 */
function headOf(html: string): string {
  const end = html.search(/<\/head\s*>/i);
  return end > 0 ? html.slice(0, end) : html.slice(0, 256 * 1024);
}

export function parsePage(html: string, pageUrl: string): ParsedPage {
  const head = headOf(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ");
  const baseHref = /<base\b[^>]*>/i.exec(head)?.[0];
  const base =
    resolveHttpUrl(
      baseHref ? parseAttributes(baseHref).href : undefined,
      pageUrl,
    ) ?? pageUrl;

  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = parseAttributes(tag);
    const key = (attrs.property || attrs.name || attrs.itemprop || "")
      .toLowerCase()
      .trim();
    const content = attrs.content;
    if (key && content?.trim() && !meta.has(key)) meta.set(key, content);
  }
  const first = (...keys: string[]) => {
    for (const key of keys) {
      const value = meta.get(key);
      if (value?.trim()) return value;
    }
    return undefined;
  };

  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1];
  const title = clean(
    first("og:title", "twitter:title") ?? titleTag ?? first("title", "name"),
    200,
  );
  const siteName = clean(
    first("og:site_name", "application-name", "apple-mobile-web-app-title"),
    80,
  );
  const description = clean(
    first("og:description", "twitter:description", "description"),
    300,
  );

  const links = (head.match(/<link\b[^>]*>/gi) ?? []).map(parseAttributes);
  const imageSrc = links.find((l) =>
    (l.rel ?? "").toLowerCase().split(/\s+/).includes("image_src"),
  )?.href;
  const image = resolveHttpUrl(
    first(
      "og:image:secure_url",
      "og:image",
      "og:image:url",
      "twitter:image",
      "twitter:image:src",
      "image",
    ) ?? imageSrc,
    base,
  );

  // 图标：普通 icon（优先 32px 左右的 png / ico）→ apple-touch-icon → /favicon.ico
  const scored: { href: string; score: number }[] = [];
  for (const link of links) {
    const rel = (link.rel ?? "").toLowerCase().split(/\s+/);
    const href = resolveHttpUrl(link.href, base);
    if (!href) continue;
    const type = (link.type ?? "").toLowerCase();
    const size = Number.parseInt(
      (link.sizes ?? "").split(/[x\s]/i)[0] ?? "",
      10,
    );
    let score = -1;
    if (rel.includes("icon")) score = 50;
    else if (
      rel.includes("apple-touch-icon") ||
      rel.includes("apple-touch-icon-precomposed")
    )
      score = 30;
    else if (rel.includes("mask-icon")) score = 5;
    if (score < 0) continue;
    if (Number.isFinite(size))
      score += size >= 16 && size <= 96 ? 10 : size > 96 ? 4 : 0;
    if (type.includes("svg") || href.toLowerCase().endsWith(".svg")) score -= 8; // svg 能用，但位图更稳
    scored.push({ href, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const icons = [...new Set(scored.map((s) => s.href))].slice(0, 3);
  const fallbackIcon = resolveHttpUrl("/favicon.ico", base);
  if (fallbackIcon && !icons.includes(fallbackIcon)) icons.push(fallbackIcon);

  return { title, siteName, description, image, icons };
}

/** 响应头 / <meta charset> 里写的编码，认不出就 utf-8。 */
export function detectCharset(contentType: string, bytes: Uint8Array): string {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const sniff = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(sniff)?.[1] ?? null;
  return (fromMeta ?? "utf-8").toLowerCase();
}

export function decodeHtml(contentType: string, bytes: Uint8Array): string {
  const charset = detectCharset(contentType, bytes);
  const label = charset === "gb2312" ? "gbk" : charset;
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/**
 * 一个 punycode 标签解码后能不能直接显示：只放行单一文字体系，防同形字冒充（`xn--pple-43d` = 西里尔 а + pple）。
 * - 纯拉丁（可带变音符号，如 café）；
 * - 汉字 / 假名 / 韩文，可以夹 ASCII 字母数字（中文.中国、日本語、ｗeb 不在此列——全角已被 URL 规范化）。
 * 其它文字（西里尔、希腊、亚美尼亚……）一律保留 xn-- 形式：整段西里尔的 аррӏе 看起来就是 apple。
 */
const LATIN_LABEL = /^[\p{Script=Latin}0-9-]+$/u;
const CJK_LABEL =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}ー々〆a-z0-9-]+$/u;
function safeUnicodeLabel(label: string): boolean {
  return LATIN_LABEL.test(label) || CJK_LABEL.test(label);
}

/** 预览卡上显示的域名：去掉 www.；punycode（`xn--…`）标签只在不会被同形字冒充时转回 Unicode，否则保留 ASCII。 */
export function displayDomain(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (!host.includes("xn--")) return host;
    return host
      .split(".")
      .map((label) => {
        if (!label.startsWith("xn--")) return label;
        // `domainToUnicode` returns "" for a host it cannot decode; keep the ASCII form then.
        const unicode = domainToUnicode(label);
        return unicode && safeUnicodeLabel(unicode) ? unicode : label;
      })
      .join(".");
  } catch {
    return url;
  }
}

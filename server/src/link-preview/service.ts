import { imageDimsFor, imageKeyForUrl } from "../image-dims";
import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  BlockedUrlError,
  guardedFetch,
} from "../../../shared/net/guarded-fetch";
import { checkPublicUrl } from "../../../shared/net/ssrf";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { decodeHtml, displayDomain, parsePage } from "./parse";

/**
 * 聊天里的链接预览卡（2026-10-13）：`GET /api/link-preview?url=` 取网页的标题、站点、图标、预览图。
 *
 * - 只连公网（`shared/net/ssrf.ts` + `guarded-fetch.ts`：DNS 解析后检查、IP 钉死、逐跳检查重定向、
 *   限时、限大小、只 http / https）。要登录才能用，按人限速。
 * - 图片（og:image、图标、截图）都由服务器下载后存进 `chisabot_link_preview_assets`，前端只从本站
 *   `/api/link-preview/asset/:id` 读——用户的浏览器不会直接去第三方网站拉图（不暴露谁在看、不怕防盗链）。
 * - 没有 og:image 的网页：交给内置浏览器（agent-computer `/preview-shot`，独立的无痕浏览器、每个请求同样
 *   经过 SSRF 检查）截一张 1200×630 的图。截图在后台做，先回标题等信息并标 `imagePending`，前端过几秒再问。
 * - 结果缓存在 `chisabot_link_previews`：成功 24 小时，失败 / 兜底卡 30 分钟；同一网址同时只取一次。
 * - 网页取不到（对方 4xx/5xx、超时、不是网页）时不再让卡片消失：回一张兜底卡（`degraded`：标题是文件名或域名，
 *   图标取站点根目录的 /favicon.ico，同样经过 SSRF 检查和转存）。被拦的内网地址仍然 422。
 * - 截图（没有 og:image 时）默认关闭：链接卡改成 48px 缩略图后用不上大图（2026-10-14，§48）；
 *   `CHISABOT_LINK_PREVIEW_SHOTS=1` 打开。
 * - 两张表启动时 CREATE TABLE IF NOT EXISTS（和 chat-shots 同一做法），写入时顺手清理过期的。
 */

export type LinkPreview = {
  url: string;
  finalUrl: string;
  title: string;
  siteName: string;
  domain: string;
  description: string;
  /** 本站地址 /api/link-preview/asset/<id>，没有就 null。 */
  image: string | null;
  imageKind: "og" | "shot" | "direct" | "none";
  imagePending: boolean;
  favicon: string | null;
  /**
   * 网页没取到（对方报错 / 超时 / 不是网页，例如下载文件）：只有「标题 = 文件名或域名 + 站点图标」的兜底卡。
   * 被 SSRF 拦下的不算，那种直接 422（DESIGN.md §48）。
   */
  degraded?: boolean;
  /** `image` 的像素宽高（DESIGN.md §83.2），回答时补上；没有就不带。 */
  imageWidth?: number;
  imageHeight?: number;
  /** 视频页（YouTube / bilibili）：`image` 是视频封面，前端可以加播放角标。普通网页不带。 */
  kind?: "video";
};

/** What the service needs from `guardedFetch`; tests pass a fake so no request leaves the machine. */
export type PreviewFetch = typeof guardedFetch;

type ComputerTarget = { baseUrl: string; token?: string };

const OK_TTL_HOURS = 24;
const FAIL_TTL_MINUTES = 30;
const ASSET_KEEP_DAYS = 30;
const HTML_MAX = 1024 * 1024;
const HTML_STOP = 400 * 1024;
const IMAGE_MAX = 3 * 1024 * 1024;
const ICON_MAX = 200 * 1024;
const PAGE_TIMEOUT = 8000;
const IMAGE_TIMEOUT = 8000;
const SHOT_TIMEOUT = 30_000;
const RATE_PER_MINUTE = 40;
const IMAGE_MIME =
  /^image\/(png|jpe?g|gif|webp|avif|x-icon|vnd\.microsoft\.icon|svg\+xml)$/;
const ASSET_ID = /^[a-f0-9]{40}$/;

export function normalizePreviewUrl(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  const verdict = checkPublicUrl(raw.trim());
  if (!verdict.ok) return null;
  const url = verdict.url;
  url.hash = "";
  return url.toString();
}

/** 兜底卡的标题：网址最后一段像文件名（ChisaBot-0.1.7.exe、report.pdf）就用它，否则用域名。 */
export function degradedTitle(url: string): string {
  const domain = displayDomain(url);
  try {
    const last = new URL(url).pathname.split("/").pop() ?? "";
    const name = decodeURIComponent(last);
    if (/\.[a-z0-9]{1,8}$/i.test(name) && name.length <= 120 && !/\.(html?|php|aspx?|jsp)$/i.test(name))
      return name;
  } catch {
    /* 保持域名 */
  }
  return domain;
}

function keyOf(url: string) {
  return createHash("sha256").update(url).digest("hex").slice(0, 40);
}

/** 从字节猜图片格式（不信对方的 content-type）。 */
export function sniffImage(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length < 4) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return "image/webp";
  if (
    b.length >= 12 &&
    b[4] === 0x66 &&
    b[5] === 0x74 &&
    b[6] === 0x79 &&
    b[7] === 0x70 &&
    /avi[fs]/.test(String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!))
  )
    return "image/avif";
  if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0)
    return "image/x-icon";
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(b.subarray(0, 512))
    .trimStart()
    .toLowerCase();
  if (
    head.startsWith("<svg") ||
    (head.startsWith("<?xml") && head.includes("<svg"))
  )
    return "image/svg+xml";
  return null;
}

/** 日志里的网址只留到路径：查询串可能带着用户的东西（token、搜索词）。 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return "(invalid url)";
  }
}

/** 图片直链的标题：路径最后一段像文件名（photo.jpg）就用它；只剩个扩展名样的词（/image/png）就叫「图片」。 */
export function directImageTitle(url: string): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    if (/^.+\.[a-z0-9]{1,8}$/i.test(name)) return name.slice(0, 120);
  } catch {
    /* 落到下面 */
  }
  return "图片";
}

/** 整个标题就是验证页的标题（可带「 - 站点名」「 | 站点名」后缀）：单凭标题即可判定。 */
const CHALLENGE_TITLE_STRONG =
  /^(?:百度安全验证|安全验证|人机验证|访问验证|验证码|滑动验证|Just a moment\.{0,3}|Attention Required! \| Cloudflare|Verify you are human|Are you a robot\??|Human verification|Security check)(?:\s+[-|–—·]\s+.*)?$/i;
/** 标题以这些开头（后面是分隔符或结束）时可能是验证页，但还要状态码或页面特征佐证（「请稍候，正在加载」「Access Denied (2023 film)」不算）。 */
const CHALLENGE_TITLE_WEAK =
  /^(?:请稍候|请稍后|异常请求|访问被拒绝|Access denied|Forbidden|Please wait|Checking your browser|One more step)(?:[\s.!…]*$|\s+[-|–—·:]\s+)/i;
const CHALLENGE_STATUS = new Set([403, 429, 503]);
/** 验证页的页面特征：Cloudflare 挑战表单 / 脚本参数、各家验证码组件。 */
const CHALLENGE_MARKERS =
  /cf-chl-|cf_chl_|challenges\.cloudflare\.com|id=["']challenge-form|g-recaptcha|recaptcha\/api\.js|hcaptcha\.com|turnstile|geetest|TencentCaptcha|captcha\.js|nc_1_wrapper/i;

/**
 * 反爬 / 验证页：跳到了 sec.* / captcha 之类的主机；知乎的 zse-ck 挑战页；整个标题就是验证页标题；
 * 或标题以「请稍候 / Access denied」之类开头且状态码是 403/429/503 或页面带挑战特征。
 */
export function isChallengePage(
  url: string,
  finalUrl: string,
  title: string,
  html: string,
  status = 200,
): boolean {
  let from = "";
  let to = "";
  let path = "";
  try {
    from = new URL(url).hostname;
    const final = new URL(finalUrl);
    to = final.hostname;
    path = final.pathname;
  } catch {
    return false;
  }
  if (to !== from && /^(sec|captcha|verify|challenge|security)\./i.test(to)) return true;
  if (/\/(captcha|challenge|verify)(\/|$)/i.test(path) && to !== from) return true;
  const head = html.slice(0, 65536);
  if (/<meta[^>]+id=["']zh-zse-ck["']/i.test(head.slice(0, 4096))) return true;
  const t = title.trim();
  if (CHALLENGE_TITLE_STRONG.test(t)) return true;
  if (CHALLENGE_TITLE_WEAK.test(t)) return CHALLENGE_STATUS.has(status) || CHALLENGE_MARKERS.test(head);
  return false;
}

const GITHUB_RESERVED = new Set([
  "about", "apps", "collections", "customer-stories", "enterprise", "explore", "features",
  "login", "marketplace", "new", "notifications", "orgs", "organizations", "pricing", "pulls",
  "issues", "search", "settings", "site", "sponsors", "topics", "trending", "users", "join",
]);

/**
 * GitHub 仓库 / release 等页面的兜底预览图：同一仓库的固定地址（opengraph.githubassets.com/1/…，
 * 内容和带哈希的 og 地址一样，CDN 上常有现成的），再不行用仓库主人的头像。不是仓库页就返回空。
 */
export function githubImageFallbacks(pageUrl: string): string[] {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return [];
  }
  if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return [];
  const [owner, repo] = u.pathname.split("/").filter(Boolean);
  if (!owner || !repo || GITHUB_RESERVED.has(owner.toLowerCase())) return [];
  const safe = /^[A-Za-z0-9_.-]+$/;
  if (!safe.test(owner) || !safe.test(repo)) return [];
  return [
    `https://opengraph.githubassets.com/1/${owner}/${repo.replace(/\.git$/, "")}`,
    `https://avatars.githubusercontent.com/${owner}?s=400`,
  ];
}

type ApiInfo = { title: string; description?: string; image?: string | null };
type ApiSource = {
  api: string;
  siteName: string;
  kind?: "video";
  read: (json: unknown) => ApiInfo | null;
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const httpsImage = (v: unknown) => {
  const s = str(v);
  if (!s) return null;
  const full = s.startsWith("//") ? `https:${s}` : s.replace(/^http:\/\//, "https://");
  return /^https:\/\//.test(full) ? full : null;
};

function youtubeId(u: URL): string | null {
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  const id =
    host === "youtu.be"
      ? u.pathname.split("/")[1]
      : host === "youtube.com"
        ? u.pathname === "/watch"
          ? u.searchParams.get("v")
          : /^\/(shorts|live|embed)\/([^/]+)/.exec(u.pathname)?.[2]
        : null;
  return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
}

/** 这个链接有没有公开接口可用（YouTube / bilibili / 百度百科）。 */
export function apiSourceFor(url: string): ApiSource | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const yt = youtubeId(u);
  if (yt) {
    const watch = `https://www.youtube.com/watch?v=${yt}`;
    return {
      api: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`,
      siteName: "YouTube",
      kind: "video",
      read: (json) => {
        const j = obj(json);
        const title = str(j.title);
        if (!title) return null;
        const author = str(j.author_name);
        return { title, description: author, image: httpsImage(j.thumbnail_url) };
      },
    };
  }
  const host = u.hostname.replace(/^(www|m)\./, "");
  if (host === "bilibili.com") {
    const m = /^\/video\/(BV[0-9A-Za-z]{10}|av(\d+))/i.exec(u.pathname);
    if (m) {
      const query = m[2] ? `aid=${m[2]}` : `bvid=${m[1]}`;
      return {
        api: `https://api.bilibili.com/x/web-interface/view?${query}`,
        siteName: "哔哩哔哩",
        kind: "video",
        read: (json) => {
          const j = obj(json);
          if (j.code !== 0) return null;
          const d = obj(j.data);
          const title = str(d.title);
          if (!title) return null;
          const owner = str(obj(d.owner).name);
          const desc = str(d.desc);
          return {
            title,
            description: [owner && `UP 主：${owner}`, desc && desc !== "-" ? desc : ""].filter(Boolean).join(" · ").slice(0, 300),
            image: httpsImage(d.pic),
          };
        },
      };
    }
  }
  if (u.hostname === "baike.baidu.com") {
    const m = /^\/item\/([^/]+)/.exec(u.pathname);
    if (m?.[1]) {
      let name: string;
      try {
        name = decodeURIComponent(m[1]);
      } catch {
        return null;
      }
      return {
        api: `https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_length=300&bk_key=${encodeURIComponent(name)}`,
        siteName: "百度百科",
        read: (json) => {
          const j = obj(json);
          const title = str(j.title);
          if (!title) return null;
          return { title, description: str(j.abstract).slice(0, 300) || str(j.desc), image: httpsImage(j.image) };
        },
      };
    }
  }
  return null;
}

export async function createLinkPreviews(
  database: Database,
  options: {
    computer?: ComputerTarget;
    screenshots?: boolean;
    /** Defaults to `guardedFetch` (SSRF-checked). Tests inject a fake; the rules are unchanged. */
    fetch?: PreviewFetch;
    /** Structured warnings (image fetch failures). Defaults to one JSON line on stderr. */
    log?: (event: Record<string, unknown>) => void;
  } = {},
) {
  const fetchUrl: PreviewFetch = options.fetch ?? guardedFetch;
  const log =
    options.log ?? ((event: Record<string, unknown>) => console.warn(JSON.stringify(event)));
  await database.$client.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_link_previews (
    url_key text PRIMARY KEY, url text NOT NULL, ok boolean NOT NULL, data jsonb NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
  )`);
  await database.$client.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_link_preview_assets (
    id text PRIMARY KEY, mime text NOT NULL, data bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), used_at timestamptz NOT NULL DEFAULT now()
  )`);

  const inFlight = new Map<string, Promise<LinkPreview | null>>();
  const shotsRunning = new Set<string>();
  const rate = new Map<string, number[]>();

  async function readCache(key: string): Promise<{
    ok: boolean;
    data: LinkPreview | { error: string };
    fresh: boolean;
  } | null> {
    const rows = await database.$client.unsafe<
      { ok: boolean; data: unknown; fresh: boolean }[]
    >(
      "SELECT ok, data, expires_at > now() AS fresh FROM chisabot_link_previews WHERE url_key = $1",
      [key],
    );
    const row = rows[0];
    if (!row) return null;
    const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    return { ok: row.ok, data: data as LinkPreview, fresh: row.fresh };
  }

  async function writeCache(
    key: string,
    url: string,
    ok: boolean,
    data: unknown,
    short = false,
  ) {
    const ttl =
      ok && !short ? `${OK_TTL_HOURS} hours` : `${FAIL_TTL_MINUTES} minutes`;
    await database.$client.unsafe(
      `INSERT INTO chisabot_link_previews (url_key, url, ok, data, fetched_at, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, now(), now() + $5::interval)
       ON CONFLICT (url_key) DO UPDATE SET ok = EXCLUDED.ok, data = EXCLUDED.data, fetched_at = now(), expires_at = EXCLUDED.expires_at`,
      [key, url, ok, JSON.stringify(data), ttl],
    );
  }

  async function prune() {
    await database.$client.unsafe(
      "DELETE FROM chisabot_link_previews WHERE expires_at < now() - interval '7 days'",
    );
    await database.$client.unsafe(
      `DELETE FROM chisabot_link_preview_assets WHERE used_at < now() - $1 * interval '1 day'`,
      [ASSET_KEEP_DAYS],
    );
  }

  async function storeAsset(bytes: Uint8Array, mime: string): Promise<string> {
    const id = createHash("sha256").update(bytes).digest("hex").slice(0, 40);
    await database.$client.unsafe(
      `INSERT INTO chisabot_link_preview_assets (id, mime, data) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET used_at = now()`,
      [id, mime, Buffer.from(bytes)],
    );
    await imageDimsFor(database).remember(`lp:${id}`, bytes);
    return `/api/link-preview/asset/${id}`;
  }

  /**
   * 下载一张第三方图片存成本站资源。失败时 `asset` 是 null，`reason` 说明为什么（状态码、太大、不是图片、
   * 被拦、网络错误），`retry` 表示马上再试一次有没有意义：429 / 4xx / 不是图片 / 太大再试也一样。
   */
  async function fetchImageResult(
    url: string,
    max: number,
    allowSvg: boolean,
  ): Promise<{ asset: string | null; reason?: string; retry?: boolean }> {
    let res: Awaited<ReturnType<PreviewFetch>>;
    try {
      res = await fetchUrl(url, {
        maxBytes: max,
        timeoutMs: IMAGE_TIMEOUT,
        headers: {
          accept:
            "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5",
        },
      });
    } catch (error) {
      if (error instanceof BlockedUrlError) return { asset: null, reason: "blocked" };
      const message = error instanceof Error ? error.message : String(error);
      return { asset: null, reason: `error: ${message.slice(0, 120)}`, retry: true };
    }
    if (res.status < 200 || res.status >= 300) {
      const after = res.headers["retry-after"];
      return {
        asset: null,
        reason: `status ${res.status}${after ? ` retry-after=${after}` : ""}`,
        retry: res.status >= 500,
      };
    }
    if (res.truncated) return { asset: null, reason: `too-large (>${max} bytes)` };
    if (res.body.length === 0) return { asset: null, reason: "empty", retry: true };
    const mime = sniffImage(res.body);
    if (!mime || !IMAGE_MIME.test(mime))
      return { asset: null, reason: `not-image (${res.contentType || "no content-type"})` };
    if (mime === "image/svg+xml" && !allowSvg) return { asset: null, reason: "svg-not-allowed" };
    try {
      return { asset: await storeAsset(res.body, mime) };
    } catch (error) {
      return { asset: null, reason: `store-failed: ${error instanceof Error ? error.name : "Error"}` };
    }
  }

  /** 预览图（og:image、视频封面、GitHub 兜底图）：失败要留下原因，不然线上只看得到「没图」。 */
  async function fetchPreviewImage(url: string, role: string): Promise<string | null> {
    let result = await fetchImageResult(url, IMAGE_MAX, false);
    // og:image 偶尔第一次很慢（GitHub 的图是现做的）：网络错误 / 5xx 再试一次；429、404 再试也一样。
    if (!result.asset && result.retry) result = await fetchImageResult(url, IMAGE_MAX, false);
    if (!result.asset)
      log({ type: "link-preview-image-failed", role, url: redactUrl(url), reason: result.reason });
    return result.asset;
  }

  /** 图标：一次就好，失败不记（每个网页会试好几个地址）。 */
  async function fetchImage(url: string, max: number, allowSvg: boolean): Promise<string | null> {
    return (await fetchImageResult(url, max, allowSvg)).asset;
  }

  async function screenshot(url: string): Promise<string | null> {
    if (!options.computer) return null;
    const base = options.computer.baseUrl.replace(/\/$/, "");
    try {
      const res = await fetch(`${base}/preview-shot`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-chisabot-bot-id": "link-preview", "x-openbot-bot-id": "link-preview",
          ...(options.computer.token
            ? { "x-chisabot-computer-token": options.computer.token , "x-openbot-computer-token": options.computer.token }
            : {}),
        },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(SHOT_TIMEOUT),
      });
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mime = sniffImage(bytes);
      if (mime !== "image/jpeg" && mime !== "image/png") return null;
      return await storeAsset(bytes, mime);
    } catch {
      return null;
    }
  }

  function startScreenshot(key: string, preview: LinkPreview) {
    if (shotsRunning.has(key)) return;
    shotsRunning.add(key);
    void (async () => {
      const image = await screenshot(preview.finalUrl);
      const next: LinkPreview = {
        ...preview,
        image,
        imageKind: image ? "shot" : "none",
        imagePending: false,
      };
      await writeCache(key, preview.url, true, next).catch(() => {});
    })().finally(() => shotsRunning.delete(key));
  }

  /** 取不到网页时的兜底卡：标题 = 文件名（像下载链接时）或域名，图标 = 站点根目录 /favicon.ico。 */
  async function degradedPreview(
    url: string,
    key: string,
    finalUrl = url,
    reason = "fetch",
  ): Promise<LinkPreview> {
    const domain = displayDomain(url);
    const title = degradedTitle(url);
    let favicon: string | null = null;
    // 连不上 / 超时的站点，图标多半也取不到：不再白等一轮。
    if (reason !== "fetch") try {
      favicon = await fetchImage(
        new URL("/favicon.ico", url).toString(),
        ICON_MAX,
        true,
      );
    } catch {
      favicon = null;
    }
    const preview: LinkPreview = {
      url,
      finalUrl,
      title,
      siteName: "",
      domain,
      description: "",
      image: null,
      imageKind: "none",
      imagePending: false,
      favicon,
      degraded: true,
    };
    await writeCache(key, url, true, { ...preview, reason }, true).catch(
      () => {},
    );
    return preview;
  }

  async function build(url: string, key: string): Promise<LinkPreview | null> {
    let page: Awaited<ReturnType<typeof guardedFetch>>;
    try {
      page = await fetchUrl(url, {
        maxBytes: HTML_MAX,
        stopAfterBytes: HTML_STOP,
        timeoutMs: PAGE_TIMEOUT,
      });
    } catch (error) {
      if (error instanceof BlockedUrlError) {
        await writeCache(key, url, false, { error: "blocked" }).catch(() => {});
        return null;
      }
      return degradedPreview(url, key, url, "fetch");
    }
    if (page.status < 200 || page.status >= 400) {
      return degradedPreview(url, key, page.url, `status ${page.status}`);
    }
    // 卡片上的域名是用户发的那个链接的（跳到 sec.douban.com 验证页、GitHub 下载跳到存储域名，都不该换名字）。
    const domain = displayDomain(url);
    // 网址本身就是一张图：图就是预览。
    const directMime = sniffImage(page.body);
    if (
      page.contentType.startsWith("image/") ||
      (directMime && directMime !== "image/svg+xml")
    ) {
      const image =
        directMime && directMime !== "image/svg+xml" && !page.truncated
          ? await storeAsset(page.body, directMime)
          : null;
      const preview: LinkPreview = {
        url,
        finalUrl: page.url,
        title: directImageTitle(page.url),
        siteName: "",
        domain,
        description: "",
        image,
        imageKind: image ? "direct" : "none",
        imagePending: false,
        favicon: null,
      };
      await writeCache(key, url, true, preview, !image).catch(() => {});
      return preview;
    }
    const isHtml =
      page.contentType.includes("html") ||
      /<html|<head|<meta/i.test(page.body.subarray(0, 2048).toString("latin1"));
    if (!isHtml) {
      // 下载文件、PDF、接口……：兜底卡（标题是文件名），域名用原链接的（GitHub 下载会跳到别的存储域名）。
      return degradedPreview(url, key, page.url, "not-html");
    }
    const html = decodeHtml(page.contentType, page.body);
    const parsed = parsePage(html, page.url);
    // 反爬 / 验证页（sec.douban.com、百度安全验证、知乎 zse-ck、Cloudflare「Just a moment」）不是这个链接的内容。
    if (isChallengePage(url, page.url, parsed.title, html, page.status)) {
      return degradedPreview(url, key, page.url, "challenge");
    }
    // 200 但什么都没有（YouTube 给服务器的就是这样）：当兜底卡，30 分钟后再试，不按成功缓存一天。
    if (!parsed.title && !parsed.description && !parsed.image) {
      return degradedPreview(url, key, page.url, "empty");
    }
    const fallbacks = githubImageFallbacks(page.url);
    const [ogImage, favicon] = await Promise.all([
      parsed.image ? fetchPreviewImage(parsed.image, "og") : Promise.resolve(null),
      (async () => {
        for (const icon of parsed.icons) {
          const asset = await fetchImage(icon, ICON_MAX, true);
          if (asset) return asset;
        }
        return null;
      })(),
    ]);
    let image = ogImage;
    // GitHub 仓库 / release：og 图（opengraph.githubassets.com，按出口 IP 限流 100 次 / 15 分钟）没取到，
    // 先试同一仓库的固定地址（CDN 上常有现成的），再用仓库主人的头像。
    for (const candidate of image ? [] : fallbacks) {
      image = await fetchPreviewImage(candidate, "github-fallback");
      if (image) break;
    }
    const wantShot =
      !image && Boolean(options.computer) && options.screenshots === true;
    const preview: LinkPreview = {
      url,
      finalUrl: page.url,
      title: parsed.title || domain,
      siteName: parsed.siteName,
      domain,
      description: parsed.description,
      image,
      imageKind: image ? "og" : "none",
      imagePending: wantShot,
      favicon,
    };
    // 网页说有图但没取到（或只用了兜底图）：只缓存 30 分钟，过后再试真正的图，不让一次限流挂一整天。
    const imageMissed = Boolean(parsed.image || fallbacks.length) && !ogImage;
    await writeCache(key, url, true, preview, imageMissed).catch(() => {});
    if (wantShot) startScreenshot(key, preview);
    void prune().catch(() => {});
    return preview;
  }

  /** 读一个 JSON 接口（oEmbed、bilibili、百度百科开放接口），同样走 SSRF 检查；失败返回 null。 */
  async function fetchJson(url: string): Promise<unknown> {
    try {
      const res = await fetchUrl(url, {
        maxBytes: 256 * 1024,
        timeoutMs: PAGE_TIMEOUT,
        headers: { accept: "application/json" },
      });
      if (res.status < 200 || res.status >= 300) return null;
      return JSON.parse(res.body.toString("utf8"));
    } catch {
      return null;
    }
  }

  /**
   * 网页本身拿不到东西的几个站，用它们公开的接口：YouTube oEmbed、bilibili 视频信息、百度百科词条卡。
   * 接口失败返回 null，照常走网页那条路（最后多半是 30 分钟的兜底卡）。
   */
  async function buildFromApi(url: string, key: string): Promise<LinkPreview | null> {
    const source = apiSourceFor(url);
    if (!source) return null;
    const info = source.read(await fetchJson(source.api));
    if (!info?.title) return null;
    const image = info.image ? await fetchPreviewImage(info.image, source.kind ?? "api") : null;
    const preview: LinkPreview = {
      url,
      finalUrl: url,
      title: info.title,
      siteName: source.siteName,
      domain: displayDomain(url),
      description: info.description ?? "",
      image,
      imageKind: image ? "og" : "none",
      imagePending: false,
      favicon: null,
      ...(source.kind === "video" ? { kind: "video" as const } : {}),
    };
    await writeCache(key, url, true, preview, Boolean(info.image) && !image).catch(() => {});
    return preview;
  }

  async function previewFor(
    url: string,
  ): Promise<{ preview: LinkPreview | null; cached: boolean }> {
    const key = keyOf(url);
    const cached = await readCache(key);
    if (cached?.fresh) {
      const preview = cached.ok ? (cached.data as LinkPreview) : null;
      // 截图那一步如果因为重启丢了，补做。
      if (
        preview?.imagePending &&
        options.screenshots === true &&
        !shotsRunning.has(key)
      )
        startScreenshot(key, preview);
      return { preview, cached: true };
    }
    let job = inFlight.get(key);
    if (!job) {
      job = buildFromApi(url, key)
        .then((preview) => preview ?? build(url, key))
        .finally(() => inFlight.delete(key));
      inFlight.set(key, job);
    }
    return { preview: await job, cached: false };
  }

  /** 预览图的宽高（DESIGN.md §83.2）：缓存里存的预览不带，回答时按资源查（旧资源第一次现算）。 */
  async function withImageDims(preview: LinkPreview): Promise<LinkPreview> {
    const key = imageKeyForUrl(preview.image);
    if (!key) return preview;
    const size = (await imageDimsFor(database).lookup([key])).get(key);
    return size ? { ...preview, imageWidth: size.width, imageHeight: size.height } : preview;
  }

  function allow(userId: string): boolean {
    const now = Date.now();
    const recent = (rate.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= RATE_PER_MINUTE) {
      rate.set(userId, recent);
      return false;
    }
    recent.push(now);
    rate.set(userId, recent);
    return true;
  }

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    // 非 2xx 一律 no-store（包括登录校验的拒绝）：只有成功的预览才带 private, max-age=600。
    app.use("*", async (c, next) => {
      await next();
      if (c.res.status < 200 || c.res.status >= 300)
        c.header("cache-control", "no-store");
    });
    app.use("*", requireUser);
    app.get("/", async (c) => {
      const url = normalizePreviewUrl(c.req.query("url") ?? "");
      if (!url) return c.json({ error: "这个网址不能预览" }, 422);
      const key = keyOf(url);
      const cachedRow = await readCache(key);
      if (!cachedRow?.fresh && !inFlight.has(key) && !allow(c.var.actor.id)) {
        return c.json({ error: "预览请求太频繁，稍后再试" }, 429);
      }
      const { preview } = await previewFor(url);
      if (!preview) return c.json({ error: "这个网址没有可显示的预览" }, 422);
      return c.json({ preview: await withImageDims(preview) }, 200, {
        "cache-control": preview.imagePending
          ? "no-store"
          : "private, max-age=600",
      });
    });
    app.get("/asset/:id", async (c) => {
      const id = c.req.param("id");
      if (!ASSET_ID.test(id)) return c.json({ error: "没有这张图" }, 404);
      const rows = await database.$client.unsafe<
        { mime: string; data: Uint8Array }[]
      >(
        "UPDATE chisabot_link_preview_assets SET used_at = now() WHERE id = $1 RETURNING mime, data",
        [id],
      );
      const row = rows[0];
      if (!row) return c.json({ error: "没有这张图" }, 404);
      return new Response(Buffer.from(row.data), {
        headers: {
          "content-type": row.mime,
          "cache-control": "private, max-age=604800, immutable",
          "x-content-type-options": "nosniff",
          // svg 图标即使被直接打开也不能跑脚本。
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        },
      });
    });
    return app;
  }

  return { routes, previewFor };
}

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
};

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

export async function createLinkPreviews(
  database: Database,
  options: { computer?: ComputerTarget; screenshots?: boolean } = {},
) {
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

  /** 下载一张第三方图片存成本站资源；不是图片 / 太大 / 被拦都返回 null。 */
  async function fetchImage(
    url: string,
    max: number,
    allowSvg: boolean,
  ): Promise<string | null> {
    try {
      const res = await guardedFetch(url, {
        maxBytes: max,
        timeoutMs: IMAGE_TIMEOUT,
        headers: {
          accept:
            "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5",
        },
      });
      if (
        res.status < 200 ||
        res.status >= 300 ||
        res.truncated ||
        res.body.length === 0
      )
        return null;
      const mime = sniffImage(res.body);
      if (!mime || !IMAGE_MIME.test(mime)) return null;
      if (mime === "image/svg+xml" && !allowSvg) return null;
      return await storeAsset(res.body, mime);
    } catch {
      return null;
    }
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
      page = await guardedFetch(url, {
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
    const domain = displayDomain(page.url);
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
      const name = decodeURIComponent(
        new URL(page.url).pathname.split("/").pop() || domain,
      );
      const preview: LinkPreview = {
        url,
        finalUrl: page.url,
        title: name,
        siteName: "",
        domain,
        description: "",
        image,
        imageKind: image ? "direct" : "none",
        imagePending: false,
        favicon: null,
      };
      await writeCache(key, url, true, preview).catch(() => {});
      return preview;
    }
    const isHtml =
      page.contentType.includes("html") ||
      /<html|<head|<meta/i.test(page.body.subarray(0, 2048).toString("latin1"));
    if (!isHtml) {
      // 下载文件、PDF、接口……：兜底卡（标题是文件名），域名用原链接的（GitHub 下载会跳到别的存储域名）。
      return degradedPreview(url, key, page.url, "not-html");
    }
    const parsed = parsePage(decodeHtml(page.contentType, page.body), page.url);
    const [image, favicon] = await Promise.all([
      // og:image 偶尔第一次很慢（例如 GitHub 的图是现做的）：失败就再试一次，再不行才去截图。
      parsed.image
        ? fetchImage(parsed.image, IMAGE_MAX, false).then(
            (asset) =>
              asset ??
              (parsed.image
                ? fetchImage(parsed.image, IMAGE_MAX, false)
                : null),
          )
        : Promise.resolve(null),
      (async () => {
        for (const icon of parsed.icons) {
          const asset = await fetchImage(icon, ICON_MAX, true);
          if (asset) return asset;
        }
        return null;
      })(),
    ]);
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
    await writeCache(key, url, true, preview).catch(() => {});
    if (wantShot) startScreenshot(key, preview);
    void prune().catch(() => {});
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
      job = build(url, key).finally(() => inFlight.delete(key));
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

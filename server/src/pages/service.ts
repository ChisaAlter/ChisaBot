import { randomBytes, randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { BlockedUrlError, guardedFetch } from "../../../shared/net/guarded-fetch";
import {
  PAGE_ASSET_NAME,
  PAGE_ASSET_TYPES,
  PAGE_LIMITS,
  PAGE_SLUG,
  type PageAssetView,
  type PageVersionView,
  type PageView,
  pagePath,
} from "../../../shared/pages";
import type { AuditInitiator } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import { composePage, isFullDocument, notFoundPage, PAGE_TEMPLATE_GUIDE } from "./template";
import { reasonWithoutStatement } from "../db/query-failure";

/**
 * 页面（DESIGN.md §54，docs/pages.md）：机器人做的单页网页，发布在 /p/<随机串>/，不用登录就能看。
 *
 * 表（开机建，回滚安全）：
 * - chisabot_pages：一页一行（slug 16 位随机小写字母数字 ≈ 82 位熵，不公开列出）；
 * - chisabot_page_versions：每次改动一版（正文 HTML + 额外 CSS + 标题），保留最近 50 版，恢复 = 复制成新的一版；
 * - chisabot_page_assets：页面用到的图片等文件（bytea，每个 ≤ 8MB，每页 ≤ 40MB），页面里写 assets/<名字>；
 * - chisabot_page_origins：每个人的网页地址（浏览器告诉服务器 location.origin），用来给机器人完整链接。
 *
 * 安全：/p/ 下的每个响应都带 `Content-Security-Policy: sandbox …`（没有 allow-same-origin）——页面在一个
 * 不透明的源里跑，读不到 ChisaBot 的 Cookie / 本地存储，connect-src 'none' 连不了任何接口，form-action 'none'
 * 交不了表单。素材（含 svg）也带同样的头，直接打开也一样在沙箱里。
 */
export class PageError extends Error {}

type PageRow = {
  id: string;
  owner_user_id: string;
  agent_id: string | null;
  slug: string;
  title: string;
  description: string | null;
  published: boolean;
  current_version: number;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
  versions?: number | string;
  assets?: number | string;
};
type VersionRow = {
  page_id: string;
  version: number;
  title: string;
  html: string;
  css: string | null;
  note: string | null;
  created_at: Date | string;
};
type AssetRow = { page_id: string; name: string; type: string; bytes: number; data?: Uint8Array; created_at: Date | string };

const iso = (value: Date | string) => new Date(value).toISOString();
const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

const pageView = (row: PageRow): PageView => ({
  id: row.id,
  slug: row.slug,
  title: row.title,
  description: row.description,
  published: row.published,
  version: row.current_version,
  versions: Number(row.versions ?? 1),
  assets: Number(row.assets ?? 0),
  agentId: row.agent_id,
  path: pagePath(row.slug),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

export function newSlug() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(32);
  let out = "";
  for (const b of bytes) {
    if (b >= 252) continue; // 252 = 36 × 7：去掉取模偏差
    out += alphabet[b % 36];
    if (out.length === 16) return out;
  }
  return newSlug();
}

/** 把用户给的文件名变成安全的素材名：小写、只留字母数字 . _ -，保留扩展名。 */
export function assetName(raw: string) {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 60);
  const name = `${stem || "file"}.${ext}`;
  if (!PAGE_ASSET_TYPES[ext]) throw new PageError(`不支持的素材类型「.${ext || "?"}」。可以用：${Object.keys(PAGE_ASSET_TYPES).join("、")}。`);
  if (!PAGE_ASSET_NAME.test(name)) throw new PageError(`素材名「${raw}」不合适，换一个只含字母数字的名字。`);
  return name;
}

/** 按字节认常见图片 / 媒体，扩展名和内容对不上就拒绝（防止把 HTML 当图片塞进来）。 */
export function sniffMatches(name: string, bytes: Uint8Array) {
  const ext = name.slice(name.lastIndexOf(".") + 1);
  const head = (n: number) => Buffer.from(bytes.slice(0, n));
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  switch (ext) {
    case "png":
      return starts([0x89, 0x50, 0x4e, 0x47]);
    case "jpg":
    case "jpeg":
      return starts([0xff, 0xd8, 0xff]);
    case "gif":
      return head(4).toString("latin1") === "GIF8";
    case "webp":
      return head(4).toString("latin1") === "RIFF" && Buffer.from(bytes.slice(8, 12)).toString("latin1") === "WEBP";
    case "avif":
    case "mp4":
    case "m4a":
      return Buffer.from(bytes.slice(4, 8)).toString("latin1") === "ftyp";
    case "pdf":
      return head(5).toString("latin1") === "%PDF-";
    case "svg": {
      const text = head(2048).toString("utf8").trimStart().toLowerCase();
      return text.startsWith("<svg") || text.startsWith("<?xml") || text.startsWith("<!--") || text.startsWith("<!doctype svg");
    }
    default:
      return true;
  }
}

const escapeText = (text: string) => text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
/** 把第一个内容正好是旧标题的 <h1> 换成新标题（找不到就原样返回）。 */
export function syncHeading(html: string, from: string, to: string) {
  const match = /<h1(\s[^>]*)?>([\s\S]*?)<\/h1>/i.exec(html);
  if (!match) return html;
  const inner = match[2]!.trim();
  if (inner !== from && inner !== escapeText(from)) return html;
  return html.slice(0, match.index) + `<h1${match[1] ?? ""}>${escapeText(to)}</h1>` + html.slice(match.index + match[0].length);
}

/** 每个 /p/ 响应都带的头。 */
export const PAGE_CSP = [
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals",
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "frame-src https:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");
export function pageHeaders(type: string): Record<string, string> {
  return {
    "content-type": type,
    "content-security-policy": PAGE_CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()",
    "cache-control": "no-cache",
  };
}

const titleSchema = z.string().trim().min(1, "要有标题").max(80, "标题最多 80 个字");
const descriptionSchema = z.string().trim().max(200).optional().nullable();

export type ReadBotFile = (input: { ownerUserId: string; botId: string; path: string; initiator?: AuditInitiator }) => Promise<{ bytes: Uint8Array; name: string }>;
export type AssetSource = { name?: string | undefined; path?: string | undefined; url?: string | undefined };

export function createPages(
  database: Database,
  options: {
    /** 从机器人的工作区读文件（素材）。没有电脑的部署不给。 */
    readBotFile?: ReadBotFile;
    /** 部署固定的公网地址（CHISABOT_PUBLIC_URL），优先于浏览器报来的。 */
    publicUrl?: string | null;
    fetchImage?: (url: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
  } = {},
) {
  const sql = database.$client;

  async function ensure() {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_pages (
        id text PRIMARY KEY,
        owner_user_id text NOT NULL,
        agent_id text,
        slug text NOT NULL UNIQUE,
        title text NOT NULL,
        description text,
        published boolean NOT NULL DEFAULT true,
        current_version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS chisabot_pages_owner ON chisabot_pages (owner_user_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS chisabot_page_versions (
        page_id text NOT NULL REFERENCES chisabot_pages(id) ON DELETE CASCADE,
        version integer NOT NULL,
        title text NOT NULL,
        html text NOT NULL,
        css text,
        note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (page_id, version)
      );
      CREATE TABLE IF NOT EXISTS chisabot_page_assets (
        page_id text NOT NULL REFERENCES chisabot_pages(id) ON DELETE CASCADE,
        name text NOT NULL,
        type text NOT NULL,
        bytes integer NOT NULL,
        data bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (page_id, name)
      );
      CREATE TABLE IF NOT EXISTS chisabot_page_origins (
        owner_user_id text PRIMARY KEY,
        origin text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }

  const COUNTS = `(SELECT count(*) FROM chisabot_page_versions v WHERE v.page_id = p.id) AS versions,
    (SELECT count(*) FROM chisabot_page_assets a WHERE a.page_id = p.id) AS assets`;

  /** 删除超过 24 小时的已删页面（删除后 24 小时内可撤销）。 */
  async function purge() {
    await sql.unsafe("DELETE FROM chisabot_pages WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '24 hours'");
  }

  async function list(owner: string) {
    await purge().catch(() => {});
    const rows = await sql.unsafe<PageRow[]>(
      `SELECT p.*, ${COUNTS} FROM chisabot_pages p WHERE p.owner_user_id = $1 AND p.deleted_at IS NULL ORDER BY p.updated_at DESC`,
      [owner],
    );
    return rows.map(pageView);
  }

  async function row(owner: string, ref: string, includeDeleted = false) {
    const key = ref.trim();
    const slug = key.match(/\/p\/([a-z0-9]{16})/)?.[1] ?? key;
    const rows = await sql.unsafe<PageRow[]>(
      `SELECT p.*, ${COUNTS} FROM chisabot_pages p WHERE p.owner_user_id = $1 AND (p.id = $2 OR p.slug = $2) ${includeDeleted ? "" : "AND p.deleted_at IS NULL"}`,
      [owner, slug],
    );
    return rows[0] ?? null;
  }
  async function mustRow(owner: string, ref: string) {
    const found = await row(owner, ref);
    if (!found) throw new PageError(`找不到页面「${ref}」。用 page_list 看看有哪些。`);
    return found;
  }
  const get = async (owner: string, ref: string) => {
    const found = await row(owner, ref);
    return found ? pageView(found) : null;
  };

  async function version(pageId: string, n?: number) {
    const rows = n
      ? await sql.unsafe<VersionRow[]>("SELECT * FROM chisabot_page_versions WHERE page_id = $1 AND version = $2", [pageId, n])
      : await sql.unsafe<VersionRow[]>("SELECT * FROM chisabot_page_versions WHERE page_id = $1 ORDER BY version DESC LIMIT 1", [pageId]);
    return rows[0] ?? null;
  }

  async function versions(owner: string, ref: string): Promise<PageVersionView[]> {
    const page = await mustRow(owner, ref);
    const rows = await sql.unsafe<(VersionRow & { size: number })[]>(
      "SELECT version, title, note, created_at, octet_length(html) + coalesce(octet_length(css), 0) AS size FROM chisabot_page_versions WHERE page_id = $1 ORDER BY version DESC",
      [page.id],
    );
    return rows.map((r) => ({ version: r.version, title: r.title, note: r.note, bytes: Number(r.size), createdAt: iso(r.created_at), current: r.version === page.current_version }));
  }

  async function assets(owner: string, ref: string): Promise<PageAssetView[]> {
    const page = await mustRow(owner, ref);
    const rows = await sql.unsafe<AssetRow[]>("SELECT page_id, name, type, bytes, created_at FROM chisabot_page_assets WHERE page_id = $1 ORDER BY name", [page.id]);
    return rows.map((r) => ({ name: r.name, type: r.type, bytes: r.bytes, createdAt: iso(r.created_at) }));
  }

  function checkContent(html: string, css?: string | null) {
    if (!html.trim()) throw new PageError("页面内容是空的。");
    if (byteLength(html) > PAGE_LIMITS.htmlBytes) throw new PageError("页面 HTML 超过 1MB，太大了。图片请作为素材（assets）上传，不要内嵌 base64。");
    if (css && byteLength(css) > PAGE_LIMITS.cssBytes) throw new PageError("额外 CSS 超过 200KB。");
  }

  async function addVersion(pageId: string, input: { title: string; html: string; css?: string | null; note?: string | null }) {
    const [next] = await sql.unsafe<{ n: number }[]>("SELECT coalesce(max(version), 0) + 1 AS n FROM chisabot_page_versions WHERE page_id = $1", [pageId]);
    const n = Number(next!.n);
    await sql.unsafe("INSERT INTO chisabot_page_versions (page_id, version, title, html, css, note) VALUES ($1, $2, $3, $4, $5, $6)", [
      pageId,
      n,
      input.title,
      input.html,
      input.css?.trim() ? input.css : null,
      input.note?.trim() ? input.note.trim().slice(0, 200) : null,
    ]);
    await sql.unsafe("UPDATE chisabot_pages SET current_version = $2, title = $3, updated_at = now() WHERE id = $1", [pageId, n, input.title]);
    // 只留最近 50 版（当前版永远在）。
    await sql.unsafe("DELETE FROM chisabot_page_versions WHERE page_id = $1 AND version <= $2", [pageId, n - PAGE_LIMITS.versionsKept]);
    return n;
  }

  async function create(owner: string, input: { agentId?: string | null; title: string; description?: string | null; html: string; css?: string | null; published?: boolean }) {
    const title = titleSchema.parse(input.title);
    const description = descriptionSchema.parse(input.description) || null;
    checkContent(input.html, input.css);
    const [count] = await sql.unsafe<{ n: number }[]>("SELECT count(*)::int AS n FROM chisabot_pages WHERE owner_user_id = $1 AND deleted_at IS NULL", [owner]);
    if (Number(count?.n ?? 0) >= PAGE_LIMITS.pagesPerUser) throw new PageError(`页面已经有 ${PAGE_LIMITS.pagesPerUser} 个了，先在 设置 → 页面 里删掉一些。`);
    const id = `pg_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await sql.unsafe(
      "INSERT INTO chisabot_pages (id, owner_user_id, agent_id, slug, title, description, published, current_version) VALUES ($1, $2, $3, $4, $5, $6, $7, 0)",
      [id, owner, input.agentId ?? null, newSlug(), title, description, input.published ?? true],
    );
    await addVersion(id, { title, html: input.html, css: input.css ?? null, note: "创建" });
    return pageView((await row(owner, id))!);
  }

  /** 改一页：整页换 html，或者若干处「原文 → 新文」替换（原文必须在当前版里恰好出现一次）。 */
  async function update(
    owner: string,
    ref: string,
    input: { title?: string | null; description?: string | null; html?: string | null; css?: string | null; edits?: { find: string; replace: string }[]; note?: string | null },
  ) {
    const page = await mustRow(owner, ref);
    const current = await version(page.id, page.current_version);
    if (!current) throw new PageError("这个页面没有内容版本。");
    let html = input.html ?? current.html;
    for (const edit of input.edits ?? []) {
      if (!edit.find) throw new PageError("替换的原文不能是空的。");
      const first = html.indexOf(edit.find);
      if (first < 0) throw new PageError(`当前版里找不到这段原文：「${edit.find.slice(0, 80)}」。先用 page_get 看最新内容。`);
      if (html.indexOf(edit.find, first + 1) >= 0) throw new PageError(`这段原文出现了不止一次：「${edit.find.slice(0, 80)}」。多带一点上下文让它唯一。`);
      html = html.slice(0, first) + edit.replace + html.slice(first + edit.find.length);
    }
    const css = input.css === undefined || input.css === null ? current.css : input.css;
    const title = input.title ? titleSchema.parse(input.title) : page.title;
    // 换标题时，正文里第一个和旧标题一字不差的 <h1> 跟着换（机器人常常只改 title，页面上的大标题没变）。
    if (title !== page.title && !html.includes(title)) html = syncHeading(html, page.title, title);
    checkContent(html, css);
    const description = input.description === undefined || input.description === null ? undefined : descriptionSchema.parse(input.description) || null;
    if (description !== undefined) await sql.unsafe("UPDATE chisabot_pages SET description = $2 WHERE id = $1", [page.id, description]);
    const changed = html !== current.html || (css ?? null) !== (current.css ?? null) || title !== current.title;
    if (changed) await addVersion(page.id, { title, html, css, note: input.note ?? null });
    else await sql.unsafe("UPDATE chisabot_pages SET updated_at = now() WHERE id = $1", [page.id]);
    return { page: pageView((await row(owner, page.id))!), changed };
  }

  async function restore(owner: string, ref: string, n: number) {
    const page = await mustRow(owner, ref);
    const old = await version(page.id, n);
    if (!old) throw new PageError(`没有第 ${n} 版（只保留最近 ${PAGE_LIMITS.versionsKept} 版）。`);
    if (n === page.current_version) return pageView(page);
    await addVersion(page.id, { title: old.title, html: old.html, css: old.css, note: `恢复到第 ${n} 版` });
    return pageView((await row(owner, page.id))!);
  }

  async function setPublished(owner: string, ref: string, published: boolean) {
    const page = await mustRow(owner, ref);
    await sql.unsafe("UPDATE chisabot_pages SET published = $2, updated_at = now() WHERE id = $1", [page.id, published]);
    return pageView((await row(owner, page.id))!);
  }

  /** 删除：先软删（链接立刻失效），24 小时内可撤销，之后连素材一起清掉。 */
  async function remove(owner: string, ref: string) {
    const page = await row(owner, ref);
    if (!page) return false;
    await sql.unsafe("UPDATE chisabot_pages SET deleted_at = now() WHERE id = $1", [page.id]);
    return true;
  }
  async function undoRemove(owner: string, id: string) {
    const rows = await sql.unsafe<PageRow[]>("UPDATE chisabot_pages SET deleted_at = NULL WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NOT NULL RETURNING *", [id, owner]);
    return rows.length > 0;
  }

  async function putAsset(owner: string, ref: string, rawName: string, bytes: Uint8Array) {
    const page = await mustRow(owner, ref);
    const name = assetName(rawName);
    if (bytes.byteLength === 0) throw new PageError(`素材「${name}」是空文件。`);
    if (bytes.byteLength > PAGE_LIMITS.assetBytes) throw new PageError(`素材「${name}」超过 8MB。先压缩一下（比如缩小图片尺寸）。`);
    if (!sniffMatches(name, bytes)) throw new PageError(`素材「${name}」的内容和扩展名对不上。`);
    const [usage] = await sql.unsafe<{ n: number; total: number }[]>(
      "SELECT count(*)::int AS n, coalesce(sum(bytes), 0)::bigint AS total FROM chisabot_page_assets WHERE page_id = $1 AND name <> $2",
      [page.id, name],
    );
    if (Number(usage!.n) >= PAGE_LIMITS.assetsPerPage) throw new PageError(`一个页面最多 ${PAGE_LIMITS.assetsPerPage} 个素材。`);
    if (Number(usage!.total) + bytes.byteLength > PAGE_LIMITS.pageAssetBytes) throw new PageError("这个页面的素材加起来超过 40MB 了。");
    const ext = name.slice(name.lastIndexOf(".") + 1);
    await sql.unsafe(
      `INSERT INTO chisabot_page_assets (page_id, name, type, bytes, data) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (page_id, name) DO UPDATE SET type = EXCLUDED.type, bytes = EXCLUDED.bytes, data = EXCLUDED.data, created_at = now()`,
      [page.id, name, PAGE_ASSET_TYPES[ext]!, bytes.byteLength, Buffer.from(bytes)],
    );
    await sql.unsafe("UPDATE chisabot_pages SET updated_at = now() WHERE id = $1", [page.id]);
    return name;
  }
  async function deleteAsset(owner: string, ref: string, name: string) {
    const page = await mustRow(owner, ref);
    const rows = await sql.unsafe("DELETE FROM chisabot_page_assets WHERE page_id = $1 AND name = $2 RETURNING name", [page.id, name]);
    return rows.length > 0;
  }

  async function defaultFetchImage(url: string) {
    const response = await guardedFetch(url, { maxBytes: PAGE_LIMITS.assetBytes + 1, timeoutMs: 20_000 });
    if (response.status >= 400) throw new PageError(`下载素材失败（${response.status}）：${url}`);
    if (response.truncated) throw new PageError(`素材超过 8MB：${url}`);
    return { bytes: new Uint8Array(response.body), contentType: response.contentType };
  }

  /** 机器人给的素材：工作区文件（path）或公网图片（url）。 */
  async function ingest(owner: string, ref: string, botId: string | null, sources: AssetSource[], initiator?: AuditInitiator) {
    const saved: string[] = [];
    for (const source of sources) {
      if (source.path) {
        if (!options.readBotFile || !botId) throw new PageError("这个部署没有机器人工作区，素材请给公网图片网址（url）。");
        const file = await options.readBotFile({ ownerUserId: owner, botId, path: source.path, ...(initiator ? { initiator } : {}) });
        saved.push(await putAsset(owner, ref, source.name || file.name || source.path, file.bytes));
      } else if (source.url) {
        let fetched: { bytes: Uint8Array; contentType: string };
        try {
          fetched = await (options.fetchImage ?? defaultFetchImage)(source.url);
        } catch (error) {
          if (error instanceof PageError) throw error;
          if (error instanceof BlockedUrlError) throw new PageError(`不能从这个地址下载素材：${error.message}`);
          throw new PageError(`下载素材失败：${source.url}`);
        }
        let name = source.name || new URL(source.url).pathname.split("/").pop() || "image";
        if (!/\.[a-z0-9]+$/i.test(name)) {
          const ext = Object.entries(PAGE_ASSET_TYPES).find(([, type]) => fetched.contentType.startsWith(type.split(";")[0]!))?.[0];
          name = `${name}.${ext ?? "bin"}`;
        }
        saved.push(await putAsset(owner, ref, name, fetched.bytes));
      } else throw new PageError("每个素材要给 path（工作区文件）或 url（公网图片）。");
    }
    return saved;
  }

  async function originFor(owner: string) {
    if (options.publicUrl) return options.publicUrl.replace(/\/+$/, "");
    const rows = await sql.unsafe<{ origin: string }[]>("SELECT origin FROM chisabot_page_origins WHERE owner_user_id = $1", [owner]);
    return rows[0]?.origin ?? "";
  }
  async function setOrigin(owner: string, raw: string) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new PageError("网址不对。");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new PageError("网址不对。");
    await sql.unsafe(
      "INSERT INTO chisabot_page_origins (owner_user_id, origin) VALUES ($1, $2) ON CONFLICT (owner_user_id) DO UPDATE SET origin = EXCLUDED.origin, updated_at = now()",
      [owner, url.origin],
    );
    return url.origin;
  }
  const linkFor = async (owner: string, page: PageView) => `${await originFor(owner)}${page.path}`;

  /** 公开读：只认 slug，只给已发布、没删的。 */
  async function publicPage(slug: string) {
    if (!PAGE_SLUG.test(slug)) return null;
    const rows = await sql.unsafe<PageRow[]>("SELECT * FROM chisabot_pages WHERE slug = $1 AND published AND deleted_at IS NULL", [slug]);
    const page = rows[0];
    if (!page) return null;
    const current = await version(page.id, page.current_version);
    if (!current) return null;
    return composePage({ title: current.title, description: page.description, html: current.html, css: current.css });
  }
  async function publicAsset(slug: string, name: string) {
    if (!PAGE_SLUG.test(slug) || !PAGE_ASSET_NAME.test(name)) return null;
    const rows = await sql.unsafe<AssetRow[]>(
      `SELECT a.* FROM chisabot_page_assets a JOIN chisabot_pages p ON p.id = a.page_id
       WHERE p.slug = $1 AND p.published AND p.deleted_at IS NULL AND a.name = $2`,
      [slug, name],
    );
    return rows[0] ?? null;
  }

  /** /p/ 路由：不用登录。挂在 /p。 */
  function publicRoutes() {
    const app = new Hono();
    const notFound = () => new Response(notFoundPage(), { status: 404, headers: pageHeaders("text/html; charset=utf-8") });
    app.on(["GET", "HEAD"], "/:slug{[a-z0-9]{16}}", (c) => c.redirect(`/p/${c.req.param("slug")}/`, 301));
    app.on(["GET", "HEAD"], "/:slug{[a-z0-9]{16}}/", async (c) => {
      const html = await publicPage(c.req.param("slug"));
      if (html === null) return notFound();
      return new Response(c.req.method === "HEAD" ? null : html, { headers: pageHeaders("text/html; charset=utf-8") });
    });
    app.on(["GET", "HEAD"], "/:slug{[a-z0-9]{16}}/assets/:name", async (c) => {
      const asset = await publicAsset(c.req.param("slug"), c.req.param("name"));
      if (!asset?.data) return new Response("Not found", { status: 404, headers: pageHeaders("text/plain; charset=utf-8") });
      const data = asset.data instanceof Uint8Array ? asset.data : Buffer.from(asset.data as never);
      return new Response(c.req.method === "HEAD" ? null : (data as unknown as BodyInit), {
        headers: { ...pageHeaders(asset.type), "content-length": String(data.byteLength), "content-disposition": "inline" },
      });
    });
    app.all("*", () => notFound());
    return app;
  }

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);
    app.onError((error, c) => {
      if (error instanceof PageError) return c.json({ error: error.message }, 400);
      if (error instanceof z.ZodError) return c.json({ error: error.issues[0]?.message ?? "参数不对。" }, 400);
      console.error(JSON.stringify({ type: "pages-error", error: error.name, message: reasonWithoutStatement(error).slice(0, 200), route: c.req.path }));
      return c.json({ error: "页面服务暂时不可用，请重试。" }, 503);
    });
    const small = bodyLimit({ maxSize: 16_384 });
    app.get("/", async (c) => c.json({ pages: await list(c.var.actor.id), origin: await originFor(c.var.actor.id) }));
    app.put("/origin", small, async (c) => {
      const body = z.object({ origin: z.string().max(200) }).parse(await c.req.json());
      return c.json({ origin: await setOrigin(c.var.actor.id, body.origin) });
    });
    app.get("/:id", async (c) => {
      const page = await get(c.var.actor.id, c.req.param("id"));
      return page ? c.json({ page }) : c.json({ error: "找不到这个页面。" }, 404);
    });
    app.get("/:id/versions", async (c) => c.json({ versions: await versions(c.var.actor.id, c.req.param("id")) }));
    app.get("/:id/assets", async (c) => c.json({ assets: await assets(c.var.actor.id, c.req.param("id")) }));
    app.patch("/:id", small, async (c) => {
      const body = z.object({ title: z.string().optional(), description: z.string().nullable().optional(), published: z.boolean().optional() }).strict().parse(await c.req.json());
      const owner = c.var.actor.id;
      const id = c.req.param("id");
      if (body.title || body.description !== undefined) await update(owner, id, { title: body.title ?? null, ...(body.description !== undefined ? { description: body.description ?? "" } : {}), note: "改了标题" });
      if (body.published !== undefined) await setPublished(owner, id, body.published);
      return c.json({ page: await get(owner, id) });
    });
    app.post("/:id/restore", small, async (c) => {
      const body = z.object({ version: z.number().int().min(1) }).parse(await c.req.json());
      return c.json({ page: await restore(c.var.actor.id, c.req.param("id"), body.version) });
    });
    // ?purge=1 立刻连版本 / 素材一起删掉（不能撤销）；默认软删，24 小时内可撤销。
    app.delete("/:id", async (c) => {
      const owner = c.var.actor.id;
      const id = c.req.param("id");
      if (c.req.query("purge") === "1") {
        const rows = await sql.unsafe("DELETE FROM chisabot_pages WHERE owner_user_id = $1 AND (id = $2 OR slug = $2) RETURNING id", [owner, id]);
        return rows.length ? c.body(null, 204) : c.json({ error: "找不到这个页面。" }, 404);
      }
      return (await remove(owner, id)) ? c.body(null, 204) : c.json({ error: "找不到这个页面。" }, 404);
    });
    app.post("/:id/undo-delete", async (c) => ((await undoRemove(c.var.actor.id, c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "已经无法撤销。" }, 404)));
    // 上传素材：原始字节，文件名在 ?name=。
    app.put("/:id/assets", bodyLimit({ maxSize: PAGE_LIMITS.assetBytes + 1024 }), async (c) => {
      const name = c.req.query("name") ?? "";
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      return c.json({ name: await putAsset(c.var.actor.id, c.req.param("id"), name, bytes) }, 201);
    });
    app.delete("/:id/assets/:name", async (c) =>
      (await deleteAsset(c.var.actor.id, c.req.param("id"), c.req.param("name"))) ? c.body(null, 204) : c.json({ error: "找不到这个素材。" }, 404),
    );
    return app;
  }

  function tools(owner: string, agentId: string, initiator?: AuditInitiator): GrantedTool[] {
    const tool = <T extends z.ZodType>(name: string, description: string, parameters: T, run: (input: z.infer<T>) => Promise<string>): GrantedTool => ({
      name,
      ref: `pages/${name}`,
      description,
      parameters,
      async execute(args) {
        const parsed = parameters.safeParse(args);
        if (!parsed.success) return `${REFUSAL_MARKER} ${name} 参数不对：${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}`;
        try {
          return await run(parsed.data);
        } catch (error) {
          if (error instanceof PageError) return `${REFUSAL_MARKER} ${error.message}`;
          if (error instanceof z.ZodError) return `${REFUSAL_MARKER} ${error.issues[0]?.message ?? "参数不对。"}`;
          if (error instanceof Error && /file|path|workspace|文件|not found|refused|denied/i.test(error.message)) return `${REFUSAL_MARKER} 读不到素材文件：${error.message.slice(0, 200)}`;
          throw error;
        }
      },
    });
    const assetSchema = z
      .object({
        path: z.string().max(500).optional().describe("你工作区里的文件路径，如 images/cover.jpg"),
        url: z.string().max(2000).optional().describe("公网图片网址（会下载存进页面，不会热链）"),
        name: z.string().max(80).optional().describe("页面里用的名字，如 cover.jpg；页面里写 assets/cover.jpg"),
      })
      .strict();
    const done = async (page: PageView, what: string, extra = "") => {
      const link = await linkFor(owner, page);
      const full = /^https?:/.test(link);
      return `⟦page:${page.id}⟧ ${what}「${page.title}」（第 ${page.version} 版，${page.published ? "已发布" : "未发布"}）。链接：${link}${full ? "" : "（相对地址：在网页聊天的页面卡片上点「复制链接」拿完整地址）"}${extra}\n聊天里已经出现这个页面的卡片（缩略图、打开、复制链接）：回复里一两句话说明做了什么即可，不要再单独一行贴链接，也不要把 HTML 贴出来。`;
    };
    return [
      tool(
        "page_create",
        `做一个可以分享的单页网页（行程、邀请函、报告、作品集、菜单、活动页……），发布在不公开列出的链接上，任何拿到链接的人不用登录就能看；做好后聊天里会出现页面卡片。用户要「做个页面 / 网页 / 发给别人看的东西」时用；只是在聊天里展示数据用 render_ui，右栏常驻信息用面板。` +
          `页面在沙箱里打开：可以写内联 <script> 做交互，但连不了任何接口（没有 fetch），表单交不出去，所以内容要一次写全。图片等文件放进 assets（工作区文件或公网图片网址），页面里用相对地址 assets/名字 引用。` +
          PAGE_TEMPLATE_GUIDE +
          `内容要具体、真实、完整（日期、地点、时间、价格、联系方式都写上），不要占位文字；结构清楚、留白充足，一页讲一件事。`,
        z
          .object({
            title: z.string().min(1).max(80).describe("页面标题（浏览器标签和卡片上显示）"),
            description: z.string().max(200).optional().describe("一句话简介（分享预览用）"),
            html: z.string().min(1).describe("正文 HTML（用上面的类名，不用写 <html>/<head>）；完全自己设计时写完整文档"),
            css: z.string().optional().describe("追加的 CSS（可选）"),
            assets: z.array(assetSchema).max(PAGE_LIMITS.assetsPerPage).optional().describe("页面用到的图片等文件"),
            published: z.boolean().optional().describe("默认 true；用户说先别发出去时传 false"),
          })
          .strict(),
        async (input) => {
          let page = await create(owner, { agentId, title: input.title, description: input.description ?? null, html: input.html, css: input.css ?? null, published: input.published ?? true });
          let extra = "";
          if (input.assets?.length) {
            try {
              const saved = await ingest(owner, page.id, agentId, input.assets, initiator);
              extra = `\n素材：${saved.map((n) => `assets/${n}`).join("、")}。`;
            } catch (error) {
              extra = `\n⚠ 页面已发布，但素材没有全部存上：${error instanceof Error ? error.message : String(error)} 修好后用 page_update 的 assets 再传。`;
            }
            page = (await get(owner, page.id)) ?? page;
          }
          return done(page, "已做好", extra);
        },
      ),
      tool(
        "page_update",
        "改一个已有页面，每次改动存成新的一版（用户可以在 设置 → 页面 里恢复旧版）。换 title 时，正文里和旧标题一字不差的 <h1> 会自动跟着换；别的大标题写法要用 edits 改。小改用 edits（原文 → 新文，原文要在当前版里恰好出现一次）；大改传完整的新 html。也能换标题、追加 / 替换素材。改之前不确定内容就先 page_get。",
        z
          .object({
            page: z.string().describe("页面 id、slug 或链接"),
            edits: z.array(z.object({ find: z.string().min(1), replace: z.string() }).strict()).max(30).optional(),
            html: z.string().optional().describe("整页换成这份新正文"),
            css: z.string().optional().describe("整份替换追加的 CSS"),
            title: z.string().max(80).optional(),
            description: z.string().max(200).optional(),
            assets: z.array(assetSchema).max(PAGE_LIMITS.assetsPerPage).optional(),
            note: z.string().max(200).optional().describe("这一版改了什么（一句话）"),
          })
          .strict(),
        async (input) => {
          const target = await mustRow(owner, input.page);
          let extra = "";
          if (input.assets?.length) {
            const saved = await ingest(owner, target.id, agentId, input.assets, initiator);
            extra = `\n素材：${saved.map((n) => `assets/${n}`).join("、")}。`;
          }
          const { page, changed } = await update(owner, target.id, {
            title: input.title ?? null,
            ...(input.description !== undefined ? { description: input.description } : {}),
            html: input.html ?? null,
            css: input.css ?? null,
            edits: input.edits ?? [],
            note: input.note ?? null,
          });
          if (input.title && input.title.trim() !== target.title) {
            const current = await version(page.id, page.version);
            const body = current?.html ?? "";
            if (!body.includes(input.title.trim()) && body.includes(target.title))
              extra += `\n⚠ 只改了浏览器标签上的标题；页面正文里的大标题还是「${target.title}」。要一起改就再用 edits 把正文里的「${target.title}」换掉。`;
          }
          return done(page, changed ? "已更新" : input.assets?.length ? "已更新素材" : "内容没有变化", extra);
        },
      ),
      tool(
        "page_get",
        "读一个页面当前版的内容（正文 HTML、追加 CSS、素材列表），改之前用。",
        z.object({ page: z.string().describe("页面 id、slug 或链接") }).strict(),
        async (input) => {
          const page = await mustRow(owner, input.page);
          const current = await version(page.id, page.current_version);
          const files = await assets(owner, page.id);
          return [
            `页面「${page.title}」id ${page.id}，第 ${page.current_version} 版，${page.published ? "已发布" : "未发布"}，链接 ${await linkFor(owner, pageView(page))}`,
            `素材：${files.length ? files.map((f) => `assets/${f.name}`).join("、") : "无"}`,
            `外观：${current && isFullDocument(current.html) ? "完整文档（不套默认模板）" : "默认模板"}`,
            current?.css ? `追加 CSS：\n${current.css}` : "",
            `正文 HTML：\n${current?.html ?? ""}`,
          ]
            .filter(Boolean)
            .join("\n");
        },
      ),
      tool("page_list", "列出用户的页面（标题、状态、链接）。", z.object({}).strict(), async () => {
        const pages = await list(owner);
        if (!pages.length) return "还没有页面。";
        const origin = await originFor(owner);
        return pages.map((p) => `- ${p.title}（id ${p.id}，第 ${p.version} 版，${p.published ? "已发布" : "已下线"}）${origin}${p.path}`).join("\n");
      }),
      tool(
        "page_publish",
        "发布或下线一个页面。下线后链接打不开（内容保留，可以再发布）。",
        z.object({ page: z.string(), published: z.boolean() }).strict(),
        async (input) => {
          const page = await setPublished(owner, input.page, input.published);
          return done(page, input.published ? "已发布" : "已下线");
        },
      ),
      tool(
        "page_delete",
        "删除一个页面（链接立刻失效，连素材一起删）。只在用户明确要求删除时调用；只是不想让别人看到就用 page_publish 下线。",
        z.object({ page: z.string() }).strict(),
        async (input) => {
          const page = await mustRow(owner, input.page);
          await remove(owner, page.id);
          return `已删除「${page.title}」，链接已失效。`;
        },
      ),
    ];
  }

  return { ensure, list, get, create, update, restore, setPublished, remove, undoRemove, versions, assets, putAsset, deleteAsset, ingest, setOrigin, originFor, publicPage, publicAsset, publicRoutes, routes, tools, purge };
}
export type Pages = ReturnType<typeof createPages>;

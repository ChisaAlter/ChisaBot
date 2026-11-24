import { randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { canUseComputer } from "../agents/computer-access";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";

/**
 * 浏览器收藏夹（DESIGN.md §95，docs/browser-tabs.md）。
 *
 * 每个用户一份，这个用户所有机器人的浏览器共用（起始页上的常用网站 = 收藏夹前 12 个）。
 * 表 chisabot_browser_bookmarks + chisabot_browser_bookmark_seeds（开机 CREATE TABLE IF NOT EXISTS，
 * 只新增，回滚安全：旧镜像看不到这两张表，起始页回到默认五个网站）。
 * 第一次读收藏夹时种下起始页原来的五个网站（必应 / 百度 / GitHub / 维基百科 / 哔哩哔哩），记在 seeds 表里，
 * 用户全删光以后不会再种回来。
 *
 * 路由（全部要登录，只能动自己的）：
 *   GET    /api/browser-bookmarks              → { bookmarks: Bookmark[], max }
 *   POST   /api/browser-bookmarks              → { title?, url } 新增（同一网址已收藏就返回原来那条）
 *   PATCH  /api/browser-bookmarks/:id          → { title?, url? } 改名 / 改网址
 *   DELETE /api/browser-bookmarks/:id          → 删除
 *   PUT    /api/browser-bookmarks/order        → { ids: string[] } 调整顺序
 *   POST   /api/browser-bookmarks/sync/:botId  → 把收藏夹推给这个机器人的浏览器起始页（需具备该机器人的电脑访问权）
 */
export type Bookmark = { id: string; title: string; url: string; position: number };

export const MAX_BOOKMARKS = 100;
export const START_LINKS = 12;

export const SEED_BOOKMARKS: { title: string; url: string }[] = [
  { title: "必应", url: "https://www.bing.com/" },
  { title: "百度", url: "https://www.baidu.com/" },
  { title: "GitHub", url: "https://github.com/" },
  { title: "维基百科", url: "https://zh.wikipedia.org/" },
  { title: "哔哩哔哩", url: "https://www.bilibili.com/" },
];

export class BookmarkError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

/** 只收 http/https 网址；没写协议的补 https://。 */
export function normaliseBookmarkUrl(input: unknown): string {
  if (typeof input !== "string") throw new BookmarkError("请填写网址。");
  let value = input.trim();
  if (!value) throw new BookmarkError("请填写网址。");
  if (value.length > 2048) throw new BookmarkError("网址太长了。");
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BookmarkError("这不是一个能打开的网址。");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new BookmarkError("只能收藏网页（http 或 https）。");
  if (!parsed.hostname) throw new BookmarkError("这不是一个能打开的网址。");
  return parsed.toString();
}

export function normaliseBookmarkTitle(input: unknown, url: string): string {
  const raw = typeof input === "string" ? input.replace(/\s+/g, " ").trim() : "";
  if (raw) return Array.from(raw).slice(0, 80).join("");
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 80);
  }
}

type Row = { id: string; title: string; url: string; position: number };

export type BookmarkAgents = {
  get(actor: AgentActor, id: string): Promise<AgentProfile | null>;
};

export type BookmarkStartLinks = (
  botId: string,
  links: { title: string; url: string }[],
) => Promise<unknown>;

export function createBrowserBookmarks(
  database: Database,
  deps: {
    agents?: BookmarkAgents;
    canAccessComputer?: BotAccessCheck;
    pushStartLinks?: BookmarkStartLinks;
  } = {},
) {
  const sql = database.$client;

  async function ensure() {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_browser_bookmarks (
        id text PRIMARY KEY,
        user_id text NOT NULL,
        title text NOT NULL,
        url text NOT NULL,
        position integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await sql.unsafe(
      "CREATE INDEX IF NOT EXISTS chisabot_browser_bookmarks_user_idx ON chisabot_browser_bookmarks (user_id, position)",
    );
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_browser_bookmark_seeds (
        user_id text PRIMARY KEY,
        seeded_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }

  async function rows(userId: string): Promise<Bookmark[]> {
    const found = await sql.unsafe<Row[]>(
      "SELECT id, title, url, position FROM chisabot_browser_bookmarks WHERE user_id = $1 ORDER BY position, created_at",
      [userId],
    );
    return found.map((row) => ({ id: row.id, title: row.title, url: row.url, position: row.position }));
  }

  /** 第一次用：种下起始页原来的五个网站。seeds 表的主键保证并发两次只种一次。 */
  async function seedOnce(userId: string): Promise<void> {
    const claimed = await sql.unsafe<{ user_id: string }[]>(
      "INSERT INTO chisabot_browser_bookmark_seeds (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING RETURNING user_id",
      [userId],
    );
    if (claimed.length === 0) return;
    let position = 0;
    for (const seed of SEED_BOOKMARKS) {
      await sql.unsafe(
        "INSERT INTO chisabot_browser_bookmarks (id, user_id, title, url, position) VALUES ($1, $2, $3, $4, $5)",
        [`bm_${randomUUID().replace(/-/g, "").slice(0, 20)}`, userId, seed.title, seed.url, position],
      );
      position += 1;
    }
  }

  async function list(userId: string): Promise<Bookmark[]> {
    await seedOnce(userId);
    return rows(userId);
  }

  async function add(userId: string, input: { title?: unknown; url?: unknown }): Promise<Bookmark> {
    const url = normaliseBookmarkUrl(input.url);
    const title = normaliseBookmarkTitle(input.title, url);
    const existing = await list(userId);
    const same = existing.find((bookmark) => bookmark.url === url);
    if (same) return same;
    if (existing.length >= MAX_BOOKMARKS)
      throw new BookmarkError(`收藏夹最多 ${MAX_BOOKMARKS} 个，先删掉一些再收藏。`, 409);
    const position = existing.reduce((max, bookmark) => Math.max(max, bookmark.position), -1) + 1;
    const id = `bm_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await sql.unsafe(
      "INSERT INTO chisabot_browser_bookmarks (id, user_id, title, url, position) VALUES ($1, $2, $3, $4, $5)",
      [id, userId, title, url, position],
    );
    return { id, title, url, position };
  }

  async function update(userId: string, id: string, input: { title?: unknown; url?: unknown }): Promise<Bookmark> {
    const current = (await rows(userId)).find((bookmark) => bookmark.id === id);
    if (!current) throw new BookmarkError("找不到这个收藏。", 404);
    const url = input.url === undefined ? current.url : normaliseBookmarkUrl(input.url);
    const title = input.title === undefined ? current.title : normaliseBookmarkTitle(input.title, url);
    await sql.unsafe(
      "UPDATE chisabot_browser_bookmarks SET title = $3, url = $4, updated_at = now() WHERE id = $1 AND user_id = $2",
      [id, userId, title, url],
    );
    return { ...current, title, url };
  }

  async function remove(userId: string, id: string): Promise<void> {
    const deleted = await sql.unsafe<{ id: string }[]>(
      "DELETE FROM chisabot_browser_bookmarks WHERE id = $1 AND user_id = $2 RETURNING id",
      [id, userId],
    );
    if (deleted.length === 0) throw new BookmarkError("找不到这个收藏。", 404);
  }

  /** 按给的顺序排；没列出的放在后面，保持原来的相对顺序。 */
  async function reorder(userId: string, ids: unknown): Promise<Bookmark[]> {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
      throw new BookmarkError("顺序要是收藏 id 的列表。");
    const current = await rows(userId);
    const known = new Map(current.map((bookmark) => [bookmark.id, bookmark]));
    const ordered = [
      ...(ids as string[]).filter((id, index, all) => known.has(id) && all.indexOf(id) === index),
      ...current.map((bookmark) => bookmark.id).filter((id) => !(ids as string[]).includes(id)),
    ];
    let position = 0;
    for (const id of ordered) {
      await sql.unsafe(
        "UPDATE chisabot_browser_bookmarks SET position = $3, updated_at = now() WHERE id = $1 AND user_id = $2",
        [id, userId, position],
      );
      position += 1;
    }
    return rows(userId);
  }

  async function syncTo(actor: AgentActor, botId: string): Promise<{ ok: boolean; count: number }> {
    if ((!deps.canAccessComputer && !deps.agents) || !deps.pushStartLinks) {
      return { ok: false, count: 0 };
    }
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(botId)) throw new BookmarkError("找不到这个机器人。", 404);
    const allowed = deps.canAccessComputer
      ? await deps.canAccessComputer(actor, botId)
      : deps.agents
        ? canUseComputer(await deps.agents.get(actor, botId), actor)
        : false;
    if (!allowed) throw new BookmarkError("找不到这个机器人。", 404);
    const links = (await list(actor.id)).slice(0, START_LINKS).map(({ title, url }) => ({ title, url }));
    await deps.pushStartLinks(botId, links);
    return { ok: true, count: links.length };
  }

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);
    app.onError((error, c) => {
      if (error instanceof BookmarkError) return c.json({ error: error.message }, error.status);
      console.error("[browser-bookmarks]", error);
      return c.json({ error: "收藏夹没能处理，请稍后再试。" }, 500);
    });
    const body = async (c: { req: { json(): Promise<unknown> } }) =>
      ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    app.get("/", async (c) => c.json({ bookmarks: await list(c.var.actor.id), max: MAX_BOOKMARKS }));
    app.post("/", async (c) => c.json({ bookmark: await add(c.var.actor.id, await body(c)) }));
    app.put("/order", async (c) => c.json({ bookmarks: await reorder(c.var.actor.id, (await body(c)).ids) }));
    app.post("/sync/:botId", async (c) => {
      try {
        return c.json(await syncTo(c.var.actor, c.req.param("botId")));
      } catch (error) {
        if (error instanceof BookmarkError) throw error;
        // 浏览器没在运行 / 计算机暂时连不上：起始页下次打开时再同步，不算错。
        return c.json({ ok: false, count: 0 });
      }
    });
    app.patch("/:id", async (c) => c.json({ bookmark: await update(c.var.actor.id, c.req.param("id"), await body(c)) }));
    app.delete("/:id", async (c) => {
      await remove(c.var.actor.id, c.req.param("id"));
      return c.json({ ok: true });
    });
    return app;
  }

  return { ensure, list, add, update, remove, reorder, syncTo, routes };
}

export type BrowserBookmarks = ReturnType<typeof createBrowserBookmarks>;

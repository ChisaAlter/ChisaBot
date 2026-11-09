import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import sharp from "sharp";
import type { AppVariables } from "./auth/guards";
import type { Database } from "./db/client";

/**
 * 对话里的截图缩略图（computer_screenshot，2026-10-13 第四轮）。
 *
 * 第二轮只存在浏览器的 localStorage 里：换一台设备（或手机）打开同一会话只剩一行「截图」。现在浏览器截完
 * 把缩好的 JPEG 交给服务器，按「人」存（谁截的谁能看，别人拿到 id 也是 404），任何设备都显示同一张。
 *
 * - 不进模型上下文、不进会话记录：图片只在这张表里，对话里只有工具调用 id；
 * - 单张上限 {@link MAX_BYTES}；每人最多留 {@link KEEP_PER_OWNER} 张、最长 {@link KEEP_DAYS} 天，写入时顺手清理；
 * - 独立的表（启动时 CREATE TABLE IF NOT EXISTS），和本地会话表同一做法，不需要迁移。
 */
const MAX_BYTES = 400 * 1024;
const KEEP_PER_OWNER = 200;
const KEEP_DAYS = 30;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export async function createChatShots(database: Database) {
  await database.$client.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_chat_shots (
    id text NOT NULL, owner_user_id text NOT NULL, bot_id text, url text,
    mime text NOT NULL, data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_user_id, id)
  )`);
  await database.$client.unsafe(
    "CREATE INDEX IF NOT EXISTS chisabot_chat_shots_owner_created ON chisabot_chat_shots(owner_user_id, created_at DESC)",
  );

  async function prune(ownerUserId: string) {
    await database.$client.unsafe(
      `DELETE FROM chisabot_chat_shots WHERE owner_user_id = $1 AND (created_at < now() - $2 * interval '1 day' OR id IN (
         SELECT id FROM chisabot_chat_shots WHERE owner_user_id = $1 ORDER BY created_at DESC OFFSET $3))`,
      [ownerUserId, KEEP_DAYS, KEEP_PER_OWNER],
    );
  }

  /** 机器人被删时一起删（也给测试清理用）。 */
  async function removeForBot(ownerUserId: string, botId: string) {
    await database.$client.unsafe(
      "DELETE FROM chisabot_chat_shots WHERE owner_user_id = $1 AND bot_id = $2",
      [ownerUserId, botId],
    );
  }

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);
    app.put("/:id", async (c) => {
      const id = c.req.param("id");
      if (!ID.test(id)) return c.json({ error: "截图 id 不对" }, 400);
      const body = (await c.req.json().catch(() => null)) as {
        dataUrl?: unknown;
        botId?: unknown;
        url?: unknown;
      } | null;
      const match =
        typeof body?.dataUrl === "string"
          ? /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
              body.dataUrl,
            )
          : null;
      if (!match) return c.json({ error: "只收 JPEG / PNG / WebP 图片" }, 400);
      const bytes = Buffer.from(match[2]!, "base64");
      if (bytes.length === 0 || bytes.length > MAX_BYTES)
        return c.json({ error: "截图太大" }, 413);
      const botId =
        typeof body?.botId === "string" ? body.botId.slice(0, 200) : null;
      const url =
        typeof body?.url === "string" && /^(https?:|file:)/i.test(body.url)
          ? body.url.slice(0, 2000)
          : null;
      await database.$client.unsafe(
        `INSERT INTO chisabot_chat_shots (id, owner_user_id, bot_id, url, mime, data) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (owner_user_id, id) DO UPDATE SET bot_id = EXCLUDED.bot_id, url = EXCLUDED.url, mime = EXCLUDED.mime, data = EXCLUDED.data`,
        [id, c.var.actor.id, botId, url, match[1]!, bytes],
      );
      await prune(c.var.actor.id).catch(() => {});
      return c.json({ ok: true });
    });
    app.get("/:id", async (c) => {
      const id = c.req.param("id");
      if (!ID.test(id)) return c.json({ error: "没有这张截图" }, 404);
      const rows = await database.$client.unsafe<
        { mime: string; data: Uint8Array; url: string | null }[]
      >(
        "SELECT mime, data, url FROM chisabot_chat_shots WHERE owner_user_id = $1 AND id = $2",
        [c.var.actor.id, id],
      );
      const row = rows[0];
      if (!row) return c.json({ error: "没有这张截图" }, 404);
      return new Response(Buffer.from(row.data), {
        headers: {
          "content-type": row.mime,
          "cache-control": "private, max-age=86400",
          "x-content-type-options": "nosniff",
          ...(row.url ? { "x-shot-url": encodeURI(row.url) } : {}),
        },
      });
    });
    return app;
  }

  async function saveScreenshot(
    ownerUserId: string,
    botId: string,
    id: string,
    frame: { base64: string; url?: string },
  ) {
    if (!ID.test(id)) throw new Error("Invalid screenshot call identity.");
    const data = await sharp(Buffer.from(frame.base64, "base64"))
      .resize({ width: 960, withoutEnlargement: true })
      .jpeg({ quality: 76 })
      .toBuffer();
    if (data.length > MAX_BYTES)
      throw new Error("Screenshot exceeds the storage limit.");
    await database.$client.unsafe(
      `INSERT INTO chisabot_chat_shots(id,owner_user_id,bot_id,url,mime,data) VALUES($1,$2,$3,$4,'image/jpeg',$5)
      ON CONFLICT(owner_user_id,id) DO UPDATE SET data=EXCLUDED.data,url=EXCLUDED.url,mime=EXCLUDED.mime`,
      [id, ownerUserId, botId, frame.url ?? null, data],
    );
    await prune(ownerUserId);
    return { ok: true, shown: true, url: frame.url ?? null };
  }
  return { routes, removeForBot, prune, saveScreenshot };
}

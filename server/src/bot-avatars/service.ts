import { createHash } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  type BotAvatar,
  botAvatarImageUrl,
  isAvatarColor,
  isAvatarEmoji,
  isAvatarShape,
  isShapeColor,
  MAX_AVATAR_BYTES,
  sniffAvatarMime,
} from "../../../shared/bot-avatars";
import { canManageAgent } from "../agents/profile-policy";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";

/**
 * 机器人头像（DESIGN.md §81，docs/bot-avatars.md）。
 *
 * 表 chisabot_bot_avatars（开机 CREATE TABLE IF NOT EXISTS，回滚安全：旧镜像看不到这张表，机器人回到花纹头像）。
 * 一个机器人一行；图片字节存在库里（和聊天文件 §56 一样，跟着数据库卷和备份走）。没有行 = 默认花纹头像。
 * 机器人软删除时不删这一行（恢复后头像还在）；彻底清除留给 P5 的孤儿清理。
 *
 * 路由（全部要登录；读：能看到这个机器人的人；写：能修改这个机器人的人）：
 *   GET    /api/bot-avatars                 → { avatars: { [agentId]: BotAvatar } }（只含设置过的、你看得到的）
 *   GET    /api/bot-avatars/:agentId/image  → 图片字节（?v= 是版本，可长期缓存）
 *   PUT    /api/bot-avatars/:agentId        → JSON { kind: "emoji", emoji, color } | { kind: "monogram", color }
 *   PUT    /api/bot-avatars/:agentId/image  → 原始图片字节（PNG / JPEG / WebP，≤ 256 KB）
 *   DELETE /api/bot-avatars/:agentId        → 回到默认
 */
type Row = {
  agent_id: string;
  kind: "image" | "emoji" | "monogram" | "shape";
  emoji: string | null;
  color: string | null;
  shape?: string | null;
  mime: string | null;
  version: string;
};

export type BotAvatarAgents = {
  list(actor: AgentActor, hidden?: boolean): Promise<AgentProfile[]>;
  get(actor: AgentActor, id: string): Promise<AgentProfile | null>;
};

export class BotAvatarError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 413 = 400,
  ) {
    super(message);
  }
}

const AGENT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export function avatarView(row: Row): BotAvatar | null {
  if (row.kind === "image") return { kind: "image", url: botAvatarImageUrl(row.agent_id, row.version), version: row.version };
  if (row.kind === "shape") return isAvatarShape(row.shape) && isShapeColor(row.color) ? { kind: "shape", shape: row.shape, color: row.color } : null;
  if (!isAvatarColor(row.color)) return null;
  if (row.kind === "emoji") return row.emoji && isAvatarEmoji(row.emoji) ? { kind: "emoji", emoji: row.emoji, color: row.color } : null;
  return { kind: "monogram", color: row.color };
}

export function createBotAvatars(database: Database, agents: BotAvatarAgents) {
  const sql = database.$client;

  async function ensure() {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_bot_avatars (
        agent_id text PRIMARY KEY,
        kind text NOT NULL,
        emoji text,
        color text,
        shape text,
        image bytea,
        mime text,
        size_bytes integer,
        version text NOT NULL,
        updated_by text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE chisabot_bot_avatars ADD COLUMN IF NOT EXISTS shape text;
    `);
  }

  async function visible(actor: AgentActor, agentId: string): Promise<AgentProfile> {
    if (!AGENT_ID.test(agentId)) throw new BotAvatarError("找不到这个机器人。", 404);
    const agent = await agents.get(actor, agentId);
    if (!agent) throw new BotAvatarError("找不到这个机器人。", 404);
    return agent;
  }
  async function manageable(actor: AgentActor, agentId: string): Promise<AgentProfile> {
    const agent = await visible(actor, agentId);
    if (!canManageAgent(actor, agent)) throw new BotAvatarError("你不能修改这个机器人的头像。", 403);
    return agent;
  }

  async function listFor(actor: AgentActor): Promise<Record<string, BotAvatar>> {
    const [shown, hidden] = await Promise.all([agents.list(actor, false), agents.list(actor, true).catch(() => [])]);
    const ids = [...new Set([...shown, ...hidden].map((agent) => agent.id))];
    if (ids.length === 0) return {};
    const rows = await sql.unsafe<Row[]>(
      // bun:sql 不认 JS 数组参数：用逗号串传（机器人 id 里没有逗号，见 AGENT_ID）。
      "SELECT agent_id, kind, emoji, color, shape, mime, version FROM chisabot_bot_avatars WHERE agent_id = ANY(string_to_array($1::text, ','))",
      [ids.filter((id) => AGENT_ID.test(id)).join(",")],
    );
    const out: Record<string, BotAvatar> = {};
    for (const row of rows) {
      const view = avatarView(row);
      if (view) out[row.agent_id] = view;
    }
    return out;
  }

  async function read(agentId: string): Promise<BotAvatar | null> {
    const rows = await sql.unsafe<Row[]>(
      "SELECT agent_id, kind, emoji, color, shape, mime, version FROM chisabot_bot_avatars WHERE agent_id = $1",
      [agentId],
    );
    return rows[0] ? avatarView(rows[0]) : null;
  }

  async function setPreset(actor: AgentActor, agentId: string, input: unknown): Promise<BotAvatar> {
    await manageable(actor, agentId);
    const body = (input ?? {}) as { kind?: unknown; emoji?: unknown; color?: unknown; shape?: unknown };
    if (body.kind === "shape") {
      if (!isAvatarShape(body.shape)) throw new BotAvatarError("请选一个形状。");
      if (!isShapeColor(body.color)) throw new BotAvatarError("请选一种颜色。");
    } else {
      if (!isAvatarColor(body.color)) throw new BotAvatarError("请选一种底色。");
      if (body.kind === "emoji") {
        if (!isAvatarEmoji(body.emoji)) throw new BotAvatarError("请选一个表情。");
      } else if (body.kind !== "monogram") {
        throw new BotAvatarError("不支持这种头像。");
      }
    }
    const kind = body.kind;
    const emoji = kind === "emoji" ? (body.emoji as string) : null;
    const shape = kind === "shape" ? (body.shape as string) : null;
    const version = createHash("sha256").update(`${kind}:${emoji ?? ""}:${shape ?? ""}:${body.color}`).digest("hex").slice(0, 12);
    await sql.unsafe(
      `INSERT INTO chisabot_bot_avatars (agent_id, kind, emoji, color, shape, image, mime, size_bytes, version, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $7, NULL, NULL, NULL, $5, $6, now())
       ON CONFLICT (agent_id) DO UPDATE SET kind = $2, emoji = $3, color = $4, shape = $7, image = NULL, mime = NULL, size_bytes = NULL,
         version = $5, updated_by = $6, updated_at = now()`,
      [agentId, kind, emoji, body.color, version, actor.id, shape],
    );
    return (await read(agentId))!;
  }

  async function setImage(actor: AgentActor, agentId: string, bytes: Uint8Array): Promise<BotAvatar> {
    await manageable(actor, agentId);
    if (bytes.length === 0) throw new BotAvatarError("没有收到图片。");
    if (bytes.length > MAX_AVATAR_BYTES) throw new BotAvatarError("图片太大了（最多 256 KB）。", 413);
    const mime = sniffAvatarMime(bytes);
    if (!mime) throw new BotAvatarError("只支持 PNG、JPEG 或 WebP 图片。");
    const version = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    await sql.unsafe(
      `INSERT INTO chisabot_bot_avatars (agent_id, kind, emoji, color, image, mime, size_bytes, version, updated_by, updated_at)
       VALUES ($1, 'image', NULL, NULL, $2, $3, $4, $5, $6, now())
       ON CONFLICT (agent_id) DO UPDATE SET kind = 'image', emoji = NULL, color = NULL, shape = NULL, image = $2, mime = $3, size_bytes = $4,
         version = $5, updated_by = $6, updated_at = now()`,
      [agentId, Buffer.from(bytes), mime, bytes.length, version, actor.id],
    );
    return (await read(agentId))!;
  }

  async function clear(actor: AgentActor, agentId: string): Promise<void> {
    await manageable(actor, agentId);
    await sql.unsafe("DELETE FROM chisabot_bot_avatars WHERE agent_id = $1", [agentId]);
  }

  async function image(actor: AgentActor, agentId: string): Promise<{ bytes: Buffer; mime: string; version: string } | null> {
    await visible(actor, agentId);
    const rows = await sql.unsafe<{ image: Buffer | null; mime: string | null; version: string }[]>(
      "SELECT image, mime, version FROM chisabot_bot_avatars WHERE agent_id = $1 AND kind = 'image'",
      [agentId],
    );
    const row = rows[0];
    return row?.image && row.mime ? { bytes: Buffer.from(row.image), mime: row.mime, version: row.version } : null;
  }

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);
    app.onError((error, c) => {
      if (error instanceof BotAvatarError) return c.json({ error: error.message }, error.status);
      console.error("[bot-avatars]", error);
      return c.json({ error: "头像没能处理，请稍后再试。" }, 500);
    });
    app.get("/", async (c) => c.json({ avatars: await listFor(c.var.actor) }));
    app.get("/:agentId/image", async (c) => {
      const found = await image(c.var.actor, c.req.param("agentId"));
      if (!found) return c.json({ error: "这个机器人没有上传头像。" }, 404);
      const fresh = c.req.query("v") === found.version;
      return new Response(c.req.method === "HEAD" ? null : new Uint8Array(found.bytes), {
        headers: {
          "content-type": found.mime,
          "content-length": String(found.bytes.length),
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox; default-src 'none'",
          etag: `"${found.version}"`,
          // 带对版本号的网址内容永远不变；不带或版本旧了就每次问。
          "cache-control": fresh ? "private, max-age=31536000, immutable" : "private, no-cache",
        },
      });
    });
    app.put(
      "/:agentId/image",
      bodyLimit({ maxSize: MAX_AVATAR_BYTES, onError: (c) => c.json({ error: "图片太大了（最多 256 KB）。" }, 413) }),
      async (c) => {
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        return c.json({ avatar: await setImage(c.var.actor, c.req.param("agentId"), bytes) });
      },
    );
    app.put("/:agentId", bodyLimit({ maxSize: 4096 }), async (c) =>
      c.json({ avatar: await setPreset(c.var.actor, c.req.param("agentId"), await c.req.json().catch(() => null)) }),
    );
    app.delete("/:agentId", async (c) => {
      await clear(c.var.actor, c.req.param("agentId"));
      return c.body(null, 204);
    });
    return app;
  }

  return { ensure, listFor, read, setPreset, setImage, clear, image, routes };
}

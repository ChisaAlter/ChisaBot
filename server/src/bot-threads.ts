import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "./auth/guards";
import type { Database } from "./db/client";

/**
 * 全端同步（2026-10-13，DESIGN.md §42）：每个人和每个机器人的「当前对话」存在服务器上。
 *
 * 以前机器人聊天用哪条对话只记在浏览器的 localStorage 里（`legacy bot-thread storage <agentId>`），网页、装成应用的
 * PWA、PC 客户端、安卓客户端各有各的 localStorage，于是同一个机器人在每台设备上都是另一段对话。对话本身
 * （chisabot_local_threads / events）早就在服务器上、按人存，缺的只是「现在用的是哪一条」。
 *
 * - `GET  /api/bot-threads/:agentId`        → `{ threadId | null, updatedAt }`
 * - `PUT  /api/bot-threads/:agentId`        `{ threadId, onlyIfNone? }` → 设成当前对话（「新对话」/ 迁移）。
 *   `onlyIfNone`：只有服务器还没有记录时才写（第一次打开时把这台浏览器原来的对话接过来；两台设备同时迁移，
 *   先到的赢，后到的拿回先到的那条）。
 * - `GET  /api/bot-threads/:agentId/history` → 这个人和这个机器人的对话列表（「历史对话」，最近 30 条：
 *   标题 = 对话名或第一条用户消息、消息数、最后更新时间）。共用一条当前对话后，一台设备原来的对话就看不到了，
 *   从这里切回去（切换 = PUT 当前对话）。不含后台任务的隐藏对话（worker-*）和空对话。
 * - `GET  /api/bot-threads/:agentId/sync?threadId=` → 当前对话 + 这条对话的变化戳（事件序号、是否在回答、
 *   后台任务和收件箱最后更新时间、截断版本 revision §67）。打开的设备每 2 秒问一次（页面隐藏时不问，回到前台马上问），变了才去拉。
 *
 * 一个人一行（owner_user_id + agent_id），只存 id；对话从不因为这里被删（换「新对话」后旧对话还在库里）。
 * 只认属于自己的对话：库里已有这条对话但不是自己的（或不是这个机器人的）→ 404。还没发过消息的新对话
 * （刚铸出来、库里没有行）照样可以是当前对话——它就是一段空对话。
 */
const THREAD_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const AGENT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export type BotThreadRunControl = { isActive(threadId: string): boolean };

export type BotThreadActivity = {
  threadId: string;
  /** 这条对话最后一个已存事件的序号（字符串，bigint）。"0" = 还没有事件。 */
  seq: string;
  running: boolean;
  /** 后台任务卡片最后一次变化（ISO），没有任务为 null。 */
  workers: string | null;
  /** 收件箱（排队消息）最后一次变化（ISO），没有为 null。 */
  inbox: string | null;
  /** 对话版本：重新生成 / 编辑后重发截断过几次（DESIGN.md §67）。变了 = 别的设备该按服务器回放重建。 */
  revision: string;
};

export type BotThreadSummary = {
  threadId: string;
  title: string;
  messages: number;
  updatedAt: string | null;
};

/** 用户消息的文字：字符串，或 [{type:"text", text}] 这样的分段。 */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        part &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join(" ");
  return "";
}

/** 标题：去掉 IM 渠道来源头，压成一行，最多 60 个字。 */
export function clipTitle(text: string | null | undefined): string {
  const stripped = (text ?? "").replace(/^［经[^\n]+?］\r?\n/, "");
  const line = stripped.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

type CurrentRow = { thread_id: string; updated_at: Date | string };

const iso = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString() : null;

export async function createBotThreads(
  database: Database,
  control?: BotThreadRunControl,
) {
  const sql = database.$client;
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_bot_threads (
    owner_user_id text NOT NULL, agent_id text NOT NULL, thread_id text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_user_id, agent_id)
  )`);

  async function current(ownerUserId: string, agentId: string) {
    const rows = await sql.unsafe<CurrentRow[]>(
      "SELECT thread_id, updated_at FROM chisabot_bot_threads WHERE owner_user_id = $1 AND agent_id = $2",
      [ownerUserId, agentId],
    );
    const row = rows[0];
    return row
      ? { threadId: row.thread_id, updatedAt: iso(row.updated_at) }
      : null;
  }

  /** 库里有这条对话时它必须是这个人、这个机器人的；没有（还没发过消息）也行。 */
  async function mayUse(
    ownerUserId: string,
    agentId: string,
    threadId: string,
  ): Promise<boolean> {
    try {
      const rows = await sql.unsafe<
        { owner_user_id: string; agent_id: string }[]
      >(
        "SELECT owner_user_id, agent_id FROM chisabot_local_threads WHERE id = $1",
        [threadId],
      );
      const row = rows[0];
      return (
        !row || (row.owner_user_id === ownerUserId && row.agent_id === agentId)
      );
    } catch {
      // 不是本地会话模式（没有这张表）：对话在别处，按 id 记下即可。
      return true;
    }
  }

  async function setCurrent(
    ownerUserId: string,
    agentId: string,
    threadId: string,
    onlyIfNone: boolean,
  ) {
    await sql.unsafe(
      onlyIfNone
        ? `INSERT INTO chisabot_bot_threads (owner_user_id, agent_id, thread_id) VALUES ($1, $2, $3)
           ON CONFLICT (owner_user_id, agent_id) DO NOTHING`
        : `INSERT INTO chisabot_bot_threads (owner_user_id, agent_id, thread_id) VALUES ($1, $2, $3)
           ON CONFLICT (owner_user_id, agent_id) DO UPDATE SET thread_id = EXCLUDED.thread_id, updated_at = now()`,
      [ownerUserId, agentId, threadId],
    );
    return current(ownerUserId, agentId);
  }

  async function activity(
    ownerUserId: string,
    threadId: string,
  ): Promise<BotThreadActivity | null> {
    let owner: string | null = null;
    let locked = false;
    let seq = "0";
    let inbox: string | null = null;
    try {
      const rows = await sql.unsafe<
        {
          owner: string | null;
          locked: boolean | null;
          seq: string | null;
          inbox: Date | null;
        }[]
      >(
        `SELECT
           (SELECT owner_user_id FROM chisabot_local_threads WHERE id = $1) AS owner,
           (SELECT run_id IS NOT NULL AND lock_expires_at > now() FROM chisabot_local_threads WHERE id = $1) AS locked,
           (SELECT max(sequence)::text FROM chisabot_local_events WHERE thread_id = $1) AS seq,
           (SELECT max(updated_at) FROM chisabot_thread_inbox WHERE thread_id = $1) AS inbox`,
        [threadId],
      );
      const row = rows[0];
      owner = row?.owner ?? null;
      locked = Boolean(row?.locked);
      seq = row?.seq ?? "0";
      inbox = iso(row?.inbox);
    } catch {
      return null;
    }
    // 别人的对话：什么都不说（和对话接口一样当作不存在）。
    if (owner && owner !== ownerUserId) return null;
    let workers: string | null = null;
    try {
      const rows = await sql.unsafe<{ at: Date | null }[]>(
        "SELECT max(updated_at) AS at FROM chisabot_workers WHERE parent_thread_id = $1 AND owner_user_id = $2",
        [threadId, ownerUserId],
      );
      workers = iso(rows[0]?.at);
    } catch {
      // 后台任务没启用（没有这张表）。
    }
    let revision = "0";
    try {
      const rows = await sql.unsafe<{ n: string | null }[]>(
        "SELECT count(*)::text AS n FROM chisabot_thread_truncations WHERE thread_id = $1",
        [threadId],
      );
      revision = rows[0]?.n ?? "0";
    } catch {
      // 截断没启用（没有这张表）。
    }
    return {
      threadId,
      seq,
      running: Boolean(control?.isActive(threadId)) || locked,
      workers,
      inbox,
      revision,
    };
  }

  /** 「历史对话」（DESIGN.md §42.6）：最近 30 条有消息的对话，新的在前。 */
  async function history(
    ownerUserId: string,
    agentId: string,
  ): Promise<BotThreadSummary[]> {
    try {
      const rows = await sql.unsafe<
        {
          id: string;
          name: string | null;
          first: unknown;
          count: number;
          updated_at: Date | string;
        }[]
      >(
        `SELECT id, name, jsonb_array_length(messages) AS count, updated_at,
           (SELECT m->'content' FROM jsonb_array_elements(messages) m WHERE m->>'role' = 'user' LIMIT 1) AS first
         FROM chisabot_local_threads
         WHERE owner_user_id = $1 AND agent_id = $2 AND id NOT LIKE 'worker-%' AND id NOT LIKE 'im-%' AND jsonb_array_length(messages) > 0
         ORDER BY updated_at DESC LIMIT 30`,
        [ownerUserId, agentId],
      );
      return rows.map((row) => ({
        threadId: row.id,
        title:
          clipTitle(row.name) ||
          clipTitle(textOf(row.first)) ||
          "（没有文字的对话）",
        messages: Number(row.count) || 0,
        updatedAt: iso(row.updated_at),
      }));
    } catch {
      // 不是本地会话模式：没有可列的对话。
      return [];
    }
  }

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);
    app.get("/:agentId", async (c) => {
      const agentId = c.req.param("agentId");
      if (!AGENT_ID.test(agentId))
        return c.json({ error: "机器人 id 不对" }, 400);
      const row = await current(c.var.actor.id, agentId);
      return c.json(row ?? { threadId: null, updatedAt: null });
    });
    app.put("/:agentId", async (c) => {
      const agentId = c.req.param("agentId");
      if (!AGENT_ID.test(agentId))
        return c.json({ error: "机器人 id 不对" }, 400);
      const body = (await c.req.json().catch(() => null)) as {
        threadId?: unknown;
        onlyIfNone?: unknown;
      } | null;
      const threadId = typeof body?.threadId === "string" ? body.threadId : "";
      if (!THREAD_ID.test(threadId))
        return c.json({ error: "对话 id 不对" }, 400);
      if (!(await mayUse(c.var.actor.id, agentId, threadId)))
        return c.json({ error: "没有这条对话" }, 404);
      const row = await setCurrent(
        c.var.actor.id,
        agentId,
        threadId,
        body?.onlyIfNone === true,
      );
      return c.json(row ?? { threadId, updatedAt: null });
    });
    app.get("/:agentId/history", async (c) => {
      const agentId = c.req.param("agentId");
      if (!AGENT_ID.test(agentId))
        return c.json({ error: "机器人 id 不对" }, 400);
      c.header("Cache-Control", "no-store");
      return c.json({ threads: await history(c.var.actor.id, agentId) });
    });
    app.get("/:agentId/sync", async (c) => {
      const agentId = c.req.param("agentId");
      if (!AGENT_ID.test(agentId))
        return c.json({ error: "机器人 id 不对" }, 400);
      const threadId = c.req.query("threadId") ?? "";
      const [row, thread] = await Promise.all([
        current(c.var.actor.id, agentId),
        THREAD_ID.test(threadId)
          ? activity(c.var.actor.id, threadId)
          : Promise.resolve(null),
      ]);
      c.header("Cache-Control", "no-store");
      return c.json({ current: row, thread });
    });
    return app;
  }

  return { routes, current, setCurrent, activity, history };
}

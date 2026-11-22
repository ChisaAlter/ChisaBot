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

const MISSING_TABLE_RETRY_MS = 60_000;

type TablePresenceState =
  | { status: "unknown" }
  | { status: "present" }
  | { status: "missing"; retryAt: number };

type BotThreadTableCache = {
  localThreads: TablePresenceState;
  workers: TablePresenceState;
  truncations: TablePresenceState;
};

/** 进程级（按 DB 客户端隔离，避免测试间串态）可选表存在性缓存，消除 2s `/sync` 重复探测。 */
const tableCacheByClient = new WeakMap<object, BotThreadTableCache>();

function getTableCache(client: object): BotThreadTableCache {
  let cache = tableCacheByClient.get(client);
  if (!cache) {
    cache = {
      localThreads: { status: "unknown" },
      workers: { status: "unknown" },
      truncations: { status: "unknown" },
    };
    tableCacheByClient.set(client, cache);
  }
  return cache;
}

function isKnownMissing(state: TablePresenceState, now: number): boolean {
  return state.status === "missing" && now < state.retryAt;
}

function isResolvedState(state: TablePresenceState, now: number): boolean {
  return (
    state.status === "present" ||
    (state.status === "missing" && now < state.retryAt)
  );
}

function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as { code?: unknown }).code === "42P01") return true;
  const message =
    error instanceof Error
      ? error.message
      : String((error as { message?: unknown }).message ?? "");
  return /does not exist|no such table/i.test(message);
}

export async function createBotThreads(
  database: Database,
  control?: BotThreadRunControl,
) {
  const sql = database.$client;
  const tableCache = getTableCache(sql as object);
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
    const now = Date.now();
    if (isKnownMissing(tableCache.localThreads, now)) return true;
    try {
      const rows = await sql.unsafe<
        { owner_user_id: string; agent_id: string }[]
      >(
        "SELECT owner_user_id, agent_id FROM chisabot_local_threads WHERE id = $1",
        [threadId],
      );
      tableCache.localThreads = { status: "present" };
      const row = rows[0];
      return (
        !row || (row.owner_user_id === ownerUserId && row.agent_id === agentId)
      );
    } catch (error) {
      if (isMissingTableError(error)) {
        tableCache.localThreads = {
          status: "missing",
          retryAt: now + MISSING_TABLE_RETRY_MS,
        };
      }
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
    const now = Date.now();
    if (isKnownMissing(tableCache.localThreads, now)) return null;

    // 热路径：各可选表存在性已缓存时，合并为单条 SQL（仅 1 次连接借用与 1 次 RTT）。
    if (
      tableCache.localThreads.status === "present" &&
      isResolvedState(tableCache.workers, now) &&
      isResolvedState(tableCache.truncations, now)
    ) {
      const includeWorkers = tableCache.workers.status === "present";
      const includeTruncations = tableCache.truncations.status === "present";
      try {
        const rows = await sql.unsafe<
          {
            owner: string | null;
            locked: boolean | null;
            seq: string | null;
            inbox: Date | null;
            workers: Date | null;
            revision: string | null;
          }[]
        >(
          `SELECT
             t.owner_user_id AS owner,
             (t.run_id IS NOT NULL AND t.lock_expires_at > now()) AS locked,
             CASE WHEN t.owner_user_id IS NOT NULL AND t.owner_user_id <> $2 THEN NULL
                  ELSE (SELECT max(sequence)::text FROM chisabot_local_events WHERE thread_id = $1) END AS seq,
             CASE WHEN t.owner_user_id IS NOT NULL AND t.owner_user_id <> $2 THEN NULL
                  ELSE (SELECT max(updated_at) FROM chisabot_thread_inbox WHERE thread_id = $1) END AS inbox,
             ${
               includeWorkers
                 ? "CASE WHEN t.owner_user_id IS NOT NULL AND t.owner_user_id <> $2 THEN NULL ELSE (SELECT max(updated_at) FROM chisabot_workers WHERE parent_thread_id = $1 AND owner_user_id = $2) END"
                 : "NULL::timestamptz"
             } AS workers,
             ${
               includeTruncations
                 ? "CASE WHEN t.owner_user_id IS NOT NULL AND t.owner_user_id <> $2 THEN NULL ELSE (SELECT count(*)::text FROM chisabot_thread_truncations WHERE thread_id = $1) END"
                 : "'0'::text"
             } AS revision
           FROM (VALUES ($1::text)) AS q(id)
           LEFT JOIN chisabot_local_threads t ON t.id = q.id`,
          [threadId, ownerUserId],
        );
        const row = rows[0];
        const owner = row?.owner ?? null;
        if (owner && owner !== ownerUserId) return null;
        return {
          threadId,
          seq: row?.seq ?? "0",
          running: Boolean(control?.isActive(threadId)) || Boolean(row?.locked),
          workers: iso(row?.workers),
          inbox: iso(row?.inbox),
          revision: row?.revision ?? "0",
        };
      } catch (error) {
        if (!isMissingTableError(error)) return null;
        // 若表结构在运行期变动，重置缓存并回退到分表并发探测路径。
        tableCache.localThreads = { status: "unknown" };
        tableCache.workers = { status: "unknown" };
        tableCache.truncations = { status: "unknown" };
      }
    }

    // 首次或缓存刷新路径：并行查询主表与可选表，同时缓存表存在性。
    const corePromise = sql
      .unsafe<
        {
          owner: string | null;
          locked: boolean | null;
          seq: string | null;
          inbox: Date | null;
        }[]
      >(
        `SELECT
           t.owner_user_id AS owner,
           (t.run_id IS NOT NULL AND t.lock_expires_at > now()) AS locked,
           (SELECT max(sequence)::text FROM chisabot_local_events WHERE thread_id = $1) AS seq,
           (SELECT max(updated_at) FROM chisabot_thread_inbox WHERE thread_id = $1) AS inbox
         FROM (VALUES ($1::text)) AS q(id)
         LEFT JOIN chisabot_local_threads t ON t.id = q.id`,
        [threadId],
      )
      .then((rows) => {
        tableCache.localThreads = { status: "present" };
        return { ok: true as const, row: rows[0] };
      })
      .catch((error: unknown) => {
        if (isMissingTableError(error)) {
          tableCache.localThreads = {
            status: "missing",
            retryAt: now + MISSING_TABLE_RETRY_MS,
          };
        }
        return { ok: false as const, row: undefined };
      });

    const workersPromise = isKnownMissing(tableCache.workers, now)
      ? Promise.resolve<string | null>(null)
      : sql
          .unsafe<{ at: Date | null }[]>(
            "SELECT max(updated_at) AS at FROM chisabot_workers WHERE parent_thread_id = $1 AND owner_user_id = $2",
            [threadId, ownerUserId],
          )
          .then((rows) => {
            tableCache.workers = { status: "present" };
            return iso(rows[0]?.at);
          })
          .catch((error: unknown) => {
            if (isMissingTableError(error)) {
              tableCache.workers = {
                status: "missing",
                retryAt: now + MISSING_TABLE_RETRY_MS,
              };
            }
            // 后台任务没启用（没有这张表）。
            return null;
          });

    const revisionPromise = isKnownMissing(tableCache.truncations, now)
      ? Promise.resolve("0")
      : sql
          .unsafe<{ n: string | null }[]>(
            "SELECT count(*)::text AS n FROM chisabot_thread_truncations WHERE thread_id = $1",
            [threadId],
          )
          .then((rows) => {
            tableCache.truncations = { status: "present" };
            return rows[0]?.n ?? "0";
          })
          .catch((error: unknown) => {
            if (isMissingTableError(error)) {
              tableCache.truncations = {
                status: "missing",
                retryAt: now + MISSING_TABLE_RETRY_MS,
              };
            }
            // 截断没启用（没有这张表）。
            return "0";
          });

    const [core, workers, revision] = await Promise.all([
      corePromise,
      workersPromise,
      revisionPromise,
    ]);
    if (!core.ok) return null;
    const owner = core.row?.owner ?? null;
    // 别人的对话：什么都不说（和对话接口一样当作不存在）。
    if (owner && owner !== ownerUserId) return null;
    return {
      threadId,
      seq: core.row?.seq ?? "0",
      running:
        Boolean(control?.isActive(threadId)) || Boolean(core.row?.locked),
      workers,
      inbox: iso(core.row?.inbox),
      revision,
    };
  }

  /** 「历史对话」（DESIGN.md §42.6）：最近 30 条有消息的对话，新的在前。 */
  async function history(
    ownerUserId: string,
    agentId: string,
  ): Promise<BotThreadSummary[]> {
    const now = Date.now();
    if (isKnownMissing(tableCache.localThreads, now)) return [];
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
           CASE
             WHEN name IS NOT NULL AND btrim(regexp_replace(name, '^［经[^\\n]+?］\\r?\\n', '')) <> '' THEN NULL
             WHEN messages->0->>'role' = 'user' THEN messages->0->'content'
             ELSE (SELECT m->'content' FROM jsonb_array_elements(messages) m WHERE m->>'role' = 'user' LIMIT 1)
           END AS first
         FROM chisabot_local_threads
         WHERE owner_user_id = $1 AND agent_id = $2 AND id NOT LIKE 'worker-%' AND id NOT LIKE 'im-%' AND COALESCE(thread_kind, 'primary') = 'primary' AND jsonb_array_length(messages) > 0
         ORDER BY updated_at DESC LIMIT 30`,
        [ownerUserId, agentId],
      );
      tableCache.localThreads = { status: "present" };
      return rows.map((row) => ({
        threadId: row.id,
        title:
          clipTitle(row.name) ||
          clipTitle(textOf(row.first)) ||
          "（没有文字的对话）",
        messages: Number(row.count) || 0,
        updatedAt: iso(row.updated_at),
      }));
    } catch (error) {
      if (isMissingTableError(error)) {
        tableCache.localThreads = {
          status: "missing",
          retryAt: now + MISSING_TABLE_RETRY_MS,
        };
      }
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

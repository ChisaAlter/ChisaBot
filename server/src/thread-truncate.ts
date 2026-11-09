import type { Message } from "@ag-ui/client";
import type { Database } from "./db/client";

/**
 * 重新生成 / 编辑后重发（DESIGN.md §67，CB-042）：把一段对话从某条用户消息起截掉。
 *
 * - `chisabot_local_threads.messages` 截到这条用户消息之前（它和它之后的全部去掉）；
 * - `chisabot_local_events` 从这条用户消息那一轮的 RUN_STARTED（第一个在 `input.messages` 里带上它的）起全删，
 *   回放（刷新、别的设备接入）就和截断后的消息列表一致；那几轮的 `chisabot_local_runs` 一起删；
 * - 截掉的消息 id 记进 `chisabot_thread_truncations`（墓碑）：还没收到截断的旧设备再发消息时会把整段旧消息
 *   一起带上来，运行器按墓碑把它们滤掉，不会「复活」；这张表的行数就是对话的「版本」，同步戳带着它，
 *   别的设备看到版本变了就按服务器回放重建（不能只看事件序号：截断后它先变小、再随新一轮变大）。
 * - 收件箱里还没读 / 欠回答的消息撤回，被截掉那几轮还在等的确认卡片作废，那几轮派出去还在跑的后台任务停掉。
 *
 * 只能在对话没在回答时截（回答中途截会和正在写的那一轮打架）；只能从「开启一轮」的用户消息截——
 * 回答中途插进去的消息（收件箱读进来的）没有自己的 RUN_STARTED，从它截会留下半轮回放，拒绝。
 */

export type TruncationStart = {
  sequence: string;
  runId: string;
  ids: readonly string[];
};

export type TruncationPlan =
  | {
      ok: true;
      index: number;
      cutSequence: string | null;
      removed: string[];
      removedToolCalls: string[];
    }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * 纯函数：从哪里截。`starts` 是这条对话所有 RUN_STARTED（按序号升序）和它们输入里的消息 id。
 * 事件表为空（很老的对话、或从没经过运行器）时只截消息。
 */
export function planTruncation(
  messages: readonly Pick<Message, "id" | "role">[],
  starts: readonly TruncationStart[],
  fromMessageId: string,
): TruncationPlan {
  const index = messages.findIndex((message) => message.id === fromMessageId);
  if (index < 0)
    return {
      ok: false,
      status: 404,
      error: "这条消息不在对话里（可能已经被别的设备改过了）",
    };
  if (messages[index]!.role !== "user")
    return { ok: false, status: 400, error: "只能从用户消息开始重发" };
  const removedMessages = messages.slice(index);
  const removed = removedMessages.map((message) => message.id);
  const removedToolCalls = removedMessages.flatMap((message) =>
    message.role === "assistant"
      ? ((message as { toolCalls?: { id?: unknown }[] }).toolCalls ?? [])
          .map((call) => String(call.id ?? ""))
          .filter(Boolean)
      : [],
  );
  if (!starts.length)
    return { ok: true, index, cutSequence: null, removed, removedToolCalls };
  const start = starts.find((item) => item.ids.includes(fromMessageId));
  if (!start)
    return {
      ok: false,
      status: 409,
      error: "这条消息是在回答中途插进去的，不能单独重发",
    };
  return {
    ok: true,
    index,
    cutSequence: start.sequence,
    removed,
    removedToolCalls,
  };
}

export async function ensureTruncationTable(database: Database) {
  await database.$client.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_thread_truncations (
    id bigserial PRIMARY KEY,
    thread_id text NOT NULL REFERENCES chisabot_local_threads(id) ON DELETE CASCADE,
    owner_user_id text NOT NULL, from_message_id text NOT NULL, mode text NOT NULL DEFAULT 'resend',
    removed jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await database.$client.unsafe(
    "CREATE INDEX IF NOT EXISTS chisabot_thread_truncations_thread ON chisabot_thread_truncations(thread_id, id)",
  );
  await database.$client.unsafe(
    "ALTER TABLE chisabot_thread_truncations ADD COLUMN IF NOT EXISTS previous_messages jsonb",
  );
}

/** 本地会话初始化时已建表；读取失败必须阻止合并，不能把旧客户端的已删除消息重新写回。 */
export async function tombstones(
  database: Database,
  threadId: string,
): Promise<Set<string>> {
  const rows = await database.$client.unsafe<{ id: string }[]>(
    "SELECT jsonb_array_elements_text(removed) AS id FROM chisabot_thread_truncations WHERE thread_id = $1",
    [threadId],
  );
  return new Set(rows.map((row) => row.id));
}

/** 对话版本：截断过几次。 */
export async function threadRevision(
  database: Database,
  threadId: string,
): Promise<string> {
  try {
    const rows = await database.$client.unsafe<{ n: string }[]>(
      "SELECT count(*)::text AS n FROM chisabot_thread_truncations WHERE thread_id = $1",
      [threadId],
    );
    return rows[0]?.n ?? "0";
  } catch {
    return "0";
  }
}

/** 滤掉墓碑里的消息（没有墓碑时原样返回同一个数组）。 */
export function dropTombstoned<T extends { id: string }>(
  messages: readonly T[],
  dead: ReadonlySet<string>,
): T[] {
  if (!dead.size) return messages as T[];
  const kept = messages.filter((message) => !dead.has(message.id));
  return kept.length === messages.length ? (messages as T[]) : kept;
}

export class TruncateError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type ThreadLockRow = {
  owner_user_id: string;
  messages: Message[];
  run_id: string | null;
  lock_expires_at: Date | string | null;
};

/**
 * 截断（事务里锁住这一行再做）。调用方已确认是本人的对话、且本进程里没在跑。
 * 返回截掉的消息 / 工具调用 id、截断后的版本、被截那一轮的开始时间（停后台任务用）。
 */
export async function truncateThread(
  database: Database,
  input: {
    threadId: string;
    ownerUserId: string;
    fromMessageId: string;
    mode: "regenerate" | "edit" | "resend";
  },
) {
  return await database.$client.begin(async (transaction) => {
    // Serialize the revision cut with DSH's first/replacement binding, including an absent row.
    await transaction.unsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [input.threadId],
    );
    const rows = await transaction.unsafe<ThreadLockRow[]>(
      "SELECT owner_user_id, messages, run_id, lock_expires_at FROM chisabot_local_threads WHERE id = $1 FOR UPDATE",
      [input.threadId],
    );
    const row = rows[0];
    if (!row || row.owner_user_id !== input.ownerUserId)
      throw new TruncateError("Thread not found", 404);
    if (
      row.run_id &&
      row.lock_expires_at &&
      new Date(row.lock_expires_at).getTime() > Date.now()
    )
      throw new TruncateError(
        "机器人正在回答，等它说完（或先停止）再重发",
        409,
      );
    const starts = await transaction.unsafe<
      { sequence: string; run_id: string; ids: string[] | null }[]
    >(
      `SELECT sequence::text AS sequence, run_id,
         (SELECT coalesce(jsonb_agg(m->>'id'), '[]'::jsonb) FROM jsonb_array_elements(coalesce(event->'input'->'messages', '[]'::jsonb)) m) AS ids
       FROM chisabot_local_events WHERE thread_id = $1 AND event->>'type' = 'RUN_STARTED' ORDER BY sequence`,
      [input.threadId],
    );
    const plan = planTruncation(
      row.messages,
      starts.map((start) => ({
        sequence: start.sequence,
        runId: start.run_id,
        ids: (start.ids ?? []).map(String),
      })),
      input.fromMessageId,
    );
    if (!plan.ok) throw new TruncateError(plan.error, plan.status);
    let cutAt: string | null = null;
    if (plan.cutSequence !== null) {
      const runs = await transaction.unsafe<{ run_id: string }[]>(
        "DELETE FROM chisabot_local_events WHERE thread_id = $1 AND sequence >= $2::bigint RETURNING run_id",
        [input.threadId, plan.cutSequence],
      );
      const runIds = [...new Set(runs.map((item) => item.run_id))];
      if (runIds.length) {
        const deleted = await transaction.unsafe<
          { created_at: Date | string }[]
        >(
          `DELETE FROM chisabot_local_runs WHERE thread_id = $1 AND run_id IN (SELECT jsonb_array_elements_text($2::text::jsonb))
           AND NOT EXISTS (SELECT 1 FROM chisabot_local_events e WHERE e.thread_id = chisabot_local_runs.thread_id AND e.run_id = chisabot_local_runs.run_id)
           RETURNING created_at`,
          [input.threadId, JSON.stringify(runIds)],
        );
        const times = deleted
          .map((item) => new Date(item.created_at).getTime())
          .filter(Number.isFinite);
        if (times.length) cutAt = new Date(Math.min(...times)).toISOString();
      }
    }
    await transaction.unsafe(
      `UPDATE chisabot_local_threads SET messages = $2::text::jsonb,
       snapshot_sequence=(SELECT coalesce(max(sequence),0) FROM chisabot_local_events WHERE thread_id=$1),
       updated_at = now() WHERE id = $1`,
      [input.threadId, JSON.stringify(row.messages.slice(0, plan.index))],
    );
    await transaction.unsafe(
      `INSERT INTO chisabot_thread_truncations (thread_id, owner_user_id, from_message_id, mode, removed, previous_messages)
       VALUES ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb)`,
      [
        input.threadId,
        input.ownerUserId,
        input.fromMessageId,
        input.mode,
        JSON.stringify(plan.removed),
        JSON.stringify(row.messages),
      ],
    );
    const [dsh] = await transaction.unsafe<{ present: boolean }[]>(
      "SELECT to_regclass('public.chisabot_runtime_bindings') IS NOT NULL AS present",
    );
    if (dsh?.present) {
      // The edit itself revokes the old execution branch. Waiting until the next send would let
      // an already-approved operation run against the edited history in the meantime.
      await transaction.unsafe(
        "UPDATE chisabot_runtime_bindings SET active=false WHERE thread_id=$1 AND owner_user_id=$2 AND active",
        [input.threadId, input.ownerUserId],
      );
      await transaction.unsafe(
        `UPDATE chisabot_dsh_runs SET stop_requested=true,status='interrupted',updated_at=now()
        WHERE thread_id=$1 AND owner_user_id=$2 AND status IN ('admitting','observing','projecting','waiting')`,
        [input.threadId, input.ownerUserId],
      );
      await transaction.unsafe(
        `UPDATE chisabot_conversation_commands SET status='stopped',updated_at=now()
        WHERE thread_id=$1 AND owner_user_id=$2 AND status IN ('accepted','dispatched','queued')`,
        [input.threadId, input.ownerUserId],
      );
      await transaction.unsafe(
        `UPDATE chisabot_conversation_interactions SET status='cancelled'
        WHERE thread_id=$1 AND owner_user_id=$2 AND status='pending'`,
        [input.threadId, input.ownerUserId],
      );
    }
    const revision = await transaction.unsafe<{ n: string }[]>(
      "SELECT count(*)::text AS n FROM chisabot_thread_truncations WHERE thread_id = $1",
      [input.threadId],
    );
    return {
      removed: plan.removed,
      removedToolCalls: plan.removedToolCalls,
      kept: plan.index,
      revision: revision[0]?.n ?? "1",
      cutAt,
    };
  });
}

/** 截断之后的收尾：撤回收件箱、作废确认卡片。每一项单独兜底（表可能没启用）。 */
export async function afterTruncate(
  database: Database,
  input: {
    threadId: string;
    ownerUserId: string;
    removedToolCalls: readonly string[];
  },
) {
  const sql = database.$client;
  try {
    await sql.unsafe(
      `UPDATE chisabot_thread_inbox SET status = 'withdrawn', updated_at = now()
       WHERE thread_id = $1 AND status IN ('queued', 'owed')`,
      [input.threadId],
    );
  } catch {
    /* 收件箱没启用 */
  }
  if (input.removedToolCalls.length) {
    await sql.unsafe(
      "UPDATE chisabot_conversation_interactions SET status='cancelled' WHERE owner_user_id=$1 AND thread_id=$2 AND status='pending' AND call_id IN (SELECT jsonb_array_elements_text($3::text::jsonb))",
      [
        input.ownerUserId,
        input.threadId,
        JSON.stringify(input.removedToolCalls),
      ],
    );
    try {
      await sql.unsafe(
        `UPDATE chisabot_confirm_requests SET status = 'cancelled', decided_at = coalesce(decided_at, now())
         WHERE owner_user_id = $1 AND thread_id = $2 AND status = 'pending'
         AND tool_call_id IN (SELECT jsonb_array_elements_text($3::text::jsonb))`,
        [
          input.ownerUserId,
          input.threadId,
          JSON.stringify(input.removedToolCalls),
        ],
      );
    } catch {
      /* 确认卡片没启用 */
    }
  }
}

/** 被截那几轮里派出去、还在跑的后台任务（按创建时间）。 */
export async function workersSince(
  database: Database,
  threadId: string,
  ownerUserId: string,
  since: string | null,
): Promise<string[]> {
  if (!since) return [];
  try {
    const rows = await database.$client.unsafe<{ id: string }[]>(
      `SELECT id FROM chisabot_workers WHERE parent_thread_id = $1 AND owner_user_id = $2
       AND status IN ('queued', 'running', 'waiting') AND created_at >= $3::timestamptz`,
      [threadId, ownerUserId, since],
    );
    return rows.map((row) => row.id);
  } catch {
    return [];
  }
}

import { type SQL, sql } from "drizzle-orm";
import type { Database } from "../db/client";

/**
 * 草稿对话（A1）：新话题页上先加附件时提前建好、还没说过话的对话。
 *
 * 标记是 `description` 这一列（不加列、不迁移）：建好后没有别的地方写它，也不给用户看。
 * 说过一句（`last_message_at` 有值）就是普通对话。
 */
export const DRAFT_AGENT_CHANNEL_DESCRIPTION = "Private agent channel (draft).";

/** 超过这么久还没说过话的草稿对话由服务端清理（`startDraftSweeps`）。 */
export const DRAFT_MAX_AGE_MS = 24 * 60 * 60_000;

/** 一次最多清这么多，免得一条语句锁太多行；剩下的下一轮再清。 */
const SWEEP_BATCH = 500;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * 消息是不是存在本库的本地对话表里（`config.runtime.mode === "local"`，由启动处传进来）。不是（托管的
 * Intelligence）就没法确认「线程里没有消息」，于是什么都不删——宁可留一段谁也看不见的空对话，也不冒删掉真对话的险。
 *
 * 由调用方按运行模式直接给，不去探测表在不在：托管模式下库里也可能留着以前本地模式建的表，表在不等于消息在这里。
 */
export type DraftStorage = { localConversations: boolean };

/**
 * 「仍是空草稿」：四条同时满足才算——
 * - `description` 是草稿标记；
 * - `last_message_at` 为空（列表里没有任何一句）；
 * - 没被删过；
 * - 对应的线程（`intelligence_channel_mappings.thread_id`，所有成员的）里没有消息，也没有跑过一轮
 *   （机器人主动发、或者一轮正在跑但还没记 activity，都算有内容）。
 *
 * `channel` 是外层查询里频道表的别名或表名。
 */
function emptyDraftPredicate(channel: SQL): SQL {
  return sql`(
    ${channel}.description = ${DRAFT_AGENT_CHANNEL_DESCRIPTION}
    and ${channel}.last_message_at is null
    and ${channel}.deleted_at is null
    and not exists (
      select 1
      from intelligence_channel_mappings m
      join openbot_local_threads t on t.id = m.thread_id
      where m.channel_id = ${channel}.id
        and (
          t.messages <> '[]'::jsonb
          or exists (select 1 from openbot_local_runs r where r.thread_id = t.id)
        )
    )
  )`;
}

export type DraftDeleteOutcome =
  /** 删了（或者早就删了：重复调用也是这个结果）。 */
  | "deleted"
  /** 不是空草稿（发过消息、机器人说过话、不是草稿）或者无法确认，没动。 */
  | "kept";

/**
 * 条件删除一段草稿对话（`DELETE /api/channels/:id?draft=1`）：只在它此刻仍是空草稿时软删。
 *
 * 和普通删除不同：不发 `channel.deleted` 审计、不发频道通知——这段对话从来没出现在任何人的列表里，
 * 删掉它不是一次「用户删了一段对话」。调用方已经确认过 `actorId` 是成员。
 */
export async function deleteEmptyDraft(
  database: Database,
  channelId: string,
  storage: DraftStorage,
): Promise<DraftDeleteOutcome> {
  if (!storage.localConversations) return "kept";
  const result = await database.execute(sql`
    update channels c
    set deleted_at = now(), updated_at = now()
    where c.id = ${channelId} and ${emptyDraftPredicate(sql.raw("c"))}
    returning c.id
  `);
  if (rowsOf(result).length > 0) return "deleted";
  const gone = await database.execute(
    sql`select 1 from channels where id = ${channelId} and deleted_at is not null`,
  );
  return rowsOf(gone).length > 0 ? "deleted" : "kept";
}

/**
 * 清理 `olderThanMs` 之前建的、仍是空草稿的对话（软删，同上：不审计、不通知）。可以重复执行：已经删过的
 * 不再满足条件。返回这一轮删了几段；消息不在本地对话表里（非 local 模式）时返回 null（什么都没做）。
 */
export async function sweepAbandonedDrafts(
  database: Database,
  options: DraftStorage & { olderThanMs?: number; now?: Date },
): Promise<number | null> {
  if (!options.localConversations) return null;
  const cutoff = new Date(
    (options.now ?? new Date()).getTime() -
      (options.olderThanMs ?? DRAFT_MAX_AGE_MS),
  );
  const result = await database.execute(sql`
    update channels c
    set deleted_at = now(), updated_at = now()
    where c.id in (
      select d.id from channels d
      where d.created_at < ${cutoff.toISOString()}::timestamptz
        and ${emptyDraftPredicate(sql.raw("d"))}
      order by d.created_at
      limit ${SWEEP_BATCH}
    )
      and ${emptyDraftPredicate(sql.raw("c"))}
    returning c.id
  `);
  return rowsOf(result).length;
}

export type DraftSweeper = { stop(): void };

/**
 * 每小时清一次过期的空草稿（启动 1 分钟后第一次），和 `audit-retention.ts` 的 `startRetentionSweeps` 一样：
 * 定时器不挂住进程，失败只记日志、下一轮再试。
 */
export function startDraftSweeps(
  database: Database,
  options: DraftStorage & { intervalMs?: number; firstRunMs?: number },
): DraftSweeper {
  const intervalMs = options.intervalMs ?? 60 * 60_000;
  const firstRunMs = options.firstRunMs ?? 60_000;
  const timers: ReturnType<typeof setInterval>[] = [];
  const run = () => {
    void sweepAbandonedDrafts(database, {
      localConversations: options.localConversations,
    })
      .then((removed) => {
        if (!removed) return;
        console.info(JSON.stringify({ type: "draft-channels-swept", removed }));
      })
      .catch((error) => {
        console.error(
          JSON.stringify({
            type: "draft-channels-sweep-failed",
            note: "Abandoned empty draft conversations were not removed. Nothing is visible to anyone; they will be retried next hour.",
            error: String(error),
          }),
        );
      });
  };
  const first = setTimeout(() => {
    run();
    const repeating = setInterval(run, intervalMs);
    repeating.unref?.();
    timers.push(repeating);
  }, firstRunMs);
  first.unref?.();
  return {
    stop: () => {
      clearTimeout(first);
      for (const timer of timers) clearInterval(timer);
    },
  };
}

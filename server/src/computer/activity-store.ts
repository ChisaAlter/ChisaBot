/**
 * 计算机「活动」记录的存储、查询、推送和清理（CB-101）。表见 db/schema/computer.ts 的 computer_activity_steps。
 *
 * 推送照 channels/events.ts 的做法走 Postgres NOTIFY：写的那台和 SSE 连着的那台常常不是同一个进程。payload
 * 只带 id 和状态，前端收到后再拉这一行；NOTIFY 丢了也不丢数据，重连后整页重拉即可。
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";
import postgres from "postgres";
import type { Database } from "../db/client";
import { computerActivitySteps } from "../db/schema";

export const ACTIVITY_TOPIC = "computer_activity";
/** 记录保留 90 天（CB-101 待确认第 3 项，按默认）。 */
export const ACTIVITY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** 进行中超过这么久还没结束（进程重启、断电），清理时改成超时。 */
export const ACTIVITY_STALE_RUNNING_MS = 15 * 60 * 1000;
const PURGE_BATCH = 5000;

export type ActivityStatus = "running" | "ok" | "failed" | "refused" | "timeout" | "cancelled";
export type ActivityKind =
  | "navigate" | "click" | "type" | "key" | "scroll" | "screenshot" | "snapshot" | "read" | "tabs"
  | "run_command" | "read_file" | "write_file" | "list_files" | "download_file" | "secret" | "help";

export type ActivityStepRow = typeof computerActivitySteps.$inferSelect;

export type ActivityStepView = {
  id: string;
  seq: number;
  threadId: string | null;
  runId: string | null;
  toolCallId: string | null;
  actorKind: "agent" | "human";
  kind: string;
  status: ActivityStatus;
  refusalReason: string | null;
  subject: string;
  detail: Record<string, unknown>;
  output: string | null;
  outputTruncated: boolean;
  hasFrame: boolean;
  turnPrompt: string | null;
  turnStatus: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
};

export type BeginInput = {
  computerId: string;
  threadId?: string | null;
  runId?: string | null;
  toolCallId?: string | null;
  actorUserId?: string | null;
  actorKind: "agent" | "human";
  kind: ActivityKind;
  subject: string;
  detail?: Record<string, unknown>;
};

export type FinishInput = {
  status: Exclude<ActivityStatus, "running">;
  refusalReason?: string | null;
  subject?: string;
  detail?: Record<string, unknown>;
  output?: string | null;
  outputTruncated?: boolean;
};

export type ActivityEvent = { computerId: string; threadId: string | null; stepId: string; status: string };

export type ActivityCursor = { at: string; seq: number };

export type ActivityStore = {
  begin(input: BeginInput): Promise<string | null>;
  finish(id: string, input: FinishInput): Promise<void>;
  markFrame(id: string): Promise<void>;
  /** 人连续的同类操作并成一行：只更新 detail（次数）和结束时间。 */
  bump(id: string, detail: Record<string, unknown>): Promise<void>;
  get(computerId: string, actorUserId: string, id: string): Promise<ActivityStepView | null>;
  list(query: {
    computerId: string;
    actorUserId: string;
    threadId?: string;
    before?: ActivityCursor;
    limit?: number;
  }): Promise<{ steps: ActivityStepView[]; nextCursor: ActivityCursor | null; retentionDays: number }>;
  /** 这条对话是不是这个人在这个 Bot 上的；不是就不让它进记录（避免借别人的 thread id 写入 / 读取）。 */
  threadOf(threadId: string, actorUserId: string, computerId: string): Promise<boolean>;
  cancelRunning(computerId: string): Promise<number>;
  clear(computerId: string): Promise<number>;
  purge(olderThanMs: number): Promise<number>;
  expireRunning(olderThanMs: number): Promise<number>;
  subscribe(listener: (event: ActivityEvent) => void): () => void;
  stop(): Promise<void>;
};

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function view(row: ActivityStepRow & { turnStatus?: string | null }): ActivityStepView {
  return {
    id: row.id,
    seq: Number(row.seq),
    threadId: row.threadId,
    runId: row.runId,
    toolCallId: row.toolCallId,
    actorKind: row.actorKind === "human" ? "human" : "agent",
    kind: row.kind,
    status: row.status as ActivityStatus,
    refusalReason: row.refusalReason,
    subject: row.subject,
    detail: (row.detail ?? {}) as Record<string, unknown>,
    output: row.output,
    outputTruncated: row.outputTruncated,
    hasFrame: row.hasFrame,
    turnPrompt: row.turnPrompt,
    turnStatus: row.turnStatus ?? null,
    startedAt: iso(row.startedAt) ?? new Date(0).toISOString(),
    finishedAt: iso(row.finishedAt),
    durationMs: row.durationMs,
  };
}

/** 从一条 user 消息里取出文字（content 可能是字符串，也可能是分段数组）。 */
export function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

export function createActivityStore(database: Database, databaseUrl?: string): ActivityStore {
  const listeners = new Set<(event: ActivityEvent) => void>();
  const prompts = new Map<string, string | null>();
  let connection: ReturnType<typeof postgres> | undefined;
  let listening: Promise<void> | undefined;

  function ensureListening() {
    if (listening || !databaseUrl) return;
    connection = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    listening = connection
      .listen(ACTIVITY_TOPIC, (payload) => {
        let event: ActivityEvent;
        try {
          event = JSON.parse(payload) as ActivityEvent;
        } catch {
          return;
        }
        for (const listener of listeners) listener(event);
      })
      .then(() => undefined)
      .catch((error) => {
        console.error(JSON.stringify({ type: "computer-activity-listen-failed", error: String(error) }));
        listening = undefined;
      });
  }

  async function announce(event: ActivityEvent) {
    try {
      if (databaseUrl) {
        await database.execute(sql`select pg_notify(${ACTIVITY_TOPIC}, ${JSON.stringify(event)})`);
      } else {
        for (const listener of listeners) listener(event);
      }
    } catch (error) {
      console.warn(JSON.stringify({ type: "computer-activity-notify-failed", error: String(error) }));
    }
  }

  async function promptFor(threadId: string | null | undefined, runId: string | null | undefined): Promise<string | null> {
    if (!threadId) return null;
    const key = `${threadId}\u0000${runId ?? ""}`;
    if (prompts.has(key)) return prompts.get(key) ?? null;
    let prompt: string | null = null;
    try {
      const rows = (await database.execute(sql`
        select m.value as message from openbot_local_threads t,
          jsonb_array_elements(t.messages) with ordinality as m(value, ord)
        where t.id = ${threadId} and m.value->>'role' = 'user'
        order by m.ord desc limit 1
      `)) as unknown as { message: unknown }[];
      const text = messageText(rows[0]?.message).replace(/\s+/g, " ").trim();
      prompt = text ? (text.length > 300 ? `${text.slice(0, 300)}…` : text) : null;
    } catch {
      prompt = null;
    }
    if (prompts.size > 500) prompts.clear();
    // 没有 run id 时不缓存：同一条对话下一句话的组头不能沿用上一句。
    if (runId) prompts.set(key, prompt);
    return prompt;
  }

  return {
    async begin(input) {
      const id = randomUUID();
      const turnPrompt = input.actorKind === "agent" ? await promptFor(input.threadId, input.runId) : null;
      const inserted = await database
        .insert(computerActivitySteps)
        .values({
          id,
          computerId: input.computerId,
          threadId: input.threadId ?? null,
          runId: input.runId ?? null,
          toolCallId: input.toolCallId ?? null,
          actorUserId: input.actorUserId ?? null,
          actorKind: input.actorKind,
          kind: input.kind,
          status: "running",
          subject: input.subject.slice(0, 2048),
          detail: input.detail ?? {},
          turnPrompt,
        })
        .onConflictDoNothing()
        .returning({ id: computerActivitySteps.id });
      // 同一个工具调用第二次进来（重试、重放、两个副本）：不另起一行，也不再写结果。
      // 例外是「等你批准」之后的那次真正执行：同一行改回进行中，接着记结果。
      if (!inserted[0]) {
        if (!input.toolCallId) return null;
        const [resumed] = await database
          .update(computerActivitySteps)
          .set({ status: "running", refusalReason: null, finishedAt: null, durationMs: null })
          .where(
            and(
              eq(computerActivitySteps.computerId, input.computerId),
              eq(computerActivitySteps.toolCallId, input.toolCallId),
              eq(computerActivitySteps.refusalReason, "awaiting_approval"),
            ),
          )
          .returning({ id: computerActivitySteps.id });
        if (!resumed) return null;
        await announce({ computerId: input.computerId, threadId: input.threadId ?? null, stepId: resumed.id, status: "running" });
        return resumed.id;
      }
      await announce({ computerId: input.computerId, threadId: input.threadId ?? null, stepId: id, status: "running" });
      return id;
    },

    async finish(id, input) {
      const [row] = await database
        .update(computerActivitySteps)
        .set({
          status: input.status,
          refusalReason: input.refusalReason ?? null,
          ...(input.subject !== undefined ? { subject: input.subject.slice(0, 2048) } : {}),
          ...(input.detail !== undefined
            ? { detail: sql`${computerActivitySteps.detail} || ${JSON.stringify(input.detail)}::jsonb` }
            : {}),
          ...(input.output !== undefined ? { output: input.output } : {}),
          outputTruncated: input.outputTruncated ?? false,
          finishedAt: sql`now()`,
          durationMs: sql`greatest(0, (extract(epoch from (now() - ${computerActivitySteps.startedAt})) * 1000)::int)`,
        })
        .where(and(eq(computerActivitySteps.id, id), eq(computerActivitySteps.status, "running")))
        .returning({ computerId: computerActivitySteps.computerId, threadId: computerActivitySteps.threadId });
      if (row) await announce({ computerId: row.computerId, threadId: row.threadId, stepId: id, status: input.status });
    },

    async markFrame(id) {
      const [row] = await database
        .update(computerActivitySteps)
        .set({ hasFrame: true })
        .where(eq(computerActivitySteps.id, id))
        .returning({ computerId: computerActivitySteps.computerId, threadId: computerActivitySteps.threadId, status: computerActivitySteps.status });
      if (row) await announce({ computerId: row.computerId, threadId: row.threadId, stepId: id, status: row.status });
    },

    async bump(id, detail) {
      const [row] = await database
        .update(computerActivitySteps)
        .set({
          detail: sql`${computerActivitySteps.detail} || ${JSON.stringify(detail)}::jsonb`,
          finishedAt: sql`now()`,
          durationMs: sql`greatest(0, (extract(epoch from (now() - ${computerActivitySteps.startedAt})) * 1000)::int)`,
        })
        .where(eq(computerActivitySteps.id, id))
        .returning({ computerId: computerActivitySteps.computerId, threadId: computerActivitySteps.threadId, status: computerActivitySteps.status });
      if (row) await announce({ computerId: row.computerId, threadId: row.threadId, stepId: id, status: row.status });
    },

    async get(computerId, actorUserId, id) {
      const rows = await database
        .select()
        .from(computerActivitySteps)
        .where(
          and(
            eq(computerActivitySteps.id, id),
            eq(computerActivitySteps.computerId, computerId),
            eq(computerActivitySteps.actorUserId, actorUserId),
          ),
        );
      const row = rows[0];
      if (!row) return null;
      const status = await runStatuses([row]);
      return view({ ...row, turnStatus: status.get(`${row.threadId}\u0000${row.runId}`) ?? null });
    },

    async list(query) {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const conditions: SQL[] = [
        eq(computerActivitySteps.computerId, query.computerId),
        eq(computerActivitySteps.actorUserId, query.actorUserId),
      ];
      if (query.threadId) conditions.push(eq(computerActivitySteps.threadId, query.threadId));
      if (query.before) {
        const at = new Date(query.before.at);
        conditions.push(
          or(
            lt(computerActivitySteps.startedAt, at),
            and(eq(computerActivitySteps.startedAt, at), lt(computerActivitySteps.seq, query.before.seq)),
          ) as SQL,
        );
      }
      const rows = await database
        .select()
        .from(computerActivitySteps)
        .where(and(...conditions))
        .orderBy(desc(computerActivitySteps.startedAt), desc(computerActivitySteps.seq))
        .limit(limit + 1);
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      const statuses = await runStatuses(page);
      const last = page.at(-1);
      return {
        steps: page.map((row) => view({ ...row, turnStatus: statuses.get(`${row.threadId}\u0000${row.runId}`) ?? null })),
        nextCursor: more && last ? { at: iso(last.startedAt) as string, seq: Number(last.seq) } : null,
        retentionDays: ACTIVITY_RETENTION_MS / 86_400_000,
      };
    },

    async threadOf(threadId, actorUserId, computerId) {
      try {
        const rows = (await database.execute(
          sql`select 1 as ok from openbot_local_threads where id = ${threadId} and owner_user_id = ${actorUserId} and agent_id = ${computerId} limit 1`,
        )) as unknown as { ok: number }[];
        return rows.length > 0;
      } catch {
        return false;
      }
    },

    async cancelRunning(computerId) {
      const rows = await database
        .update(computerActivitySteps)
        .set({ status: "cancelled", finishedAt: sql`now()` })
        .where(and(eq(computerActivitySteps.computerId, computerId), eq(computerActivitySteps.status, "running")))
        .returning({ id: computerActivitySteps.id, threadId: computerActivitySteps.threadId });
      for (const row of rows) await announce({ computerId, threadId: row.threadId, stepId: row.id, status: "cancelled" });
      return rows.length;
    },

    async clear(computerId) {
      const rows = await database
        .delete(computerActivitySteps)
        .where(eq(computerActivitySteps.computerId, computerId))
        .returning({ id: computerActivitySteps.id });
      return rows.length;
    },

    async purge(olderThanMs) {
      let removed = 0;
      for (let batch = 0; batch < 200; batch += 1) {
        const result = (await database.execute(sql`
          delete from ${computerActivitySteps} where id in (
            select id from ${computerActivitySteps}
            where ${computerActivitySteps.startedAt} < now() - make_interval(secs => ${olderThanMs / 1000})
            limit ${PURGE_BATCH}
          )
        `)) as unknown as { count?: number };
        const count = result?.count ?? 0;
        removed += count;
        if (count < PURGE_BATCH) break;
      }
      return removed;
    },

    async expireRunning(olderThanMs) {
      const rows = await database
        .update(computerActivitySteps)
        .set({
          status: "timeout",
          finishedAt: sql`now()`,
          durationMs: sql`greatest(0, (extract(epoch from (now() - ${computerActivitySteps.startedAt})) * 1000)::int)`,
        })
        .where(
          and(
            eq(computerActivitySteps.status, "running"),
            sql`${computerActivitySteps.startedAt} < now() - make_interval(secs => ${olderThanMs / 1000})`,
          ),
        )
        .returning({ id: computerActivitySteps.id });
      return rows.length;
    },

    subscribe(listener) {
      ensureListening();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async stop() {
      listeners.clear();
      await connection?.end({ timeout: 5 }).catch(() => undefined);
    },
  };

  async function runStatuses(rows: { threadId: string | null; runId: string | null }[]): Promise<Map<string, string>> {
    const pairs = rows.filter((row) => row.threadId && row.runId);
    const out = new Map<string, string>();
    if (!pairs.length) return out;
    const threads = [...new Set(pairs.map((row) => row.threadId as string))];
    try {
      const found = (await database.execute(sql`
        select thread_id, run_id, status from openbot_local_runs
        where thread_id in (${sql.join(threads.map((thread) => sql`${thread}`), sql`, `)})
      `)) as unknown as { thread_id: string; run_id: string; status: string }[];
      for (const row of found) out.set(`${row.thread_id}\u0000${row.run_id}`, row.status);
    } catch {
      // openbot_local_runs 不在（没开本地对话）：组头状态由步骤自己推出来。
    }
    return out;
  }
}

/** 进程里唯一的一份。index.ts 启动时装上；没装（测试、没有计算机的部署）时一切记录都是空操作。 */
let installed: ActivityStore | undefined;
let sweepTimer: ReturnType<typeof setInterval> | undefined;

export function installActivityStore(store: ActivityStore, options: { sweepMs?: number; firstSweepMs?: number } = {}) {
  installed = store;
  if (sweepTimer) clearInterval(sweepTimer);
  const sweep = () => {
    void Promise.all([store.purge(ACTIVITY_RETENTION_MS), store.expireRunning(ACTIVITY_STALE_RUNNING_MS)])
      .then(([removed, expired]) => {
        if (removed || expired) console.info(JSON.stringify({ type: "computer-activity-swept", removed, expired }));
      })
      .catch((error) =>
        console.error(
          JSON.stringify({
            type: "computer-activity-sweep-failed",
            note: "Old activity rows were not removed. Nothing is broken; the table is larger than it should be.",
            error: String(error),
          }),
        ),
      );
  };
  if (options.sweepMs !== 0) {
    setTimeout(sweep, options.firstSweepMs ?? 90_000).unref?.();
    sweepTimer = setInterval(sweep, options.sweepMs ?? 60 * 60_000);
    sweepTimer.unref?.();
  }
}

export function activityStore(): ActivityStore | undefined {
  return installed;
}

export function uninstallActivityStore() {
  installed = undefined;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = undefined;
}


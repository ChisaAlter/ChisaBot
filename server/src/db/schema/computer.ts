/**
 * Computer tables: agent computers, sessions, computer-use audit.
 *
 * Split by owner so two people can add tables all day without touching the same lines. Add tables
 * here; never edit core.ts or coworker.ts to do it.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";

/**
 * The boundary this deployment is enforcing, kept where a restart cannot lose it.
 *
 * This table keeps policy across restarts. The policy can be changed while running, and a restart
 * must not silently return to the default.
 *
 * One row, by construction. A deployment has one boundary, so the primary key is a constant and every
 * write is an upsert onto it. A table that can hold two policies is a table that will eventually hold
 * two and have to decide between them, and "which of these is in force" is not a question this should
 * ever be able to ask.
 *
 * Memory is still the cache. The gateway asks for the policy on every action, so it reads from
 * memory; this is the record that survives a restart, not something on the path of a click.
 */
export const actionPolicy = pgTable("action_policy", {
  /** Always `current`. See the note above on there being exactly one. */
  id: text("id").primaryKey(),
  /** `enforce` or `dry-run`. Not an enum: the policy module owns that vocabulary. */
  mode: text("mode").notNull(),
  deny: text("deny").array().notNull(),
  allow: text("allow").array().notNull(),
  /** Who last changed it, for the Admin page and the trail. */
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * The last snapshot a computer produced, kept where every replica can read it.
 *
 * The gateway resolves the opaque ref in an acting call into the element it points at, and it must
 * resolve it against the snapshot the ref came from, never against a label the caller supplied. That
 * mapping used to live in a `Map` inside one process. ChisaBot runs several processes behind a load
 * balancer, and the process that took the snapshot is rarely the one that handles the click that
 * follows it, so the mapping was absent exactly when a click arrived on another replica: the policy
 * then decided with no element in front of it and the audit row could not name what was touched. The
 * boundary the whole gateway exists for stopped applying, and nothing said so.
 *
 * One row per computer, upserted on every snapshot: the newest one wins, because a ref is only ever
 * resolved against the snapshot that is current. `snapshot_id` is the generation the far-side
 * computer stamped on it, so a ref carrying an older generation does not resolve to whatever now
 * holds that ref — the staleness a persisted cache is rightly warned about is answered by matching
 * the generation, not by keeping the cache in memory.
 *
 * Kept small on purpose: only the interactive elements a policy can match on, keyed by ref. It is a
 * resolution table for the boundary, not a history of pages, and the next snapshot replaces it.
 */
export const computerSnapshot = pgTable("computer_snapshot", {
  /** The computer these refs belong to. One live snapshot each, so it is the key. */
  computerId: text("computer_id").primaryKey(),
  /** The generation the computer stamped on this snapshot. A ref names the one it came from. */
  snapshotId: integer("snapshot_id").notNull(),
  /** The page it was taken on, so a rule about the host still has a page to match after a handover. */
  url: text("url").notNull(),
  /** The interactive elements, keyed by ref. The one thing resolve looks a ref up in. */
  elements: jsonb("elements").notNull(),
  takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * Which run of the computer took it.
   *
   * The generation only tells snapshots apart within one session: a replaced container counts from
   * one again, so a ref from a dead session matches a row the new one has not overwritten yet, and
   * the policy decides against an element from a page that no longer exists. Reset clears the row
   * for exactly that reason, but reset is not the only way a computer is replaced — an image change
   * does it too, and the server is never told. This is the session, so a stale row is recognisable
   * without anybody having to remember to delete it.
   *
   * Null where the provider cannot say, which is a deployment with one shared computer and no
   * supervisor. There the behaviour is what it was before this column existed.
   */
  session: text("session"),
});

/**
 * What a Bot's screen looked like on the turn that opened it.
 *
 * A conversation is a record, and a record must not change its mind. The transcript used to fetch
 * the live screen for every past turn, so an answer about one page sat under a picture of whichever
 * page the Bot had open by the time somebody read it back.
 *
 * KEYED ON THE TURN, which is the identity of the thing being remembered. Keying on the page instead
 * was a mistake with a plausible reason: two visits to one address collided, and letting the newer
 * win made a past turn's picture change under it, which is the exact mutability this table exists to
 * remove. A turn happens once and is then over for good, so the row is written once and never
 * updated.
 *
 * The computer is in the key as well as the turn, so a caller who may reach one Bot cannot read
 * another Bot's screen by naming a tool call.
 */
export const computerPageFrame = pgTable(
  "computer_page_frame",
  {
    /** Whose computer it was. */
    computerId: text("computer_id").notNull(),
    /** The turn that opened it. */
    toolCallId: text("tool_call_id").notNull(),
    /** The page, as the browser reported it after the navigation settled. */
    url: text("url").notNull(),
    title: text("title"),
    /**
     * The frame itself, base64 PNG.
     *
     * Bounded by the code that writes it rather than by the column, because the useful limit is "a
     * screenshot" and the honest failure is a refusal at the boundary rather than a database error.
     */
    frame: text("frame").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.computerId, table.toolCallId] }),
    // The reaper's query: everything older than the retention window, whoever it belongs to.
    index("computer_page_frame_captured_idx").on(table.capturedAt),
  ],
);

/**
 * 计算机面板「活动」里的每一步（CB-101）。
 *
 * 以前只存在浏览器内存里：刷新就没了、换设备看不到、时间是重放时刻、超过 200 条静默丢弃。现在由服务端
 * gateway 在动作开始时写一行（running），结束时补上结果，记录真实发生时间。
 *
 * 不对 openbot_local_threads 建外键：那几张表由 local-conversations.ts 在运行时建，迁移跑的时候不一定在。
 * 删 Bot 时由 agents/purge.ts 一并删掉；保留期由 activity-store 的定时清理负责（90 天）。
 *
 * 写进来的内容已经打过码（computer/activity-redact.ts）：密码、secret、URL 里的 token/key/code 参数、
 * 命令里像密钥的串，库里都没有明文；人自己输入的文字一律不记内容。
 */
export const computerActivitySteps = pgTable(
  "computer_activity_steps",
  {
    id: text("id").primaryKey(),
    computerId: text("computer_id").notNull(),
    /** openbot_local_threads.id；无头 / 后台任务可能没有。 */
    threadId: text("thread_id"),
    /** openbot_local_runs.run_id，即一个 turn。 */
    runId: text("run_id"),
    /** 与聊天里的工具调用、computer_page_frame 对应。 */
    toolCallId: text("tool_call_id"),
    actorUserId: text("actor_user_id"),
    /** agent | human */
    actorKind: text("actor_kind").notNull(),
    seq: bigint("seq", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .notNull(),
    kind: text("kind").notNull(),
    /** running | ok | failed | refused | timeout | cancelled */
    status: text("status").notNull(),
    refusalReason: text("refusal_reason"),
    subject: text("subject").notNull(),
    detail: jsonb("detail").notNull().default({}),
    output: text("output"),
    outputTruncated: boolean("output_truncated").notNull().default(false),
    hasFrame: boolean("has_frame").notNull().default(false),
    turnPrompt: text("turn_prompt"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (table) => [
    uniqueIndex("computer_activity_steps_call_uq")
      .on(table.computerId, table.toolCallId)
      .where(sql`${table.toolCallId} is not null`),
    index("computer_activity_steps_thread_idx").on(
      table.threadId,
      table.startedAt.desc(),
      table.seq.desc(),
    ),
    index("computer_activity_steps_computer_idx").on(
      table.computerId,
      table.startedAt.desc(),
      table.seq.desc(),
    ),
    index("computer_activity_steps_running_idx")
      .on(table.status)
      .where(sql`${table.status} = 'running'`),
    index("computer_activity_steps_started_idx").on(table.startedAt),
  ],
);

import { randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { CronExpressionParser } from "cron-parser";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  classifyScheduleReply,
  describeSchedule,
  failStreakShouldPause,
  formatWhen,
  formatWhenAbsolute,
  partsIn,
  SCHEDULE_DEFAULT_TZ,
  SCHEDULE_MARKER,
  type ScheduleEvent,
  type ScheduleKind,
  type ScheduleRunStatus,
  type ScheduleRunView,
  type ScheduleStatus,
  type ScheduleView,
  tzLabel,
} from "../../../shared/schedules";
import type { AuditInitiator } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { reasonWithoutStatement } from "../db/query-failure";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";

/**
 * 定时任务 / 提醒（DESIGN.md §55，docs/schedules.md）。
 *
 * 和上游 routines（server/src/routines，按频道发、最少 15 分钟、没有一次性）不同，这里是 ChisaBot 的「对话里设、
 * 回到这段对话」的定时任务：
 * - 表 chisabot_schedules（一次性 once / 周期 cron，用户时区，默认北京时间）+ chisabot_schedule_runs（每次运行），开机建表。
 * - 机器人工具 schedule_create / list / update / cancel / skip_next / run_now；设置 → 定时任务页同一套接口。
 * - 进程内扫描（每 15 秒）：`UPDATE … WHERE next_run_at = 旧值 AND status = 'active'` 的比较交换和插入运行记录在
 *   同一条语句里，谁抢到谁跑，所以两个进程（更新时新旧容器短暂并存、或者多副本）也只触发一次。
 * - 到点：往原来那段对话里放一条「⟦chisabot:schedule:…⟧」开头的消息（网页画成一行「定时任务」），机器人照说明
 *   做完回复；来自 IM 的任务回复同时推回那个 IM 会话。对话正被占用就排进那一轮的收件箱（和后台任务交结果一样）。
 * - 停机错过：周期任务晚了超过 30 分钟就跳过这一次、从现在排下一次；一次性提醒晚了 6 小时以内照发（注明晚了），更晚记为错过。
 */
const SWEEP_MS = 15_000;
const CRON_GRACE_MS = 30 * 60_000;
const ONCE_GRACE_MS = 6 * 60 * 60_000;
const MAX_ACTIVE = 50;
const MAX_AHEAD_MS = 366 * 24 * 60 * 60_000;
const RESULT_LIMIT = 2000;
const BUSY_RETRY_MS = 10_000;
const BUSY_RETRIES = 12;
/** Track B：卡在 running >20 分钟 → 标失败并清对话锁（启动 ensure 与扫表周期共用「20 minutes」字面量）。 */
/** 连续失败这么多次 → 自动暂停（不自动恢复；电车等噪音任务保持人手恢复）。 */
const FAIL_STREAK_PAUSE = 3;

export class ScheduleError extends Error {}

/** 和 turns/types 的 TurnRunner 同形（只用到这些字段）。 */
export type TurnRunner = (input: {
  ownerUserId: string;
  routineId: string;
  agentId: string;
  threadId: string;
  instruction: string;
  initiator?: AuditInitiator;
  userMessage?: Message;
  forwardedProps?: Record<string, unknown>;
}) => Promise<{ replyText: string }>;

const FLOOR_MS = 15 * 60_000;
const floorCache = new Map<string, boolean>();
/**
 * 五段 cron 在某时区、某时刻之后的下一次。最密每 15 分钟（扫 200 次看相邻间隔）。拒绝时抛 ScheduleError。
 * 自己实现而不用 routines/schedule.ts 的 nextOccurrence：上游 routines 可能被精简掉，这里只依赖 cron-parser。
 */
export function nextOccurrence(
  cron: string,
  timezone: string,
  after: Date,
): Date {
  const expr = cron.trim();
  if (expr.split(/\s+/).length !== 5)
    throw new ScheduleError(`看不懂这个时间安排（${cron}），cron 要五段。`);
  if (!knownZone(timezone)) throw new ScheduleError("时区不对。");
  const key = `${timezone}\u0000${expr}`;
  let ok = floorCache.get(key);
  if (ok === undefined) {
    ok = true;
    try {
      const it = CronExpressionParser.parse(expr, {
        tz: timezone,
        currentDate: new Date("2024-01-01T00:00:00Z"),
      });
      let prev = it.next().toDate().getTime();
      for (let i = 1; i < 200; i += 1) {
        const cur = it.next().toDate().getTime();
        if (cur - prev < FLOOR_MS) {
          ok = false;
          break;
        }
        prev = cur;
      }
    } catch {
      // 读不懂由下面的 parse 报；次数不够说明很稀疏。
    }
    if (floorCache.size > 1000) floorCache.clear();
    floorCache.set(key, ok);
  }
  if (!ok) throw new ScheduleError("定时任务最密每 15 分钟一次。");
  try {
    return CronExpressionParser.parse(expr, {
      tz: timezone,
      currentDate: after,
    })
      .next()
      .toDate();
  } catch {
    throw new ScheduleError(`看不懂这个时间安排（${cron}）。`);
  }
}

type Row = {
  id: string;
  owner_user_id: string;
  agent_id: string;
  thread_id: string;
  im_connection_id: string | null;
  title: string;
  instruction: string;
  kind: ScheduleKind;
  cron: string | null;
  run_at: Date | string | null;
  timezone: string;
  status: ScheduleStatus;
  next_run_at: Date | string | null;
  last_run_at: Date | string | null;
  last_status: ScheduleRunStatus | null;
  last_result: string | null;
  run_count: number;
  created_at: Date | string;
  updated_at: Date | string;
};
type RunRow = {
  id: string;
  schedule_id: string;
  owner_user_id: string;
  scheduled_for: Date | string | null;
  started_at: Date | string;
  finished_at: Date | string | null;
  status: ScheduleRunStatus;
  result: string | null;
  manual: boolean;
};

const iso = (v: Date | string) => new Date(v).toISOString();
const isoOrNull = (v: Date | string | null) => (v ? iso(v) : null);
const clip = (text: string, n: number) =>
  text.length > n ? `${text.slice(0, n)}…` : text;

export function knownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 某时区的「年月日 时:分」→ UTC 时刻（夏令时切换附近取第一个合法时刻）。 */
export function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  tz: string,
): Date {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i += 1) {
    const p = partsIn(new Date(guess), tz);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += want - seen;
  }
  return new Date(guess);
}

/** 机器人 / 网页给的「什么时候」。 */
export const whenSchema = z
  .object({
    repeat: z
      .enum([
        "once",
        "daily",
        "weekdays",
        "weekly",
        "monthly",
        "hourly",
        "every_minutes",
        "cron",
      ])
      .describe(
        "once=一次；daily=每天；weekdays=工作日（周一到周五）；weekly=每周几；monthly=每月几号；hourly=每小时；every_minutes=每隔 N 分钟；cron=五段 cron",
      ),
    at: z
      .string()
      .optional()
      .describe(
        "once：用户时区的本地时间「YYYY-MM-DD HH:MM」（如 2026-10-15 09:00）；daily/weekdays/weekly/monthly：「HH:MM」24 小时制；hourly：分钟数「MM」可省（默认整点）",
      ),
    in_minutes: z
      .number()
      .int()
      .min(1)
      .max(525_600)
      .optional()
      .describe(
        "once 的另一种写法：从现在起多少分钟后（「半小时后提醒我」= 30）。和 at 二选一",
      ),
    days: z
      .array(z.number().int().min(1).max(7))
      .max(7)
      .optional()
      .describe("weekly：星期几，1=周一 … 7=周日"),
    day: z.number().int().min(1).max(31).optional().describe("monthly：几号"),
    every: z
      .number()
      .int()
      .min(15)
      .max(720)
      .optional()
      .describe(
        "every_minutes：间隔分钟数，至少 15；能整除 60（15/20/30）或是整小时（60/120/180…）",
      ),
    cron: z
      .string()
      .max(100)
      .optional()
      .describe(
        "cron：五段 `分 时 日 月 星期`，按 timezone 解释，最密每 15 分钟",
      ),
  })
  .strict();
export type WhenInput = z.infer<typeof whenSchema>;

const HHMM = /^([01]?\d|2[0-3])[:：]([0-5]\d)$/;

/** 把「什么时候」变成 { kind, cron, runAt }，并算出下一次。拒绝时抛 ScheduleError（中文）。 */
export function resolveWhen(
  when: WhenInput,
  timezone: string,
  now: Date = new Date(),
): { kind: ScheduleKind; cron: string | null; runAt: Date | null; next: Date } {
  if (!knownZone(timezone))
    throw new ScheduleError(
      `「${timezone}」不是认识的时区，写成 Asia/Shanghai 这种 IANA 名字。`,
    );
  const hm = (value: string | undefined) => {
    const m = HHMM.exec((value ?? "").trim());
    if (!m)
      throw new ScheduleError(
        "时间要写成 24 小时制「HH:MM」，例如 09:00、18:30。",
      );
    return { h: Number(m[1]), m: Number(m[2]) };
  };
  if (when.repeat === "once") {
    let runAt: Date;
    if (when.in_minutes !== undefined && when.at)
      throw new ScheduleError("一次性任务的 at 和 in_minutes 只给一个。");
    if (when.in_minutes !== undefined)
      runAt = new Date(now.getTime() + when.in_minutes * 60_000);
    else {
      const m =
        /^(\d{4})-(\d{1,2})-(\d{1,2})[ T]([01]?\d|2[0-3])[:：]([0-5]\d)/.exec(
          (when.at ?? "").trim(),
        );
      if (!m)
        throw new ScheduleError(
          "一次性任务的 at 要写成用户时区的本地时间「YYYY-MM-DD HH:MM」，或者用 in_minutes。",
        );
      runAt = zonedToUtc(
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        timezone,
      );
      const check = partsIn(runAt, timezone);
      if (check.month !== Number(m[2]) || check.day !== Number(m[3]))
        throw new ScheduleError("这个日期不存在。");
    }
    // 整到分钟：「2 分钟后」按四舍五入，不会只剩 1 分多。
    runAt = new Date(Math.round(runAt.getTime() / 60_000) * 60_000);
    if (runAt.getTime() <= now.getTime() - 30_000)
      throw new ScheduleError(
        `这个时间已经过去了（现在是 ${formatWhen(now, timezone, now)}，${tzLabel(timezone)}）。`,
      );
    if (runAt.getTime() - now.getTime() > MAX_AHEAD_MS)
      throw new ScheduleError("一次性任务最多排到一年以后。");
    return {
      kind: "once",
      cron: null,
      runAt,
      next: runAt.getTime() < now.getTime() ? now : runAt,
    };
  }
  let cron: string;
  switch (when.repeat) {
    case "daily": {
      const t = hm(when.at);
      cron = `${t.m} ${t.h} * * *`;
      break;
    }
    case "weekdays": {
      const t = hm(when.at);
      cron = `${t.m} ${t.h} * * 1-5`;
      break;
    }
    case "weekly": {
      const t = hm(when.at);
      const days = [...new Set(when.days ?? [])];
      if (!days.length)
        throw new ScheduleError("每周任务要给 days（1=周一 … 7=周日）。");
      cron = `${t.m} ${t.h} * * ${days
        .map((d) => d % 7)
        .sort((a, b) => a - b)
        .join(",")}`;
      break;
    }
    case "monthly": {
      const t = hm(when.at);
      if (!when.day) throw new ScheduleError("每月任务要给 day（几号）。");
      cron = `${t.m} ${t.h} ${when.day} * *`;
      break;
    }
    case "hourly": {
      const minute = when.at
        ? Number(
            /^(\d{1,2})$/.exec(when.at.trim())?.[1] ??
              HHMM.exec(when.at.trim())?.[2] ??
              NaN,
          )
        : 0;
      if (!Number.isInteger(minute) || minute < 0 || minute > 59)
        throw new ScheduleError(
          "每小时任务的 at 写分钟数（0–59），或者不写（整点）。",
        );
      cron = `${minute} * * * *`;
      break;
    }
    case "every_minutes": {
      const every = when.every ?? 0;
      if (every >= 15 && every < 60 && 60 % every === 0)
        cron = `*/${every} * * * *`;
      else if (every >= 60 && every % 60 === 0 && 24 % (every / 60) === 0)
        cron = every === 60 ? "0 * * * *" : `0 */${every / 60} * * *`;
      else
        throw new ScheduleError(
          "间隔要至少 15 分钟，并且是 15/20/30 分钟，或者 1/2/3/4/6/8/12 小时。",
        );
      break;
    }
    default: {
      cron = (when.cron ?? "").trim().replace(/\s+/g, " ");
      if (!cron) throw new ScheduleError("cron 任务要给五段 cron 表达式。");
    }
  }
  return {
    kind: "cron",
    cron,
    runAt: null,
    next: nextOccurrence(cron, timezone, now),
  };
}

export type ScheduleDeps = {
  /** 网页对话的回合（和后台任务交结果同一个运行器）。 */
  runTurn: TurnRunner;
  /** IM 会话的回合（只给 IM 能显示的工具）。 */
  runImTurn?: TurnRunner;
  /** IM 来的任务：回复推回那个 IM 会话。 */
  pushToIm?: (threadId: string, text: string) => Promise<void>;
  /** 对话正被一轮占着？是的话把消息排进收件箱。 */
  isThreadActive?: (threadId: string) => boolean;
  enqueueToThread?: (input: {
    threadId: string;
    ownerUserId: string;
    message: Message;
  }) => Promise<boolean>;
  botAvailable?: (ownerUserId: string, agentId: string) => Promise<boolean>;
  isSuspension?: (error: unknown) => boolean;
  isPaused?: (error: unknown) => boolean;
  /** 回合结束后释放对话锁（防定时挂起后输入框一直灰）。 */
  releaseThread?: (threadId: string) => Promise<void>;
  now?: () => Date;
};

export function createSchedules(database: Database, deps: ScheduleDeps) {
  const sql = database.$client;
  const now = deps.now ?? (() => new Date());
  const running = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let sweeping = false;

  async function ensure() {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_schedules (
        id text PRIMARY KEY,
        owner_user_id text NOT NULL,
        agent_id text NOT NULL,
        thread_id text NOT NULL,
        im_connection_id text,
        title text NOT NULL,
        instruction text NOT NULL,
        kind text NOT NULL,
        cron text,
        run_at timestamptz,
        timezone text NOT NULL DEFAULT 'Asia/Shanghai',
        status text NOT NULL DEFAULT 'active',
        next_run_at timestamptz,
        last_run_at timestamptz,
        last_status text,
        last_result text,
        run_count integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS chisabot_schedules_due ON chisabot_schedules (next_run_at) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS chisabot_schedules_owner ON chisabot_schedules (owner_user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS chisabot_schedule_runs (
        id text PRIMARY KEY,
        schedule_id text NOT NULL,
        owner_user_id text NOT NULL,
        scheduled_for timestamptz,
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        status text NOT NULL DEFAULT 'running',
        result text,
        manual boolean NOT NULL DEFAULT false
      );
      CREATE INDEX IF NOT EXISTS chisabot_schedule_runs_sched ON chisabot_schedule_runs (schedule_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS chisabot_schedule_runs_owner ON chisabot_schedule_runs (owner_user_id, finished_at DESC);
    `);
    // 进程重启时还在「运行中」的记录：那一轮已经没了。
    await sql.unsafe(
      "UPDATE chisabot_schedule_runs SET status = 'failed', finished_at = now(), result = coalesce(result, '服务器重启，这次运行中断了') WHERE status = 'running' AND started_at < now() - interval '20 minutes'",
    );
  }

  const runView = (r: RunRow): ScheduleRunView => ({
    id: r.id,
    scheduleId: r.schedule_id,
    scheduledFor: isoOrNull(r.scheduled_for),
    startedAt: iso(r.started_at),
    finishedAt: isoOrNull(r.finished_at),
    status: r.status,
    result: r.result,
    manual: r.manual,
  });
  const view = (r: Row, runs?: RunRow[]): ScheduleView => ({
    id: r.id,
    agentId: r.agent_id,
    threadId: r.thread_id,
    source: r.im_connection_id ? "im" : "web",
    title: r.title,
    instruction: r.instruction,
    kind: r.kind,
    cron: r.cron,
    runAt: isoOrNull(r.run_at),
    timezone: r.timezone,
    status: r.status,
    nextRunAt: r.status === "active" ? isoOrNull(r.next_run_at) : null,
    lastRunAt: isoOrNull(r.last_run_at),
    lastStatus: r.last_status,
    lastResult: r.last_result,
    runCount: r.run_count,
    createdAt: iso(r.created_at),
    schedule: describeSchedule(
      {
        kind: r.kind,
        cron: r.cron,
        runAt: r.run_at ? iso(r.run_at) : null,
        timezone: r.timezone,
      },
      now(),
    ),
    running: running.has(r.id),
    ...(runs ? { recentRuns: runs.map(runView) } : {}),
  });

  async function byId(owner: string, id: string): Promise<Row | null> {
    const rows = await sql.unsafe<Row[]>(
      "SELECT * FROM chisabot_schedules WHERE id = $1 AND owner_user_id = $2",
      [id.trim(), owner],
    );
    return rows[0] ?? null;
  }
  async function need(owner: string, id: string): Promise<Row> {
    const row = await byId(owner, id);
    if (!row)
      throw new ScheduleError("找不到这个定时任务（用 schedule_list 看 id）。");
    return row;
  }

  async function list(
    owner: string,
    options: { includeEnded?: boolean; agentId?: string; runs?: number } = {},
  ): Promise<ScheduleView[]> {
    const rows = await sql.unsafe<Row[]>(
      `SELECT * FROM chisabot_schedules WHERE owner_user_id = $1
         AND ($2::boolean OR status IN ('active', 'paused') OR (updated_at > now() - interval '7 days'))
         AND ($3::text IS NULL OR agent_id = $3)
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, next_run_at NULLS LAST, created_at DESC LIMIT 200`,
      [owner, options.includeEnded ?? false, options.agentId ?? null],
    );
    if (!options.runs || !rows.length) return rows.map((r) => view(r));
    const runs = await sql.unsafe<(RunRow & { n: number })[]>(
      `SELECT * FROM (SELECT r.*, row_number() OVER (PARTITION BY schedule_id ORDER BY started_at DESC) AS n
         FROM chisabot_schedule_runs r WHERE schedule_id IN (SELECT jsonb_array_elements_text($1::text::jsonb))) x WHERE n <= $2`,
      [JSON.stringify(rows.map((r) => r.id)), options.runs],
    );
    return rows.map((r) =>
      view(
        r,
        runs.filter((x) => x.schedule_id === r.id),
      ),
    );
  }

  async function get(owner: string, id: string): Promise<ScheduleView> {
    const row = await need(owner, id);
    const runs = await sql.unsafe<RunRow[]>(
      "SELECT * FROM chisabot_schedule_runs WHERE schedule_id = $1 ORDER BY started_at DESC LIMIT 20",
      [row.id],
    );
    return view(row, runs);
  }

  async function create(input: {
    owner: string;
    agentId: string;
    threadId: string;
    imConnectionId?: string | null;
    title: string;
    instruction: string;
    when: WhenInput;
    timezone?: string;
  }): Promise<ScheduleView> {
    const title = input.title.trim().slice(0, 60);
    const instruction = input.instruction.trim().slice(0, 4000);
    if (!title) throw new ScheduleError("给任务起个几个字的名字（title）。");
    if (!instruction) throw new ScheduleError("instruction 写到点时要做的事。");
    const timezone = input.timezone?.trim() || SCHEDULE_DEFAULT_TZ;
    const resolved = resolveWhen(input.when, timezone, now());
    const count = await sql.unsafe<{ n: number }[]>(
      "SELECT count(*)::int AS n FROM chisabot_schedules WHERE owner_user_id = $1 AND status IN ('active','paused')",
      [input.owner],
    );
    if ((count[0]?.n ?? 0) >= MAX_ACTIVE)
      throw new ScheduleError(
        `最多 ${MAX_ACTIVE} 个没结束的定时任务，先删掉一些。`,
      );
    const id = `sch_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const rows = await sql.unsafe<Row[]>(
      `INSERT INTO chisabot_schedules (id, owner_user_id, agent_id, thread_id, im_connection_id, title, instruction, kind, cron, run_at, timezone, status, next_run_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12) RETURNING *`,
      [
        id,
        input.owner,
        input.agentId,
        input.threadId,
        input.imConnectionId ?? null,
        title,
        instruction,
        resolved.kind,
        resolved.cron,
        resolved.runAt,
        timezone,
        resolved.next,
      ],
    );
    return view(rows[0]!);
  }

  async function update(
    owner: string,
    id: string,
    patch: {
      title?: string;
      instruction?: string;
      when?: WhenInput;
      timezone?: string;
      paused?: boolean;
    },
  ): Promise<ScheduleView> {
    const row = await need(owner, id);
    if (row.status === "cancelled" || (row.status === "done" && !patch.when))
      throw new ScheduleError(
        "这个任务已经结束了；要再来一次就给新的时间（when）或者新建一个。",
      );
    const title = patch.title?.trim()
      ? patch.title.trim().slice(0, 60)
      : row.title;
    const instruction = patch.instruction?.trim()
      ? patch.instruction.trim().slice(0, 4000)
      : row.instruction;
    const timezone = patch.timezone?.trim() || row.timezone;
    let kind = row.kind;
    let cron = row.cron;
    let runAt = row.run_at ? new Date(row.run_at) : null;
    let status: ScheduleStatus = row.status === "done" ? "active" : row.status;
    if (patch.paused === true) status = "paused";
    if (patch.paused === false) status = "active";
    let next: Date | null = row.next_run_at ? new Date(row.next_run_at) : null;
    if (patch.when || patch.timezone) {
      const when: WhenInput =
        patch.when ??
        (row.kind === "cron"
          ? { repeat: "cron", cron: row.cron ?? "" }
          : {
              repeat: "once",
              at: localText(new Date(row.run_at!), row.timezone),
            });
      const resolved = resolveWhen(when, timezone, now());
      kind = resolved.kind;
      cron = resolved.cron;
      runAt = resolved.runAt;
      next = resolved.next;
    } else if (status === "active" && row.status !== "active") {
      // 恢复：周期任务从现在排下一次；一次性的时间过了就要新时间。
      if (kind === "cron") next = nextOccurrence(cron!, timezone, now());
      else if (runAt && runAt.getTime() <= now().getTime())
        throw new ScheduleError(
          "这个提醒的时间已经过了，恢复时请给一个新时间（when）。",
        );
      else next = runAt;
    }
    const rows = await sql.unsafe<Row[]>(
      `UPDATE chisabot_schedules SET title=$3, instruction=$4, timezone=$5, kind=$6, cron=$7, run_at=$8, status=$9, next_run_at=$10, updated_at=now()
       WHERE id=$1 AND owner_user_id=$2 RETURNING *`,
      [
        row.id,
        owner,
        title,
        instruction,
        timezone,
        kind,
        cron,
        runAt,
        status,
        next,
      ],
    );
    return view(rows[0]!);
  }

  async function remove(owner: string, id: string): Promise<boolean> {
    const rows = await sql.unsafe(
      "DELETE FROM chisabot_schedules WHERE id = $1 AND owner_user_id = $2 RETURNING id",
      [id.trim(), owner],
    );
    if (rows.length)
      await sql.unsafe(
        "DELETE FROM chisabot_schedule_runs WHERE schedule_id = $1",
        [id.trim()],
      );
    return rows.length > 0;
  }

  async function skipNext(owner: string, id: string): Promise<ScheduleView> {
    const row = await need(owner, id);
    if (row.status !== "active")
      throw new ScheduleError("只有进行中的任务能跳过下一次。");
    if (row.kind === "once") {
      const rows = await sql.unsafe<Row[]>(
        "UPDATE chisabot_schedules SET status='done', next_run_at=NULL, last_status='skipped', last_result='这次提醒被跳过了', updated_at=now() WHERE id=$1 RETURNING *",
        [row.id],
      );
      return view(rows[0]!);
    }
    const from = row.next_run_at ? new Date(row.next_run_at) : now();
    const next = nextOccurrence(
      row.cron!,
      row.timezone,
      from.getTime() > now().getTime() ? from : now(),
    );
    const rows = await sql.unsafe<Row[]>(
      "UPDATE chisabot_schedules SET next_run_at=$2, updated_at=now() WHERE id=$1 RETURNING *",
      [row.id, next],
    );
    return view(rows[0]!);
  }

  async function runNow(
    owner: string,
    id: string,
  ): Promise<{ runId: string; schedule: ScheduleView }> {
    const row = await need(owner, id);
    if (row.status === "cancelled")
      throw new ScheduleError("这个任务已经取消了。");
    if (running.has(row.id))
      throw new ScheduleError("这个任务正在运行，等它跑完。");
    const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    // 一次性的立即运行 = 提前做完，不再到点再来一次。
    const rows = await sql.unsafe<Row[]>(
      row.kind === "once" && row.status === "active"
        ? "UPDATE chisabot_schedules SET status='done', next_run_at=NULL, updated_at=now() WHERE id=$1 RETURNING *"
        : "SELECT * FROM chisabot_schedules WHERE id=$1",
      [row.id],
    );
    await sql.unsafe(
      "INSERT INTO chisabot_schedule_runs (id, schedule_id, owner_user_id, scheduled_for, manual) VALUES ($1,$2,$3,now(),true)",
      [runId, row.id, owner],
    );
    void fire(rows[0]!, runId, { manual: true, lateMs: 0 });
    return { runId, schedule: view(rows[0]!) };
  }

  async function finishRun(
    runId: string,
    scheduleId: string,
    status: ScheduleRunStatus,
    result: string | null,
  ) {
    const text = result ? clip(result, RESULT_LIMIT) : null;
    await sql.unsafe(
      "UPDATE chisabot_schedule_runs SET status=$2, result=$3, finished_at=now() WHERE id=$1",
      [runId, status, text],
    );
    await sql.unsafe(
      "UPDATE chisabot_schedules SET last_run_at=now(), last_status=$2, last_result=$3, run_count=run_count+1, updated_at=now() WHERE id=$1",
      [scheduleId, status, text],
    );
    // 每个任务只留最近 50 次。
    await sql.unsafe(
      "DELETE FROM chisabot_schedule_runs WHERE schedule_id = $1 AND id NOT IN (SELECT id FROM chisabot_schedule_runs WHERE schedule_id = $1 ORDER BY started_at DESC LIMIT 50)",
      [scheduleId],
    );
    // Track B：连续硬失败自动暂停，避免无人值守噪音刷屏。只 paused←active，从不自动 resume。
    if (status === "failed") {
      const recent = await sql.unsafe<{ status: string }[]>(
        "SELECT status FROM chisabot_schedule_runs WHERE schedule_id = $1 ORDER BY started_at DESC LIMIT $2",
        [scheduleId, FAIL_STREAK_PAUSE],
      );
      if (
        failStreakShouldPause(
          recent.map((r) => r.status as ScheduleRunStatus),
          FAIL_STREAK_PAUSE,
        )
      ) {
        const paused = await sql.unsafe(
          `UPDATE chisabot_schedules SET status='paused', next_run_at=NULL, updated_at=now(),
           last_result = coalesce($2, last_result)
           WHERE id=$1 AND status='active' RETURNING id`,
          [
            scheduleId,
            clip(
              `连续失败 ${FAIL_STREAK_PAUSE} 次，已自动暂停。修好后再打开开关恢复（不会自动恢复）。`,
              RESULT_LIMIT,
            ),
          ],
        );
        if (paused.length) {
          console.warn(
            JSON.stringify({
              type: "schedule-auto-paused",
              schedule: scheduleId,
              streak: FAIL_STREAK_PAUSE,
            }),
          );
        }
      }
    }
  }

  /** Track B / v0.1.34：卡死的 running 记录标失败；对话仍被占着则 releaseThread；连续失败则暂停（从不 auto-resume）。 */
  async function reclaimStuckRuns(): Promise<number> {
    const stuck = await sql.unsafe<
      { id: string; schedule_id: string; thread_id: string | null }[]
    >(
      `UPDATE chisabot_schedule_runs r
       SET status = 'failed', finished_at = now(),
           result = coalesce(result, '这次运行超时未结束，已标记失败')
       FROM chisabot_schedules s
       WHERE r.schedule_id = s.id AND r.status = 'running'
         AND r.started_at < now() - interval '20 minutes'
       RETURNING r.id, r.schedule_id, s.thread_id`,
    );
    const touched = new Set<string>();
    for (const row of stuck) {
      touched.add(row.schedule_id);
      await sql
        .unsafe(
          "UPDATE chisabot_schedules SET last_status='failed', last_result=$2, updated_at=now() WHERE id=$1",
          [row.schedule_id, "这次运行超时未结束，已标记失败"],
        )
        .catch(() => {});
      running.delete(row.schedule_id);
      if (row.thread_id)
        await deps.releaseThread?.(row.thread_id).catch(() => {});
    }
    // 回收后的失败同样计入连续失败：只 paused←active，从不自动 resume（电车策略同）。
    for (const scheduleId of touched) {
      const recent = await sql.unsafe<{ status: string }[]>(
        "SELECT status FROM chisabot_schedule_runs WHERE schedule_id = $1 ORDER BY started_at DESC LIMIT $2",
        [scheduleId, FAIL_STREAK_PAUSE],
      );
      if (
        failStreakShouldPause(
          recent.map((r) => r.status as ScheduleRunStatus),
          FAIL_STREAK_PAUSE,
        )
      ) {
        const paused = await sql.unsafe(
          `UPDATE chisabot_schedules SET status='paused', next_run_at=NULL, updated_at=now(),
           last_result = coalesce($2, last_result)
           WHERE id=$1 AND status='active' RETURNING id`,
          [
            scheduleId,
            clip(
              `连续失败 ${FAIL_STREAK_PAUSE} 次，已自动暂停。修好后再打开开关恢复（不会自动恢复）。`,
              RESULT_LIMIT,
            ),
          ],
        );
        if (paused.length) {
          console.warn(
            JSON.stringify({
              type: "schedule-auto-paused",
              schedule: scheduleId,
              streak: FAIL_STREAK_PAUSE,
              via: "stuck-reclaim",
            }),
          );
        }
      }
    }
    if (stuck.length) {
      console.warn(
        JSON.stringify({
          type: "schedule-stuck-runs-reclaimed",
          count: stuck.length,
        }),
      );
    }
    return stuck.length;
  }

  /**
   * PRD-P2-01 余：已删 / 软删机器人下的 active|paused 定时自动取消（从不 auto-resume）。
   * 结束态（done/cancelled）留给设置页一键清理；电车等 paused 孤儿同样取消，避免扫到已死机器人。
   */
  async function cancelOrphanSchedules(): Promise<number> {
    const rows = await sql
      .unsafe<{ id: string; agent_id: string }[]>(
        `UPDATE chisabot_schedules s
         SET status = 'cancelled', next_run_at = NULL, updated_at = now(),
             last_result = coalesce(
               nullif(trim(last_result), ''),
               '机器人已删除，定时任务已自动取消'
             )
         WHERE s.status IN ('active', 'paused')
           AND NOT EXISTS (
             SELECT 1 FROM agent_profiles p
              WHERE p.agent_id = s.agent_id AND p.deleted_at IS NULL
           )
         RETURNING s.id, s.agent_id`,
      )
      .catch((error) => {
        console.warn(
          JSON.stringify({
            type: "schedule-orphan-cancel-failed",
            reason: reasonWithoutStatement(error).slice(0, 200),
          }),
        );
        return [] as { id: string; agent_id: string }[];
      });
    if (rows.length) {
      for (const row of rows) running.delete(row.id);
      console.warn(
        JSON.stringify({
          type: "schedule-orphans-cancelled",
          count: rows.length,
          agents: [...new Set(rows.map((r) => r.agent_id))],
        }),
      );
    }
    return rows.length;
  }

    /** 原来那段对话还在吗？不在就用这个机器人最近的对话。 */
  async function threadFor(row: Row): Promise<string | null> {
    if (row.im_connection_id) return row.thread_id;
    const exists = await sql
      .unsafe(
        "SELECT 1 FROM openbot_local_threads WHERE id = $1 AND owner_user_id = $2",
        [row.thread_id, row.owner_user_id],
      )
      .catch(() => [1]);
    if (exists.length) return row.thread_id;
    const latest = await sql
      .unsafe<{ thread_id: string }[]>(
        "SELECT thread_id FROM chisabot_bot_threads WHERE owner_user_id = $1 AND agent_id = $2 ORDER BY updated_at DESC LIMIT 1",
        [row.owner_user_id, row.agent_id],
      )
      .catch(() => []);
    return latest[0]?.thread_id ?? null;
  }

  function messageFor(
    row: Row,
    runId: string,
    lateMs: number,
    manual: boolean,
  ): Message {
    // FIX-09：落库/进聊天的时间用绝对日，避免跨日仍写「今天」。
    const at = formatWhenAbsolute(now(), row.timezone, now());
    const late =
      lateMs > 2 * 60_000
        ? `，服务器晚了 ${Math.round(lateMs / 60_000)} 分钟才发出`
        : "";
    const head = manual
      ? `定时任务「${row.title}」手动运行（${at}）。`
      : `定时任务「${row.title}」到点了（${at}${late}）。`;
    return {
      id: `schedule-${runId}`,
      role: "user",
      content: [
        `${SCHEDULE_MARKER}${row.id}:${runId}⟧`,
        head,
        "这是你之前替用户设好的定时任务（不是用户刚发的消息）。现在就照下面的说明做，做完用一两句话告诉用户结果；如果是提醒，就直接、简短地提醒用户要做的事。不要再新建或修改定时任务，除非说明里要求。",
        `说明：${row.instruction}`,
      ].join("\n"),
    } as Message;
  }

  const busyError = (error: unknown) =>
    /already running|thread.*lock|locked|正在运行/i.test(
      error instanceof Error ? error.message : String(error),
    );

  async function fire(
    row: Row,
    runId: string,
    options: { manual: boolean; lateMs: number },
  ) {
    running.add(row.id);
    try {
      if (
        deps.botAvailable &&
        !(await deps
          .botAvailable(row.owner_user_id, row.agent_id)
          .catch(() => true))
      ) {
        await sql.unsafe(
          "UPDATE chisabot_schedules SET status='cancelled', next_run_at=NULL, updated_at=now() WHERE id=$1",
          [row.id],
        );
        await finishRun(
          runId,
          row.id,
          "failed",
          "这个任务的机器人已经删除，任务已自动取消。",
        );
        return;
      }
      const threadId = await threadFor(row);
      if (!threadId) {
        await finishRun(
          runId,
          row.id,
          "failed",
          "原来的对话已经不在了，也找不到这个机器人的其他对话。",
        );
        return;
      }
      const message = messageFor(row, runId, options.lateMs, options.manual);
      const im = Boolean(row.im_connection_id);
      const runTurn = im ? (deps.runImTurn ?? deps.runTurn) : deps.runTurn;
      const initiator: AuditInitiator = im
        ? { kind: "routine", id: `im:${row.im_connection_id}` }
        : { kind: "routine", id: `schedule:${row.id}` };
      let attempt = 0;
      for (;;) {
        // 对话正被一轮占着（网页）：排进收件箱，那一轮下一步就读到（和后台任务交结果一样）。
        if (!im && deps.isThreadActive?.(threadId) && deps.enqueueToThread) {
          await deps.enqueueToThread({
            threadId,
            ownerUserId: row.owner_user_id,
            message,
          });
          await finishRun(
            runId,
            row.id,
            "queued",
            "对话正在进行，已插进那一轮，机器人会在那里处理。",
          );
          return;
        }
        try {
          const result = await runTurn({
            ownerUserId: row.owner_user_id,
            routineId: `schedule:${row.id}`,
            agentId: row.agent_id,
            threadId,
            instruction: (message as { content: string }).content,
            initiator,
            userMessage: message,
            forwardedProps: { chisabotSchedule: { id: row.id, runId } },
          });
          let text = result.replyText?.trim() || "（机器人这次没有文字回复）";
          if (im && deps.pushToIm) {
            try {
              await deps.pushToIm(threadId, result.replyText?.trim() || text);
            } catch (error) {
              text += `\n（推送到 IM 失败：${error instanceof Error ? error.message : String(error)}）`;
            }
          }
          // FIX-01：按回复正文归类，别把「弹不出卡 / 等确认 / 隧道失败」标成绿的已完成。
          const status = classifyScheduleReply(text);
          await finishRun(runId, row.id, status, text);
          if (status !== "ok")
            await deps.releaseThread?.(threadId).catch(() => {});
          return;
        } catch (error) {
          if (deps.isSuspension?.(error)) {
            // FIX-02：定时任务里需要人在场的一步（浏览器交还 / 登录）不再挂成「等你确认」占着对话；
            // 快速失败并释放锁，用户可继续聊天。要做这类事请在网页聊天里当面让机器人做。
            const detail =
              error instanceof Error ? error.message : String(error);
            const reason =
              `这次定时任务做到需要你在场的一步（${detail.slice(0, 160)}），没有继续。` +
              "请在网页聊天里让机器人再做一次，或在 设置 → 权限与审批 把相关类别改成「直接做」。";
            await finishRun(runId, row.id, "failed", reason);
            await deps.releaseThread?.(threadId).catch(() => {});
            return;
          }
          if (deps.isPaused?.(error)) {
            await finishRun(
              runId,
              row.id,
              "skipped",
              "机器人已暂停，这次没有运行。",
            );
            return;
          }
          if (busyError(error) && attempt < BUSY_RETRIES) {
            attempt += 1;
            await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        JSON.stringify({
          type: "schedule-run-failed",
          schedule: row.id,
          run: runId,
          reason: reason.slice(0, 300),
        }),
      );
      await finishRun(
        runId,
        row.id,
        "failed",
        `运行失败：${reason.slice(0, 300)}`,
      ).catch(() => {});
      const threadId = await threadFor(row).catch(() => null);
      if (threadId) await deps.releaseThread?.(threadId).catch(() => {});
    } finally {
      running.delete(row.id);
    }
  }

  /**
   * 一遍扫描：到点的任务，比较交换 next_run_at（同一条语句里插运行记录），抢到的才触发。返回触发了哪些。
   */
  async function sweep(): Promise<{ fired: string[]; skipped: string[] }> {
    const report = { fired: [] as string[], skipped: [] as string[] };
    const due = await sql.unsafe<Row[]>(
      "SELECT * FROM chisabot_schedules WHERE status = 'active' AND next_run_at <= now() ORDER BY next_run_at LIMIT 20",
    );
    const at = now();
    for (const row of due) {
      try {
        const stamp = new Date(row.next_run_at!);
        const lateMs = Math.max(0, at.getTime() - stamp.getTime());
        let nextAt: Date | null = null;
        let status: ScheduleStatus = "active";
        let fireIt = true;
        let skipReason = "";
        if (row.kind === "once") {
          status = "done";
          if (lateMs > ONCE_GRACE_MS) {
            fireIt = false;
            skipReason = `服务器停机，错过了这次提醒（原定 ${formatWhen(stamp, row.timezone, at)}）。`;
          }
        } else {
          try {
            nextAt = nextOccurrence(
              row.cron!,
              row.timezone,
              lateMs > CRON_GRACE_MS ? at : stamp,
            );
            if (nextAt.getTime() <= at.getTime())
              nextAt = nextOccurrence(row.cron!, row.timezone, at);
          } catch {
            status = "paused";
            fireIt = false;
            skipReason = "时间安排读不懂了，任务已暂停，请重新设置时间。";
          }
          if (fireIt && lateMs > CRON_GRACE_MS) {
            fireIt = false;
            skipReason = `服务器停机，跳过了原定 ${formatWhen(stamp, row.timezone, at)} 的这一次。`;
          }
          if (fireIt && running.has(row.id)) {
            fireIt = false;
            skipReason = "上一次还没跑完，这一次跳过。";
          }
        }
        const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
        const won = await sql.unsafe<{ id: string }[]>(
          `WITH upd AS (
             UPDATE chisabot_schedules SET next_run_at = $3, status = $4, updated_at = now()
             WHERE id = $1 AND status = 'active' AND date_trunc('milliseconds', next_run_at) = $2::timestamptz RETURNING id, owner_user_id
           )
           INSERT INTO chisabot_schedule_runs (id, schedule_id, owner_user_id, scheduled_for, status, result, finished_at)
           SELECT $5, id, owner_user_id, $2::timestamptz, $6::text, $7::text, CASE WHEN $6::text = 'running' THEN NULL ELSE now() END FROM upd RETURNING id`,
          [
            row.id,
            row.next_run_at,
            nextAt,
            status,
            runId,
            fireIt ? "running" : "skipped",
            fireIt ? null : skipReason,
          ],
        );
        if (!won.length) continue; // 别的进程先抢到了
        if (!fireIt) {
          await sql.unsafe(
            "UPDATE chisabot_schedules SET last_status='skipped', last_result=$2, updated_at=now() WHERE id=$1",
            [row.id, skipReason],
          );
          report.skipped.push(row.id);
          continue;
        }
        report.fired.push(row.id);
        void fire(row, runId, { manual: false, lateMs });
      } catch (error) {
        console.warn(
          JSON.stringify({
            type: "schedule-sweep-row-failed",
            schedule: row.id,
            reason: String(error).slice(0, 300),
          }),
        );
      }
    }
    return report;
  }

  function start() {
    if (timer) return;
    const tick = async () => {
      if (sweeping) return;
      sweeping = true;
      try {
        await reclaimStuckRuns().catch((error) =>
          console.warn(
            JSON.stringify({
              type: "schedule-stuck-reclaim-failed",
              reason: reasonWithoutStatement(error).slice(0, 200),
            }),
          ),
        );
        await cancelOrphanSchedules().catch((error) =>
          console.warn(
            JSON.stringify({
              type: "schedule-orphan-cancel-tick-failed",
              reason: reasonWithoutStatement(error).slice(0, 200),
            }),
          ),
        );
        const report = await sweep();
        if (report.fired.length || report.skipped.length)
          console.info(JSON.stringify({ type: "schedule-sweep", ...report }));
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "schedule-sweep-failed",
            reason: reasonWithoutStatement(error).slice(0, 300),
          }),
        );
      } finally {
        sweeping = false;
      }
    };
    setTimeout(() => void tick(), 5_000);
    timer = setInterval(() => void tick(), SWEEP_MS);
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function events(owner: string, after: Date): Promise<ScheduleEvent[]> {
    const rows = await sql.unsafe<
      (RunRow & { title: string; agent_id: string; thread_id: string })[]
    >(
      `SELECT r.*, s.title, s.agent_id, s.thread_id FROM chisabot_schedule_runs r JOIN chisabot_schedules s ON s.id = r.schedule_id
       WHERE r.owner_user_id = $1 AND r.finished_at > $2 AND r.finished_at > now() - interval '1 hour' ORDER BY r.finished_at LIMIT 20`,
      [owner, after],
    );
    return rows.map((r) => ({
      runId: r.id,
      scheduleId: r.schedule_id,
      title: r.title,
      agentId: r.agent_id,
      threadId: r.thread_id,
      status: r.status,
      result: r.result ? clip(r.result, 200) : null,
      manual: r.manual,
      finishedAt: iso(r.finished_at!),
    }));
  }

  // ---------- 机器人工具 ----------

  /** 每轮给机器人的用法：现在几点（用户时区）、怎么设。 */
  function guidance(): string {
    const at = now();
    const p = partsIn(at, SCHEDULE_DEFAULT_TZ);
    const week = ["日", "一", "二", "三", "四", "五", "六"][p.weekday];
    const stamp = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}（星期${week}）`;
    return [
      `【定时任务 / 提醒】现在是北京时间 ${stamp}。用户说「明早9点提醒我…」「每天18点…」「每周一…」「半小时后…」时用 schedule_create：`,
      "时间按用户的时区理解（默认 Asia/Shanghai；用户说了别的地方就传 timezone）。一次性给 repeat=once + at「YYYY-MM-DD HH:MM」（自己按上面的现在时间算好日期，「明早」= 明天早上）或 in_minutes；",
      "周期给 daily / weekdays / weekly(days) / monthly(day) / hourly / every_minutes / cron。instruction 写到点时要做的一件事（祈使句，不重复时间），例如「提醒用户：给妈妈打电话」「搜一下今天的科技新闻，挑 5 条给用户」。",
      "建好后用工具返回的 confirmation 原样回一句确认（含时间和下次运行），不要自己另算时间。到点时会在这段对话里收到一条「⟦chisabot:schedule:」开头的消息，照说明做。",
      "看、改、暂停 / 恢复、删、跳过下一次、立即运行分别用 schedule_list / schedule_update / schedule_cancel / schedule_skip_next / schedule_run_now（先 list 拿 id）。",
      "用户要的提醒和定时任务一律用这些工具，不要用 schedule_follow_up（那个只给你自己回头检查用）。用户也可以在 设置 → 定时任务 里管理。",
    ].join("");
  }

  function tools(input: {
    owner: string;
    agentId: string;
    threadId: string;
    imConnectionId?: string | null;
    firing?: boolean;
  }): GrantedTool[] {
    const { owner, agentId, threadId } = input;
    const tool = <T extends z.ZodType>(
      name: string,
      description: string,
      parameters: T,
      run: (args: z.infer<T>) => Promise<string>,
      extra?: { guidance?: string },
    ): GrantedTool => ({
      name,
      ref: `chisabot/${name}`,
      description,
      parameters,
      ...(extra?.guidance ? { guidance: extra.guidance } : {}),
      async execute(args) {
        const parsed = parameters.safeParse(args);
        if (!parsed.success)
          return `${REFUSAL_MARKER} ${name} 参数不对：${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}`;
        try {
          return await run(parsed.data);
        } catch (error) {
          if (error instanceof ScheduleError)
            return `${REFUSAL_MARKER} ${error.message}`;
          throw error;
        }
      },
    });
    const line = (s: ScheduleView) =>
      `- ${s.id}「${s.title}」${s.schedule} · ${s.status === "active" ? (s.nextRunAt ? `下次 ${formatWhen(s.nextRunAt, s.timezone, now())}` : "进行中") : ({ paused: "已暂停", done: "已结束", cancelled: "已取消", active: "" } as const)[s.status]}${s.lastStatus ? ` · 上次${({ ok: "完成", failed: "失败", waiting: "等确认", skipped: "跳过", queued: "已插入对话", running: "运行中" } as const)[s.lastStatus]}` : ""} · 做什么：${clip(s.instruction, 80)}`;
    const confirmation = (s: ScheduleView, verb: string) =>
      s.kind === "once"
        ? `${verb}：${s.nextRunAt ? formatWhen(s.nextRunAt, s.timezone, now()) : s.schedule}${s.timezone !== SCHEDULE_DEFAULT_TZ ? `（${tzLabel(s.timezone)}）` : ""} ${s.title}`
        : `${verb}：${s.schedule} ${s.title}${s.nextRunAt ? `，下次 ${formatWhen(s.nextRunAt, s.timezone, now())}` : ""}`;
    const result = (s: ScheduleView, verb: string) =>
      JSON.stringify({
        ok: true,
        confirmation: confirmation(s, verb),
        schedule: {
          id: s.id,
          title: s.title,
          schedule: s.schedule,
          kind: s.kind,
          status: s.status,
          nextRunAt: s.nextRunAt,
          nextRunText: s.nextRunAt
            ? formatWhen(s.nextRunAt, s.timezone, now())
            : null,
          timezone: s.timezone,
        },
      });
    const whenFields = whenSchema.shape;
    return [
      tool(
        "schedule_create",
        "替用户设一个定时任务或提醒（一次性或周期），到点时在这段对话里执行并回复用户。时间按用户时区（默认北京时间）。",
        z
          .object({
            title: z
              .string()
              .min(1)
              .max(60)
              .describe(
                "几个字的名字，显示在设置和卡片上，例如「喝水提醒」「每日科技新闻」",
              ),
            instruction: z
              .string()
              .min(1)
              .max(4000)
              .describe(
                "到点时要做的一件事，祈使句，不重复时间。提醒类写「提醒用户：…」",
              ),
            timezone: z
              .string()
              .max(60)
              .optional()
              .describe("IANA 时区，用户没说就不填（默认 Asia/Shanghai）"),
            ...whenFields,
          })
          .strict(),
        async (args) => {
          const { title, instruction, timezone, ...when } = args;
          const created = await create({
            owner,
            agentId,
            threadId,
            imConnectionId: input.imConnectionId ?? null,
            title,
            instruction,
            when: when as WhenInput,
            ...(timezone ? { timezone } : {}),
          });
          return result(
            created,
            created.kind === "once" ? "已设好提醒" : "已设好定时任务",
          );
        },
        { guidance: guidance() },
      ),
      tool(
        "schedule_list",
        "列出用户的定时任务和提醒（id、时间安排、下次运行、上次结果）。",
        z
          .object({
            include_ended: z
              .boolean()
              .optional()
              .describe("也列出已结束 / 已取消的"),
          })
          .strict(),
        async (args) => {
          const items = await list(owner, {
            includeEnded: args.include_ended ?? false,
          });
          return items.length ? items.map(line).join("\n") : "还没有定时任务。";
        },
      ),
      tool(
        "schedule_update",
        "改一个定时任务：名字、要做的事、时间（给 repeat 等字段就整个换掉时间安排）、时区，或 paused=true 暂停 / false 恢复。",
        z
          .object({
            id: z.string().min(1).describe("schedule_list 里的 id"),
            title: z.string().max(60).optional(),
            instruction: z.string().max(4000).optional(),
            timezone: z.string().max(60).optional(),
            paused: z.boolean().optional().describe("true 暂停，false 恢复"),
            repeat: whenFields.repeat.optional(),
            at: whenFields.at,
            in_minutes: whenFields.in_minutes,
            days: whenFields.days,
            day: whenFields.day,
            every: whenFields.every,
            cron: whenFields.cron,
          })
          .strict(),
        async (args) => {
          const { id, title, instruction, timezone, paused, repeat, ...rest } =
            args;
          const when = repeat ? ({ repeat, ...rest } as WhenInput) : undefined;
          const updated = await update(owner, id, {
            ...(title ? { title } : {}),
            ...(instruction ? { instruction } : {}),
            ...(timezone ? { timezone } : {}),
            ...(paused !== undefined ? { paused } : {}),
            ...(when ? { when } : {}),
          });
          return result(
            updated,
            updated.status === "paused"
              ? "已暂停"
              : paused === false
                ? "已恢复"
                : "已更新",
          );
        },
      ),
      tool(
        "schedule_cancel",
        "删除一个定时任务（不再运行，不能撤销；只是暂时不要就用 schedule_update paused=true）。",
        z.object({ id: z.string().min(1) }).strict(),
        async (args) => {
          const row = await need(owner, args.id);
          await remove(owner, row.id);
          return `已删除定时任务「${row.title}」。`;
        },
      ),
      tool(
        "schedule_skip_next",
        "跳过一个定时任务的下一次运行（之后照常）；一次性提醒跳过 = 这次不提醒了。",
        z.object({ id: z.string().min(1) }).strict(),
        async (args) => {
          const s = await skipNext(owner, args.id);
          return s.kind === "once"
            ? `已跳过「${s.title}」，这次不提醒了。`
            : `已跳过下一次，「${s.title}」下次 ${s.nextRunAt ? formatWhen(s.nextRunAt, s.timezone, now()) : "—"}。`;
        },
      ),
      tool(
        "schedule_run_now",
        "立即运行一次定时任务（结果会作为一条新消息出现在它所属的对话里；一次性提醒立即运行后就结束）。",
        z.object({ id: z.string().min(1) }).strict(),
        async (args) => {
          if (input.firing)
            return `${REFUSAL_MARKER} 定时任务运行的时候不能再立即运行定时任务。`;
          const { schedule } = await runNow(owner, args.id);
          return `已开始运行「${schedule.title}」，结果会单独发到对话里，不用等待。`;
        },
      ),
    ];
  }

  // ---------- 接口 ----------

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser, bodyLimit({ maxSize: 32_768 }));
    app.onError((error, c) => {
      if (error instanceof ScheduleError)
        return c.json({ error: error.message }, 400);
      if (error instanceof z.ZodError)
        return c.json({ error: error.issues[0]?.message ?? "参数不对。" }, 400);
      console.error(
        JSON.stringify({
          type: "schedules-error",
          error: error.name,
          message: reasonWithoutStatement(error).slice(0, 200),
          route: c.req.path,
        }),
      );
      return c.json({ error: "定时任务暂时不可用，请重试。" }, 503);
    });
    app.get("/", async (c) =>
      c.json({
        schedules: await list(c.var.actor.id, {
          includeEnded: c.req.query("all") === "1",
          runs: 5,
        }),
      }),
    );
    app.get("/events", async (c) => {
      const raw = c.req.query("after");
      const after =
        raw && !Number.isNaN(Date.parse(raw))
          ? new Date(raw)
          : new Date(Date.now() - 60_000);
      return c.json({
        events: await events(c.var.actor.id, after),
        now: new Date().toISOString(),
      });
    });
    app.get("/:id", async (c) =>
      c.json({ schedule: await get(c.var.actor.id, c.req.param("id")) }),
    );
    app.patch("/:id", async (c) => {
      const body = z
        .object({
          title: z.string().max(60).optional(),
          instruction: z.string().max(4000).optional(),
          paused: z.boolean().optional(),
          timezone: z.string().max(60).optional(),
          when: whenSchema.optional(),
        })
        .strict()
        .parse(await c.req.json());
      const { when, ...rest } = body;
      return c.json({
        schedule: await update(c.var.actor.id, c.req.param("id"), {
          ...rest,
          ...(when ? { when } : {}),
        }),
      });
    });
    app.post("/:id/skip", async (c) =>
      c.json({ schedule: await skipNext(c.var.actor.id, c.req.param("id")) }),
    );
    app.post("/:id/run", async (c) =>
      c.json(await runNow(c.var.actor.id, c.req.param("id")), 202),
    );
    app.delete("/:id", async (c) =>
      (await remove(c.var.actor.id, c.req.param("id")))
        ? c.body(null, 204)
        : c.json({ error: "找不到这个定时任务。" }, 404),
    );
    return app;
  }

  return {
    ensure,
    list,
    get,
    create,
    update,
    remove,
    skipNext,
    runNow,
    sweep,
    reclaimStuckRuns,
    cancelOrphanSchedules,
    start,
    stop,
    events,
    tools,
    guidance,
    routes,
    isRunning: (id: string) => running.has(id),
  };
}

/** 一个时刻在某时区的「YYYY-MM-DD HH:MM」。 */
export function localText(at: Date, tz: string): string {
  const p = partsIn(at, tz);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}`;
}

export type Schedules = ReturnType<typeof createSchedules>;

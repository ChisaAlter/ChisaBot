import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Database } from "../src/db/client";
import { DeliveryRejectedError } from "../src/delivery/durable-dispatch";
import { createImDelivery, type ImOutboxRecord } from "../src/im/delivery";
import type { ImInbound } from "../src/im/types";
import {
  detectPlatformWindowExpired,
  ImWindowExpiredError,
  isImWindowExpiredError,
} from "../src/im/window-expiry";
import { createSchedules } from "../src/schedules/service";

type OutboxRow = ImOutboxRecord & {
  created_at: Date;
  updated_at: Date;
};

type ScheduleRow = {
  id: string;
  owner_user_id: string;
  agent_id: string;
  agent_instance_id: string | null;
  thread_id: string;
  im_connection_id: string | null;
  title: string;
  instruction: string;
  kind: "once" | "cron";
  cron: string | null;
  run_at: Date | null;
  timezone: string;
  status: "active" | "paused" | "done" | "cancelled";
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_status:
    | "running"
    | "ok"
    | "failed"
    | "waiting"
    | "skipped"
    | "queued"
    | null;
  last_result: string | null;
  run_count: number;
  created_at: Date;
  updated_at: Date;
};

type ScheduleRunRow = {
  id: string;
  schedule_id: string;
  owner_user_id: string;
  scheduled_for: Date | null;
  started_at: Date;
  finished_at: Date | null;
  status: "running" | "ok" | "failed" | "waiting" | "skipped" | "queued";
  result: string | null;
  manual: boolean;
};

type DurableRunFixture = {
  run_id: string;
  schedule_id: string;
  owner_user_id: string;
  thread_id: string;
  manual: boolean;
  im_connection_id: string | null;
  reply_text: string;
};

function createFakePostgres() {
  const ddlStatements: string[] = [];
  const outbox = new Map<string, OutboxRow>();
  const schedules = new Map<string, ScheduleRow>();
  const scheduleRuns = new Map<string, ScheduleRunRow>();
  const durableRuns = new Map<string, DurableRunFixture>();
  const activeLocks = new Set<string>();
  const lockEvents: string[] = [];
  let seqMs = 0;

  const nextDate = () => new Date(Date.now() + ++seqMs);

  const unsafe = async <T = Record<string, unknown>>(
    rawQuery: string,
    args: unknown[] = [],
  ): Promise<T> => {
    const query = rawQuery.replace(/\s+/g, " ").trim();

    if (
      query.startsWith("CREATE TABLE") ||
      query.includes("ALTER TABLE chisabot_im_outbox")
    ) {
      ddlStatements.push(rawQuery);
      return [] as unknown as T;
    }

    if (query.includes("pg_try_advisory_lock")) {
      const key = String(args[0] ?? "");
      if (activeLocks.has(key)) return [{ locked: false }] as unknown as T;
      activeLocks.add(key);
      lockEvents.push(`acquire:${key}`);
      return [{ locked: true }] as unknown as T;
    }

    if (query.includes("pg_advisory_unlock")) {
      const key = String(args[0] ?? "");
      activeLocks.delete(key);
      lockEvents.push(`unlock:${key}`);
      return [] as unknown as T;
    }

    if (query.startsWith("INSERT INTO chisabot_im_outbox")) {
      const id = String(args[0]);
      if (!outbox.has(id)) {
        const now = nextDate();
        outbox.set(id, {
          id,
          connection_id: String(args[1]),
          owner_user_id: String(args[2]),
          agent_id: String(args[3]),
          thread_id: String(args[4]),
          inbound: JSON.parse(String(args[5])) as ImInbound,
          text: String(args[6]),
          chunks: JSON.parse(String(args[7])) as string[],
          files:
            args[8] !== undefined
              ? (JSON.parse(String(args[8])) as unknown[])
              : [],
          state: "queued",
          receipt: null,
          error: null,
          window_expired_at: null,
          created_at: now,
          updated_at: now,
        });
      }
      return [] as unknown as T;
    }

    if (query.startsWith("SELECT * FROM chisabot_im_outbox WHERE id=$1")) {
      const row = outbox.get(String(args[0]));
      return (row ? [{ ...row }] : []) as unknown as T;
    }

    if (
      query.startsWith("UPDATE chisabot_im_outbox SET state='window_expired'")
    ) {
      const row = outbox.get(String(args[0]));
      if (!row) return [] as unknown as T;
      const now = nextDate();
      row.state = "window_expired";
      row.window_expired_at = now.toISOString();
      row.receipt = null;
      row.error = args[1] == null ? null : String(args[1]);
      row.updated_at = now;
      return [{ ...row }] as unknown as T;
    }

    if (query.startsWith("UPDATE chisabot_im_outbox SET state=$2")) {
      const row = outbox.get(String(args[0]));
      if (!row) return [] as unknown as T;
      row.state = String(args[1]) as OutboxRow["state"];
      row.receipt = args[2]
        ? (JSON.parse(String(args[2])) as ImOutboxRecord["receipt"])
        : null;
      row.error = args[3] == null ? null : String(args[3]);
      row.updated_at = nextDate();
      return [{ ...row }] as unknown as T;
    }

    if (query.includes("to_regclass('public.chisabot_dsh_runs')")) {
      return [{ available: durableRuns.size > 0 }] as unknown as T;
    }

    if (
      query.includes("FROM chisabot_schedule_runs r JOIN chisabot_schedules s")
    ) {
      const matched = [...durableRuns.values()].filter((fixture) => {
        const run = scheduleRuns.get(fixture.run_id);
        return run && (run.status === "running" || run.status === "waiting");
      });
      return matched.map((fixture) => ({
        id: fixture.run_id,
        schedule_id: fixture.schedule_id,
        owner_user_id: fixture.owner_user_id,
        thread_id: fixture.thread_id,
        run_id: `dsh_${fixture.run_id}`,
        manual: fixture.manual,
        im_connection_id: fixture.im_connection_id,
      })) as unknown as T;
    }

    if (query.includes("FROM chisabot_local_runs r")) {
      return [] as unknown as T;
    }

    if (query.includes("FROM chisabot_dsh_runs d")) {
      const owner = String(args[0]);
      const threadId = String(args[1]);
      const runId = args[2] == null ? null : String(args[2]);
      const found = [...durableRuns.values()].find(
        (item) =>
          item.owner_user_id === owner &&
          item.thread_id === threadId &&
          (runId === null || `dsh_${item.run_id}` === runId),
      );
      if (!found) return [] as unknown as T;
      return [
        {
          run_id: `dsh_${found.run_id}`,
          status: "finished",
          local_status: "finished",
          messages: [
            {
              id: `msg_${found.run_id}`,
              role: "assistant",
              content: found.reply_text,
            },
          ],
          initial_messages: [],
          terminal: { type: "RUN_FINISHED" },
          projection_events: [{ messageId: `msg_${found.run_id}` }],
        },
      ] as unknown as T;
    }

    if (
      query.startsWith("UPDATE chisabot_schedule_runs r SET status = 'failed'")
    ) {
      return [] as unknown as T;
    }

    if (query.startsWith("SELECT count(*)::int AS n FROM chisabot_schedules")) {
      const owner = String(args[0]);
      const n = [...schedules.values()].filter(
        (row) =>
          row.owner_user_id === owner &&
          (row.status === "active" || row.status === "paused"),
      ).length;
      return [{ n }] as unknown as T;
    }

    if (query.startsWith("INSERT INTO chisabot_schedules")) {
      const now = nextDate();
      const row: ScheduleRow = {
        id: String(args[0]),
        owner_user_id: String(args[1]),
        agent_id: String(args[2]),
        agent_instance_id: args[3] == null ? null : String(args[3]),
        thread_id: String(args[4]),
        im_connection_id: args[5] == null ? null : String(args[5]),
        title: String(args[6]),
        instruction: String(args[7]),
        kind: String(args[8]) as ScheduleRow["kind"],
        cron: args[9] == null ? null : String(args[9]),
        run_at: args[10] ? new Date(String(args[10])) : null,
        timezone: String(args[11]),
        status: "active",
        next_run_at: args[12] ? new Date(String(args[12])) : null,
        last_run_at: null,
        last_status: null,
        last_result: null,
        run_count: 0,
        created_at: now,
        updated_at: now,
      };
      schedules.set(row.id, row);
      return [{ ...row }] as unknown as T;
    }

    if (
      query.startsWith(
        "SELECT * FROM chisabot_schedules WHERE status = 'active' AND next_run_at <= now()",
      )
    ) {
      const currentMs = Date.now();
      const dueRows = [...schedules.values()]
        .filter(
          (row) =>
            row.status === "active" &&
            row.next_run_at !== null &&
            row.next_run_at.getTime() <= currentMs,
        )
        .sort(
          (a, b) =>
            (a.next_run_at?.getTime() ?? 0) - (b.next_run_at?.getTime() ?? 0),
        )
        .slice(0, 20)
        .map((row) => ({ ...row }));
      return dueRows as unknown as T;
    }

    if (
      query.startsWith(
        "SELECT id FROM chisabot_schedules WHERE id = $1 AND status = 'active'",
      )
    ) {
      const row = schedules.get(String(args[0]));
      const expectedMs = new Date(String(args[1])).getTime();
      const matched =
        row &&
        row.status === "active" &&
        row.next_run_at !== null &&
        Math.floor(row.next_run_at.getTime()) === Math.floor(expectedMs);
      return (matched ? [{ id: row.id }] : []) as unknown as T;
    }

    if (
      query.startsWith(
        "SELECT 1 FROM chisabot_schedule_runs WHERE schedule_id = $1 AND status = 'running'",
      )
    ) {
      const scheduleId = String(args[0]);
      const running = [...scheduleRuns.values()].some(
        (run) => run.schedule_id === scheduleId && run.status === "running",
      );
      return (running ? [{ "?column?": 1 }] : []) as unknown as T;
    }

    if (query.startsWith("WITH upd AS ( UPDATE chisabot_schedules")) {
      const id = String(args[0]);
      const expectedMs = new Date(String(args[1])).getTime();
      const row = schedules.get(id);
      if (
        row?.status !== "active" ||
        row.next_run_at === null ||
        Math.floor(row.next_run_at.getTime()) !== Math.floor(expectedMs)
      ) {
        return [] as unknown as T;
      }
      row.next_run_at = args[2] ? new Date(String(args[2])) : null;
      row.status = String(args[3]) as ScheduleRow["status"];
      row.updated_at = nextDate();
      const runId = String(args[4]);
      const runStatus = String(args[5]) as ScheduleRunRow["status"];
      const runResult = args[6] == null ? null : String(args[6]);
      const now = nextDate();
      scheduleRuns.set(runId, {
        id: runId,
        schedule_id: row.id,
        owner_user_id: row.owner_user_id,
        scheduled_for: new Date(expectedMs),
        started_at: now,
        finished_at: runStatus === "running" ? null : now,
        status: runStatus,
        result: runResult,
        manual: false,
      });
      return [{ id: runId }] as unknown as T;
    }

    if (query === "SELECT status FROM chisabot_schedules WHERE id = $1") {
      const row = schedules.get(String(args[0]));
      return (row ? [{ status: row.status }] : []) as unknown as T;
    }

    if (
      query.startsWith(
        "UPDATE chisabot_schedule_runs SET status=$2, result=$3, finished_at=now() WHERE id=$1",
      )
    ) {
      const run = scheduleRuns.get(String(args[0]));
      if (run) {
        run.status = String(args[1]) as ScheduleRunRow["status"];
        run.result = args[2] == null ? null : String(args[2]);
        run.finished_at = nextDate();
      }
      return [] as unknown as T;
    }

    if (
      query.startsWith(
        "UPDATE chisabot_schedules SET last_run_at=now(), last_status=$2, last_result=$3, run_count=run_count+1",
      )
    ) {
      const row = schedules.get(String(args[0]));
      if (row) {
        const now = nextDate();
        row.last_run_at = now;
        row.last_status = String(args[1]) as ScheduleRow["last_status"];
        row.last_result = args[2] == null ? null : String(args[2]);
        row.run_count += 1;
        row.updated_at = now;
      }
      return [] as unknown as T;
    }

    if (
      query.startsWith(
        "DELETE FROM chisabot_schedule_runs WHERE schedule_id = $1 AND id NOT IN",
      )
    ) {
      return [] as unknown as T;
    }

    if (
      query.startsWith(
        "SELECT status FROM chisabot_schedule_runs WHERE schedule_id = $1 ORDER BY started_at DESC LIMIT $2",
      )
    ) {
      const scheduleId = String(args[0]);
      const limit = Number(args[1]);
      const rows = [...scheduleRuns.values()]
        .filter((run) => run.schedule_id === scheduleId)
        .sort((a, b) => b.started_at.getTime() - a.started_at.getTime())
        .slice(0, limit)
        .map((run) => ({ status: run.status }));
      return rows as unknown as T;
    }

    if (
      query.startsWith(
        "UPDATE chisabot_schedules SET status='paused', next_run_at=NULL, updated_at=now(), last_result = coalesce($2, last_result) WHERE id=$1 AND status='active' RETURNING id",
      )
    ) {
      const row = schedules.get(String(args[0]));
      if (row?.status !== "active") return [] as unknown as T;
      row.status = "paused";
      row.next_run_at = null;
      row.last_result = args[1] == null ? row.last_result : String(args[1]);
      row.updated_at = nextDate();
      return [{ id: row.id }] as unknown as T;
    }

    if (
      query ===
      "SELECT * FROM chisabot_schedules WHERE id = $1 AND owner_user_id = $2"
    ) {
      const row = schedules.get(String(args[0]));
      const owner = String(args[1]);
      return (row && row.owner_user_id === owner
        ? [{ ...row }]
        : []) as unknown as T;
    }

    if (
      query ===
      "SELECT * FROM chisabot_schedule_runs WHERE schedule_id = $1 ORDER BY started_at DESC LIMIT $2"
    ) {
      const scheduleId = String(args[0]);
      const limit = Number(args[1]);
      const rows = [...scheduleRuns.values()]
        .filter((run) => run.schedule_id === scheduleId)
        .sort((a, b) => b.started_at.getTime() - a.started_at.getTime())
        .slice(0, limit)
        .map((run) => ({ ...run }));
      return rows as unknown as T;
    }

    if (query.startsWith("UPDATE chisabot_schedules SET next_run_at = NULL")) {
      return [] as unknown as T;
    }

    throw new Error(`未模拟的 SQL: ${query}`);
  };

  const client = {
    unsafe,
    begin: async <R>(fn: (tx: typeof client) => Promise<R>): Promise<R> =>
      fn(client),
    reserve: async () => ({
      unsafe,
      release: () => {
        lockEvents.push("release-conn");
      },
    }),
  };

  const database = { $client: client } as unknown as Database;

  return {
    database,
    ddlStatements,
    outbox,
    schedules,
    scheduleRuns,
    durableRuns,
    activeLocks,
    lockEvents,
    makeScheduleDue(id: string) {
      const row = schedules.get(id);
      if (row) {
        row.next_run_at = new Date(Date.now() - 60_000);
      }
    },
    seedDurableRun(fixture: DurableRunFixture) {
      const now = nextDate();
      scheduleRuns.set(fixture.run_id, {
        id: fixture.run_id,
        schedule_id: fixture.schedule_id,
        owner_user_id: fixture.owner_user_id,
        scheduled_for: now,
        started_at: now,
        finished_at: null,
        status: "running",
        result: null,
        manual: fixture.manual,
      });
      durableRuns.set(fixture.run_id, fixture);
    },
  };
}

const sampleInbound: ImInbound = {
  messageId: "msg_1",
  chatType: "private",
  chatId: "user_1",
  userId: "user_1",
  text: "早上好",
  mentioned: true,
  reply: {},
};

const settleAsync = (ms = 40) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("ImWindowExpiredError 与 detectPlatformWindowExpired", () => {
  test("isImWindowExpiredError 识别实例与同名 Error，排除普通错误", () => {
    const err = new ImWindowExpiredError(
      "微信 48h 窗口已关闭",
      "weixin",
      45015,
    );
    expect(err.name).toBe("ImWindowExpiredError");
    expect(err.platform).toBe("weixin");
    expect(err.code).toBe(45015);
    expect(isImWindowExpiredError(err)).toBe(true);

    const crossRealm = new Error("window expired");
    crossRealm.name = "ImWindowExpiredError";
    expect(isImWindowExpiredError(crossRealm)).toBe(true);

    expect(isImWindowExpiredError(new Error("timeout"))).toBe(false);
    expect(
      isImWindowExpiredError(new DeliveryRejectedError("bad", false)),
    ).toBe(false);
    expect(isImWindowExpiredError({ name: "ImWindowExpiredError" })).toBe(
      false,
    );
    expect(isImWindowExpiredError(null)).toBe(false);
  });

  test("识别微信、QQ 官方、飞书与 Telegram 403 窗口过期/拉黑信号，且不误报普通故障", () => {
    expect(
      detectPlatformWindowExpired(
        "weixin",
        200,
        '{"errcode":45015,"errmsg":"response time out of limit"}',
      ),
    ).toBe(true);
    expect(detectPlatformWindowExpired("weixin", 200, "45047")).toBe(true);
    expect(
      detectPlatformWindowExpired("weixin", 200, "out of response count limit"),
    ).toBe(true);

    expect(detectPlatformWindowExpired("qq_official", 400, "304023")).toBe(
      true,
    );
    expect(
      detectPlatformWindowExpired(
        "qq_official",
        400,
        "code 40034: passive reply expired",
      ),
    ).toBe(true);

    expect(
      detectPlatformWindowExpired("feishu", 400, "回复窗口已过期，无法发送"),
    ).toBe(true);
    expect(detectPlatformWindowExpired("feishu", 400, "window_expired")).toBe(
      true,
    );

    expect(
      detectPlatformWindowExpired(
        "telegram",
        403,
        "Forbidden: bot was blocked by the user",
      ),
    ).toBe(true);
    expect(
      detectPlatformWindowExpired(
        "telegram",
        403,
        "Forbidden: user is deactivated",
      ),
    ).toBe(true);

    expect(
      detectPlatformWindowExpired("telegram", 500, "Internal Server Error"),
    ).toBe(false);
    expect(
      detectPlatformWindowExpired("weixin", 200, "40001 invalid credential"),
    ).toBe(false);
    expect(detectPlatformWindowExpired("qq_official", 400, "")).toBe(false);
  });
});

describe("createImDelivery 窗口过期优雅降级", () => {
  test("ensure() 幂等添加 window_expired_at 列；stage() 兼容持久化 files", async () => {
    const pg = createFakePostgres();
    const delivery = createImDelivery(pg.database);
    await delivery.ensure();
    await delivery.ensure();

    const ddl = pg.ddlStatements.join("\n");
    expect(ddl).toContain(
      "ALTER TABLE chisabot_im_outbox ADD COLUMN IF NOT EXISTS window_expired_at timestamptz",
    );
    expect(ddl).toContain(
      "ALTER TABLE chisabot_im_outbox ADD COLUMN IF NOT EXISTS files jsonb",
    );

    await delivery.stage({
      id: "out_files_1",
      connection_id: "im_conn_1",
      owner_user_id: "user_a",
      agent_id: "bot_1",
      thread_id: "thread_1",
      inbound: sampleInbound,
      text: "带附件消息",
      chunks: ["带附件消息"],
      files: [{ name: "report.pdf", size: 128 }],
    });
    const saved = await delivery.get("out_files_1");
    expect(saved?.files).toEqual([{ name: "report.pdf", size: 128 }]);
    expect(saved?.state).toBe("queued");

    await delivery.stage({
      id: "out_nofiles_1",
      connection_id: "im_conn_1",
      owner_user_id: "user_a",
      agent_id: "bot_1",
      thread_id: "thread_1",
      inbound: sampleInbound,
      text: "纯文本消息",
      chunks: ["纯文本消息"],
    });
    const plain = await delivery.get("out_nofiles_1");
    expect(plain?.files).toEqual([]);
  });

  test("dispatch 遇到 ImWindowExpiredError 时落库 window_expired + window_expired_at，并在锁释放后触发 onWindowExpired", async () => {
    const pg = createFakePostgres();
    const notifications: Array<{ record: ImOutboxRecord; reason: string }> = [];
    const delivery = createImDelivery(pg.database, {
      onWindowExpired: async (record, reason) => {
        pg.lockEvents.push("onWindowExpired");
        expect(pg.activeLocks.size).toBe(0);
        notifications.push({ record, reason });
      },
    });
    await delivery.ensure();

    const outboxId = `out_exp_${randomUUID().slice(0, 8)}`;
    await delivery.stage({
      id: outboxId,
      connection_id: "im_conn_wx",
      owner_user_id: "user_wx",
      agent_id: "bot_wx",
      thread_id: "thread_wx",
      inbound: sampleInbound,
      text: "今天的日报已经整理完毕",
      chunks: ["今天的日报已经整理完毕"],
    });

    let sendAttempts = 0;
    const result = await delivery.dispatch(outboxId, async () => ({
      send: async () => {
        sendAttempts += 1;
        throw new ImWindowExpiredError(
          "微信 48h 客服互动窗口已过期（45015）",
          "weixin",
          45015,
        );
      },
    }));

    expect(result).toBe("window_expired");
    expect(sendAttempts).toBe(1);

    const stored = await delivery.get(outboxId);
    expect(stored).not.toBeNull();
    expect(stored?.state).toBe("window_expired");
    expect(stored?.window_expired_at).toBeTruthy();
    expect(stored?.receipt).toBeNull();
    expect(stored?.error).toBe("微信 48h 客服互动窗口已过期（45015）");

    expect(notifications).toHaveLength(1);
    const firstNotif = notifications[0];
    expect(firstNotif?.reason).toBe("微信 48h 客服互动窗口已过期（45015）");
    expect(firstNotif?.record.state).toBe("window_expired");
    expect(firstNotif?.record.window_expired_at).toBeTruthy();

    expect(pg.lockEvents).toEqual([
      `acquire:im-outbox:${outboxId}`,
      `unlock:im-outbox:${outboxId}`,
      "release-conn",
      "onWindowExpired",
    ]);

    const secondAttempt = await delivery.dispatch(outboxId, async () => ({
      send: async () => {
        sendAttempts += 1;
        return { messageIds: ["should-not-send"] };
      },
    }));
    expect(secondAttempt).toBe("window_expired");
    expect(sendAttempts).toBe(1);
    expect(notifications).toHaveLength(1);
  });

  test("单参 createImDelivery 向后兼容，普通 DeliveryRejectedError 仍标 failed 且不触发 onWindowExpired", async () => {
    const pg = createFakePostgres();
    const compatDelivery = createImDelivery(pg.database);
    await compatDelivery.stage({
      id: "out_compat",
      connection_id: "im_conn_1",
      owner_user_id: "user_1",
      agent_id: "bot_1",
      thread_id: "thread_1",
      inbound: sampleInbound,
      text: "兼容测试",
      chunks: ["兼容测试"],
    });
    expect(
      await compatDelivery.dispatch("out_compat", async () => ({
        send: async () => {
          throw new ImWindowExpiredError(
            "QQ 被动回复超时（304023）",
            "qq_official",
            304023,
          );
        },
      })),
    ).toBe("window_expired");
    expect((await compatDelivery.get("out_compat"))?.state).toBe(
      "window_expired",
    );

    let notified = false;
    const deliveryWithHook = createImDelivery(pg.database, {
      onWindowExpired: async () => {
        notified = true;
      },
    });
    await deliveryWithHook.stage({
      id: "out_hard_fail",
      connection_id: "im_conn_1",
      owner_user_id: "user_1",
      agent_id: "bot_1",
      thread_id: "thread_1",
      inbound: sampleInbound,
      text: "硬失败测试",
      chunks: ["硬失败测试"],
    });
    const failedState = await deliveryWithHook.dispatch(
      "out_hard_fail",
      async () => ({
        send: async () => {
          throw new DeliveryRejectedError("凭据失效", false);
        },
      }),
    );
    expect(failedState).toBe("failed");
    const failedRow = await deliveryWithHook.get("out_hard_fail");
    expect(failedRow?.state).toBe("failed");
    expect(failedRow?.window_expired_at).toBeNull();
    expect(notified).toBe(false);
  });

  test("onWindowExpired 回调本身抛错时仍安全返回 window_expired", async () => {
    const pg = createFakePostgres();
    const delivery = createImDelivery(pg.database, {
      onWindowExpired: async () => {
        throw new Error("notification sink temporary unavailable");
      },
    });
    await delivery.stage({
      id: "out_notify_err",
      connection_id: "im_conn_1",
      owner_user_id: "user_1",
      agent_id: "bot_1",
      thread_id: "thread_1",
      inbound: sampleInbound,
      text: "正文",
      chunks: ["正文"],
    });
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const state = await delivery.dispatch("out_notify_err", async () => ({
        send: async () => {
          throw new ImWindowExpiredError("窗口关闭");
        },
      }));
      expect(state).toBe("window_expired");
      expect((await delivery.get("out_notify_err"))?.state).toBe(
        "window_expired",
      );
      expect(
        warnings.some((line) =>
          line.includes("im-window-expired-notify-failed"),
        ),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("createSchedules CB-027 定时任务窗口过期免误停", () => {
  test("pushToIm 连续 5 次返回 window_expired 结果时保持 active，保留完整内容与提示", async () => {
    const pg = createFakePostgres();
    const schedules = createSchedules(pg.database, {
      runTurn: async () => ({ replyText: "今日待办：1. 周会 2. 提交报告" }),
      pushToIm: async () => ({ status: "window_expired", windowExpired: true }),
      retryDelayMs: 1,
    });
    await schedules.ensure();

    const task = await schedules.create({
      owner: "u_cb027_ret",
      agentId: "bot_1",
      threadId: "im-thread-1",
      imConnectionId: "im_wx_1",
      title: "每日待办提醒",
      instruction: "汇报今日待办",
      when: { repeat: "daily", at: "09:00" },
    });

    for (let i = 0; i < 5; i += 1) {
      pg.makeScheduleDue(task.id);
      const report = await schedules.sweep();
      expect(report.fired).toContain(task.id);
      await settleAsync();
    }

    const after = await schedules.get("u_cb027_ret", task.id, 10);
    expect(after.status).toBe("active");
    expect(after.lastStatus).toBe("ok");
    expect(after.runCount).toBe(5);
    expect(after.nextRunAt).not.toBeNull();
    expect(after.lastResult).toContain("今日待办：1. 周会 2. 提交报告");
    expect(after.lastResult).toContain("IM 会话 24h 互动窗口已过期");
    expect(after.recentRuns?.map((run) => run.status)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
  });

  test("pushToIm 连续 5 次抛出 ImWindowExpiredError 时保持 active 且不累加 fail_streak", async () => {
    const pg = createFakePostgres();
    const schedules = createSchedules(pg.database, {
      runTurn: async () => ({ replyText: "晚间复盘：今日指标全部正常" }),
      pushToIm: async () => {
        throw new ImWindowExpiredError(
          "QQ 官方被动回复 msg_id 已过 5 分钟（304023）",
          "qq_official",
          304023,
        );
      },
      retryDelayMs: 1,
    });
    await schedules.ensure();

    const task = await schedules.create({
      owner: "u_cb027_err",
      agentId: "bot_1",
      threadId: "im-thread-2",
      imConnectionId: "im_qq_1",
      title: "晚间复盘",
      instruction: "生成晚间复盘",
      when: { repeat: "daily", at: "21:00" },
    });

    for (let i = 0; i < 5; i += 1) {
      pg.makeScheduleDue(task.id);
      const report = await schedules.sweep();
      expect(report.fired).toContain(task.id);
      await settleAsync();
    }

    const after = await schedules.get("u_cb027_err", task.id, 10);
    expect(after.status).toBe("active");
    expect(after.lastStatus).toBe("ok");
    expect(after.runCount).toBe(5);
    expect(after.lastResult).toContain("晚间复盘：今日指标全部正常");
    expect(after.lastResult).toContain("IM 会话 24h 互动窗口已过期");
    expect(after.recentRuns?.every((run) => run.status === "ok")).toBe(true);
  });

  test("耐久恢复路径（reconcileDurableRuns）遇到窗口过期同样保留结果并保持 active", async () => {
    const pg = createFakePostgres();
    let mode: "return_flag" | "throw_err" = "return_flag";
    const schedules = createSchedules(pg.database, {
      runTurn: async () => ({ replyText: "unused" }),
      pushToIm: async () => {
        if (mode === "throw_err") {
          throw new ImWindowExpiredError("飞书回复窗口过期", "feishu");
        }
        return { status: "window_expired" };
      },
      retryDelayMs: 1,
    });
    await schedules.ensure();

    const task = await schedules.create({
      owner: "u_cb027_dsh",
      agentId: "bot_1",
      threadId: "im-thread-dsh",
      imConnectionId: "im_feishu_1",
      title: "耐久恢复巡检",
      instruction: "检查状态",
      when: { repeat: "hourly" },
    });

    for (let i = 0; i < 4; i += 1) {
      mode = i % 2 === 0 ? "return_flag" : "throw_err";
      pg.seedDurableRun({
        run_id: `run_dsh_${i}`,
        schedule_id: task.id,
        owner_user_id: "u_cb027_dsh",
        thread_id: "im-thread-dsh",
        manual: false,
        im_connection_id: "im_feishu_1",
        reply_text: `耐久恢复完整结论 #${i}`,
      });
      await schedules.sweep();
    }

    const after = await schedules.get("u_cb027_dsh", task.id, 10);
    expect(after.status).toBe("active");
    expect(after.lastStatus).toBe("ok");
    expect(after.runCount).toBe(4);
    expect(after.lastResult).toContain("耐久恢复完整结论 #3");
    expect(after.lastResult).toContain("IM 会话 24h 互动窗口已过期");
  });

  test("真实的执行错误或非窗口过期硬错误连续 3 次仍触发 auto-paused", async () => {
    const pg = createFakePostgres();
    let failureMode: "turn_error" | "push_error" = "turn_error";
    const schedules = createSchedules(pg.database, {
      runTurn: async () => {
        if (failureMode === "turn_error") {
          throw new Error("模型推理超时 ERR_TIMEOUT");
        }
        return { replyText: "正常结果" };
      },
      pushToIm: async () => {
        if (failureMode === "push_error") {
          throw new Error("IM 连接已停用或删除");
        }
      },
      retryDelayMs: 1,
    });
    await schedules.ensure();

    const taskA = await schedules.create({
      owner: "u_fail_turn",
      agentId: "bot_1",
      threadId: "im-thread-fail-a",
      imConnectionId: "im_1",
      title: "真实执行失败任务",
      instruction: "执行任务",
      when: { repeat: "hourly" },
    });

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      for (let i = 0; i < 3; i += 1) {
        pg.makeScheduleDue(taskA.id);
        await schedules.sweep();
        await settleAsync();
      }
      const afterA = await schedules.get("u_fail_turn", taskA.id, 10);
      expect(afterA.status).toBe("paused");
      expect(afterA.lastStatus).toBe("failed");
      expect(afterA.nextRunAt).toBeNull();
      expect(afterA.lastResult).toContain("连续失败 3 次，已自动暂停");
      expect(
        warnings.some(
          (line) =>
            line.includes("schedule-auto-paused") && line.includes(taskA.id),
        ),
      ).toBe(true);

      failureMode = "push_error";
      const taskB = await schedules.create({
        owner: "u_fail_push",
        agentId: "bot_1",
        threadId: "im-thread-fail-b",
        imConnectionId: "im_2",
        title: "非窗口过期推送失败任务",
        instruction: "执行任务",
        when: { repeat: "hourly" },
      });
      for (let i = 0; i < 3; i += 1) {
        pg.makeScheduleDue(taskB.id);
        await schedules.sweep();
        await settleAsync();
      }
      const afterB = await schedules.get("u_fail_push", taskB.id, 10);
      expect(afterB.status).toBe("paused");
      expect(afterB.lastStatus).toBe("failed");
    } finally {
      console.warn = originalWarn;
    }
  });
});

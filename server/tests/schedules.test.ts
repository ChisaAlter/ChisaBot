import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { describeCronZh, describeSchedule, formatWhen, parseScheduleMessage } from "../../shared/schedules";
import { createDatabase } from "../src/db/client";
import { createSchedules, resolveWhen, ScheduleError, zonedToUtc } from "../src/schedules/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** 定时任务 / 提醒（DESIGN.md §55）：时间解析、比较交换不重复触发、一次性 / 周期 / 错过 / 暂停 / 跳过 / 立即运行 / IM 推送。 */
const NOW = new Date("2026-10-14T13:42:00Z"); // 北京时间 2026-10-14 21:42 周三
const TZ = "Asia/Shanghai";

describe("resolveWhen", () => {
  test("once at local time in the user's zone", () => {
    const r = resolveWhen({ repeat: "once", at: "2026-10-15 09:00" }, TZ, NOW);
    expect(r.kind).toBe("once");
    expect(r.runAt!.toISOString()).toBe("2026-10-15T01:00:00.000Z");
    expect(r.next.toISOString()).toBe("2026-10-15T01:00:00.000Z");
    expect(formatWhen(r.runAt!, TZ, NOW)).toBe("明天 09:00");
  });
  test("once in another zone", () => {
    const r = resolveWhen({ repeat: "once", at: "2026-10-15 09:00" }, "America/New_York", NOW);
    expect(r.runAt!.toISOString()).toBe("2026-10-15T13:00:00.000Z");
  });
  test("in_minutes", () => {
    const r = resolveWhen({ repeat: "once", in_minutes: 30 }, TZ, NOW);
    expect(r.runAt!.toISOString()).toBe("2026-10-14T14:12:00.000Z");
  });
  test("past and malformed are refused in Chinese", () => {
    expect(() => resolveWhen({ repeat: "once", at: "2026-10-14 09:00" }, TZ, NOW)).toThrow(/已经过去/);
    expect(() => resolveWhen({ repeat: "once", at: "明早九点" }, TZ, NOW)).toThrow(ScheduleError);
    expect(() => resolveWhen({ repeat: "once", at: "2026-02-30 09:00" }, TZ, NOW)).toThrow(/不存在/);
    expect(() => resolveWhen({ repeat: "daily", at: "25:00" }, TZ, NOW)).toThrow(/HH:MM/);
    expect(() => resolveWhen({ repeat: "cron", cron: "*/5 * * * *" }, TZ, NOW)).toThrow(/15 分钟/);
    expect(() => resolveWhen({ repeat: "every_minutes", every: 25 }, TZ, NOW)).toThrow(ScheduleError);
    expect(() => resolveWhen({ repeat: "daily", at: "09:00" }, "Mars/Base", NOW)).toThrow(/时区/);
  });
  test("recurring shapes become cron with the next run in the zone", () => {
    const daily = resolveWhen({ repeat: "daily", at: "09:00" }, TZ, NOW);
    expect(daily.cron).toBe("0 9 * * *");
    expect(daily.next.toISOString()).toBe("2026-10-15T01:00:00.000Z");
    expect(resolveWhen({ repeat: "weekdays", at: "18:30" }, TZ, NOW).cron).toBe("30 18 * * 1-5");
    const weekly = resolveWhen({ repeat: "weekly", days: [1, 7], at: "08:00" }, TZ, NOW);
    expect(weekly.cron).toBe("0 8 * * 0,1");
    expect(weekly.next.toISOString()).toBe("2026-10-18T00:00:00.000Z"); // 周日 08:00
    expect(resolveWhen({ repeat: "monthly", day: 1, at: "09:00" }, TZ, NOW).cron).toBe("0 9 1 * *");
    expect(resolveWhen({ repeat: "every_minutes", every: 30 }, TZ, NOW).cron).toBe("*/30 * * * *");
    expect(resolveWhen({ repeat: "every_minutes", every: 120 }, TZ, NOW).cron).toBe("0 */2 * * *");
    expect(resolveWhen({ repeat: "hourly" }, TZ, NOW).cron).toBe("0 * * * *");
  });
  test("chinese descriptions", () => {
    expect(describeCronZh("0 9 * * *")).toBe("每天 09:00");
    expect(describeCronZh("30 18 * * 1-5")).toBe("工作日 18:30");
    expect(describeCronZh("0 8 * * 0,1")).toBe("每周一、周日 08:00");
    expect(describeCronZh("0 9 1 * *")).toBe("每月 1 日 09:00");
    expect(describeCronZh("*/30 * * * *")).toBe("每 30 分钟");
    expect(describeCronZh("0 * * * *")).toBe("每小时整点");
    expect(describeSchedule({ kind: "once", cron: null, runAt: "2026-10-15T01:00:00Z", timezone: TZ }, NOW)).toBe("明天 09:00（一次）");
    expect(describeSchedule({ kind: "cron", cron: "0 9 * * *", runAt: null, timezone: "America/New_York" }, NOW)).toBe("每天 09:00（纽约时间）");
  });
  test("zonedToUtc and marker parsing", () => {
    expect(zonedToUtc(2026, 10, 15, 9, 0, TZ).toISOString()).toBe("2026-10-15T01:00:00.000Z");
    const parsed = parseScheduleMessage("⟦chisabot:schedule:sch_1:run_2⟧\n定时任务「喝水」到点了（今天 21:42）。\n这是…\n说明：提醒用户：喝水");
    expect(parsed).toEqual({ scheduleId: "sch_1", runId: "run_2", headline: "定时任务「喝水」到点了（今天 21:42）。", instruction: "提醒用户：喝水" });
  });
});

const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("schedules (database)", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const sql = url ? database.$client : (null as never);
  const owner = `schedtest-${randomUUID().slice(0, 8)}`;
  const turns: { threadId: string; content: string; initiator?: string }[] = [];
  const pushes: { threadId: string; text: string }[] = [];
  let busy = new Set<string>();
  const enqueued: string[] = [];
  let deletedBots = new Set<string>();
  const deps = {
    runTurn: async (input: { threadId: string; userMessage?: { content?: unknown }; initiator?: { id?: string } }) => {
      await new Promise((r) => setTimeout(r, 30));
      turns.push({ threadId: input.threadId, content: String(input.userMessage?.content ?? ""), initiator: input.initiator?.id });
      return { replyText: "⏰ 该喝水了" };
    },
    pushToIm: async (threadId: string, text: string) => {
      pushes.push({ threadId, text });
    },
    isThreadActive: (threadId: string) => busy.has(threadId),
    enqueueToThread: async (input: { threadId: string }) => {
      enqueued.push(input.threadId);
      return true;
    },
    botAvailable: async (_owner: string, agentId: string) => !deletedBots.has(agentId),
  };
  // 两个「进程」共用一个库：比较交换保证只触发一次。
  const a = url ? createSchedules(database, deps as never) : (null as never);
  const b = url ? createSchedules(database, deps as never) : (null as never);
  const settle = () => new Promise((r) => setTimeout(r, 300));
  const due = (id: string, ago = "1 minute") => sql.unsafe(`UPDATE chisabot_schedules SET next_run_at = date_trunc('minute', now() - interval '${ago}') WHERE id = $1`, [id]);

  beforeAll(async () => {
    await a.ensure();
  });
  afterAll(async () => {
    await sql.unsafe("DELETE FROM chisabot_schedule_runs WHERE owner_user_id = $1", [owner]);
    await sql.unsafe("DELETE FROM chisabot_schedules WHERE owner_user_id = $1", [owner]);
  });

  test("a due one-off fires exactly once across two sweepers and ends", async () => {
    turns.length = 0;
    const s = await a.create({ owner, agentId: "bot1", threadId: "t-web-1", title: "喝水", instruction: "提醒用户：喝水", when: { repeat: "once", in_minutes: 5 } });
    expect(s.status).toBe("active");
    await due(s.id);
    const [ra, rb] = await Promise.all([a.sweep(), b.sweep()]);
    expect([...ra.fired, ...rb.fired].filter((id) => id === s.id)).toHaveLength(1);
    await settle();
    expect(turns.filter((t) => t.content.includes(s.id))).toHaveLength(1);
    expect(turns[0]!.threadId).toBe("t-web-1");
    expect(turns[0]!.initiator).toBe(`schedule:${s.id}`);
    expect(turns[0]!.content.startsWith(`⟦chisabot:schedule:${s.id}:`)).toBe(true);
    const after = await a.get(owner, s.id);
    expect(after.status).toBe("done");
    expect(after.lastStatus).toBe("ok");
    expect(after.lastResult).toBe("⏰ 该喝水了");
    expect(after.recentRuns).toHaveLength(1);
    // 再扫一遍不会再来。
    await a.sweep();
    await settle();
    expect(turns.filter((t) => t.content.includes(s.id))).toHaveLength(1);
    const listed = await a.list(owner, { includeEnded: true, runs: 5 });
    expect(listed.find((x) => x.id === s.id)?.recentRuns?.length).toBe(1);
    const events = await a.events(owner, new Date(Date.now() - 60_000));
    expect(events.some((e) => e.scheduleId === s.id && e.status === "ok")).toBe(true);
  });

  test("a recurring task advances to its next occurrence", async () => {
    const s = await a.create({ owner, agentId: "bot1", threadId: "t-web-1", title: "日报", instruction: "总结今天", when: { repeat: "daily", at: "09:00" } });
    await due(s.id);
    const r = await a.sweep();
    expect(r.fired).toContain(s.id);
    await settle();
    const after = await a.get(owner, s.id);
    expect(after.status).toBe("active");
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect(after.runCount).toBe(1);
  });

  test("a recurring task late by more than 30 minutes is skipped, not replayed", async () => {
    const s = await a.create({ owner, agentId: "bot1", threadId: "t-web-1", title: "迟到", instruction: "x", when: { repeat: "hourly" } });
    await due(s.id, "2 hours");
    const r = await a.sweep();
    expect(r.skipped).toContain(s.id);
    const after = await a.get(owner, s.id);
    expect(after.lastStatus).toBe("skipped");
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  test("a one-off missed by more than 6 hours is recorded as missed", async () => {
    const s = await a.create({ owner, agentId: "bot1", threadId: "t-web-1", title: "错过", instruction: "x", when: { repeat: "once", in_minutes: 5 } });
    await due(s.id, "7 hours");
    await a.sweep();
    const after = await a.get(owner, s.id);
    expect(after.status).toBe("done");
    expect(after.lastStatus).toBe("skipped");
    expect(after.lastResult).toMatch(/错过/);
  });

  test("pause, resume, skip next, run now, delete", async () => {
    turns.length = 0;
    const s = await a.create({ owner, agentId: "bot1", threadId: "t-web-2", title: "周报", instruction: "写周报", when: { repeat: "weekly", days: [5], at: "17:00" } });
    const paused = await a.update(owner, s.id, { paused: true });
    expect(paused.status).toBe("paused");
    await due(s.id);
    expect((await a.sweep()).fired).not.toContain(s.id);
    const resumed = await a.update(owner, s.id, { paused: false });
    expect(resumed.status).toBe("active");
    const first = resumed.nextRunAt!;
    const skipped = await a.skipNext(owner, s.id);
    expect(new Date(skipped.nextRunAt!).getTime() - new Date(first).getTime()).toBe(7 * 24 * 3600_000);
    await a.runNow(owner, s.id);
    await settle();
    expect(turns.some((t) => t.content.includes(s.id) && t.content.includes("手动运行"))).toBe(true);
    const changed = await a.update(owner, s.id, { when: { repeat: "daily", at: "07:30" }, title: "早报" });
    expect(changed.cron).toBe("30 7 * * *");
    expect(changed.title).toBe("早报");
    expect(await a.remove(owner, s.id)).toBe(true);
    await expect(a.get(owner, s.id)).rejects.toThrow(ScheduleError);
    await expect(a.get("someone-else", s.id)).rejects.toThrow(ScheduleError);
  });

  test("IM-origin tasks push the reply back to the IM chat", async () => {
    pushes.length = 0;
    const s = await a.create({ owner, agentId: "bot1", threadId: "im-abc-123", imConnectionId: "im_abc", title: "IM 提醒", instruction: "提醒用户：开会", when: { repeat: "once", in_minutes: 5 } });
    await due(s.id);
    await a.sweep();
    await settle();
    expect(pushes).toEqual([{ threadId: "im-abc-123", text: "⏰ 该喝水了" }]);
    expect(turns.some((t) => t.content.includes(s.id) && t.initiator === "im:im_abc")).toBe(true);
  });

  test("busy web conversation: queued into that turn's inbox", async () => {
    busy = new Set(["t-busy"]);
    const s = await a.create({ owner, agentId: "bot1", threadId: "t-busy", title: "插队", instruction: "x", when: { repeat: "once", in_minutes: 5 } });
    await due(s.id);
    await a.sweep();
    await settle();
    expect(enqueued).toContain("t-busy");
    expect((await a.get(owner, s.id)).lastStatus).toBe("queued");
    busy = new Set();
  });

  test("deleted bot cancels its task instead of firing", async () => {
    deletedBots = new Set(["bot-gone"]);
    const s = await a.create({ owner, agentId: "bot-gone", threadId: "t-x", title: "孤儿", instruction: "x", when: { repeat: "daily", at: "10:00" } });
    await due(s.id);
    await a.sweep();
    await settle();
    const after = await a.get(owner, s.id);
    expect(after.status).toBe("cancelled");
    expect(after.lastStatus).toBe("failed");
  });

  test("bot tools: create returns a confirmation; refusals are readable", async () => {
    const tools = a.tools({ owner, agentId: "bot1", threadId: "t-web-3" });
    const create = tools.find((t) => t.name === "schedule_create")!;
    expect(create.guidance).toMatch(/现在是北京时间/);
    const out = JSON.parse(await create.execute({ title: "打电话", instruction: "提醒用户：给妈妈打电话", repeat: "once", in_minutes: 60 }));
    expect(out.ok).toBe(true);
    expect(out.confirmation).toMatch(/已设好提醒：/);
    const refused = await create.execute({ title: "太密", instruction: "x", repeat: "cron", cron: "* * * * *" });
    expect(refused).toMatch(/15 分钟/);
    const listed = await tools.find((t) => t.name === "schedule_list")!.execute({});
    expect(listed).toContain("打电话");
    const cancel = await tools.find((t) => t.name === "schedule_cancel")!.execute({ id: out.schedule.id });
    expect(cancel).toMatch(/已删除/);
  });

  // v0.1.34：非电车定时 create→run→fail→pause→needs-attention；paused 永不被 sweep 自动 resume。
  test("fail streak auto-pauses; paused never auto-resumes on sweep", async () => {
    const failDeps = {
      ...deps,
      runTurn: async () => {
        throw new Error("模拟硬失败 ERR_TUNNEL");
      },
    };
    const failing = createSchedules(database, failDeps as never);
    const s = await failing.create({
      owner,
      agentId: "bot1",
      threadId: "t-fail-streak",
      title: "普通日报",
      instruction: "总结今天",
      when: { repeat: "hourly" },
    });
    for (let i = 0; i < 3; i++) {
      await due(s.id);
      await failing.sweep();
      await settle();
    }
    const after = await failing.get(owner, s.id);
    expect(after.status).toBe("paused");
    expect(after.lastStatus).toBe("failed");
    expect(after.lastResult).toMatch(/自动暂停|运行失败/);
    // 即使把 next_run_at 拨到过去，paused 也不会被 sweep 触发（永不 auto-resume）
    await sql.unsafe(
      `UPDATE chisabot_schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1`,
      [s.id],
    );
    const r = await failing.sweep();
    expect(r.fired).not.toContain(s.id);
    const still = await failing.get(owner, s.id);
    expect(still.status).toBe("paused");
    // 只有人手 paused=false 才恢复
    const resumed = await failing.update(owner, s.id, { paused: false });
    expect(resumed.status).toBe("active");
    await failing.update(owner, s.id, { paused: true });
  });

  test("reclaimStuckRuns marks failed and can auto-pause on streak", async () => {
    const s = await a.create({
      owner,
      agentId: "bot1",
      threadId: "t-stuck",
      title: "卡住回收",
      instruction: "x",
      when: { repeat: "hourly" },
    });
    // 造 3 条卡住的 running（>20min），reclaim 后计入连续失败 → pause
    for (let i = 0; i < 3; i++) {
      const runId = `run_stuck_${i}_${s.id.slice(-4)}`;
      await sql.unsafe(
        `INSERT INTO chisabot_schedule_runs (id, schedule_id, owner_user_id, scheduled_for, status, started_at)
         VALUES ($1,$2,$3,now(),'running', now() - interval '25 minutes')`,
        [runId, s.id, owner],
      );
    }
    const n = await a.reclaimStuckRuns();
    expect(n).toBeGreaterThanOrEqual(3);
    const after = await a.get(owner, s.id);
    expect(after.status).toBe("paused");
    expect(after.lastStatus).toBe("failed");
    // reclaim 不会 resume
    await due(s.id);
    expect((await a.sweep()).fired).not.toContain(s.id);
  });
});

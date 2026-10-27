import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../src/db/client";
import { createSchedules } from "../src/schedules/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { holdScheduleSweepLock } from "./support/schedule-sweep-lock";

/**
 * CB-105：暂停的任务没有「下次运行」。生产上「和 Claude 聊电车」暂停后库里仍留着 next_run_at，
 * 这里钉住：暂停把它置空，恢复重新算；扫描已经拿到、发出前刚被暂停的那次不发，记 skipped，任务本身不动。
 */
const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("paused schedules have no next run", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const sql = url ? database.$client : (null as never);
  const owner = `cb105-${randomUUID().slice(0, 8)}`;
  const turns: string[] = [];
  let onBotCheck: (() => Promise<void>) | null = null;
  const deps = {
    runTurn: async (input: { userMessage?: { content?: unknown } }) => {
      turns.push(String(input.userMessage?.content ?? ""));
      return { replyText: "好" };
    },
    botAvailable: async () => {
      await onBotCheck?.();
      return true;
    },
  };
  const s = url ? createSchedules(database, deps as never) : (null as never);
  const nextOf = async (id: string) =>
    (
      await sql.unsafe<{ next_run_at: Date | null; status: string }[]>(
        "SELECT next_run_at, status FROM chisabot_schedules WHERE id = $1",
        [id],
      )
    )[0]!;

  let releaseSweepLock: (() => Promise<void>) | null = null;
  beforeAll(async () => {
    releaseSweepLock = await holdScheduleSweepLock(url!);
    await s.ensure();
  }, 120_000); // 等别的进程放锁
  afterAll(async () => {
    await sql.unsafe(
      "DELETE FROM chisabot_schedule_runs WHERE owner_user_id = $1",
      [owner],
    );
    await sql.unsafe(
      "DELETE FROM chisabot_schedules WHERE owner_user_id = $1",
      [owner],
    );
    await sql
      .unsafe("DELETE FROM openbot_local_threads WHERE owner_user_id = $1", [
        owner,
      ])
      .catch(() => {});
    await releaseSweepLock?.();
  });

  test("pause clears next_run_at; resume recomputes it", async () => {
    const task = await s.create({
      owner,
      agentId: "bot1",
      threadId: `${owner}-t-cb105-1`,
      title: "和 Claude 聊电车",
      instruction: "聊电车",
      when: { repeat: "cron", cron: "0 */3 * * *" },
    });
    expect((await nextOf(task.id)).next_run_at).not.toBeNull();
    const paused = await s.update(owner, task.id, { paused: true });
    expect(paused.status).toBe("paused");
    expect(paused.nextRunAt).toBeNull();
    expect((await nextOf(task.id)).next_run_at).toBeNull();
    // 暂停时改时间也不留下次运行。
    await s.update(owner, task.id, { when: { repeat: "daily", at: "07:00" } });
    expect((await nextOf(task.id)).next_run_at).toBeNull();
    const resumed = await s.update(owner, task.id, { paused: false });
    expect(resumed.status).toBe("active");
    expect(resumed.nextRunAt).not.toBeNull();
    const next = (await nextOf(task.id)).next_run_at!;
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
  });

  test("paused between claim and send: not sent, run skipped, task stays paused", async () => {
    turns.length = 0;
    const threadId = `t-cb105-${randomUUID().slice(0, 8)}`;
    // 本地库里有对话表时要有这条对话（CI 的库可能没有这张表，没有时服务按「对话还在」处理）。
    await sql
      .unsafe(
        "INSERT INTO openbot_local_threads (id, owner_user_id, agent_id) VALUES ($1, $2, 'bot1')",
        [threadId, owner],
      )
      .catch(() => {});
    const task = await s.create({
      owner,
      agentId: "bot1",
      threadId,
      title: "喝水",
      instruction: "喝水",
      when: { repeat: "hourly" },
    });
    await sql.unsafe(
      "UPDATE chisabot_schedules SET next_run_at = date_trunc('minute', now() - interval '1 minute') WHERE id = $1",
      [task.id],
    );
    onBotCheck = async () => {
      onBotCheck = null;
      await s.update(owner, task.id, { paused: true });
    };
    expect((await s.sweep()).fired).toContain(task.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(turns.some((t) => t.includes(task.id))).toBe(false);
    const row = await nextOf(task.id);
    expect(row.status).toBe("paused");
    expect(row.next_run_at).toBeNull();
    const runs = await sql.unsafe<{ status: string }[]>(
      "SELECT status FROM chisabot_schedule_runs WHERE schedule_id = $1",
      [task.id],
    );
    expect(runs.map((r) => r.status)).toEqual(["skipped"]);
  });

  test("CB-105b: ensure() clears stale next_run_at on old paused rows, idempotently", async () => {
    const paused = await s.create({
      owner,
      agentId: "bot1",
      threadId: `${owner}-t-cb105b-1`,
      title: "旧的暂停任务",
      instruction: "x",
      when: { repeat: "hourly" },
    });
    const active = await s.create({
      owner,
      agentId: "bot1",
      threadId: `${owner}-t-cb105b-2`,
      title: "在跑的任务",
      instruction: "x",
      when: { repeat: "hourly" },
    });
    // CB-105 之前暂停的数据：status=paused 但 next_run_at 还在。
    await sql.unsafe(
      "UPDATE chisabot_schedules SET status = 'paused', next_run_at = now() + interval '1 hour' WHERE id = $1",
      [paused.id],
    );
    const activeNext = (await nextOf(active.id)).next_run_at;
    await s.ensure();
    expect((await nextOf(paused.id)).next_run_at).toBeNull();
    expect((await nextOf(paused.id)).status).toBe("paused");
    expect((await nextOf(active.id)).next_run_at).toEqual(activeNext);
    await s.ensure(); // 再跑一次不出错、不改别的
    expect((await nextOf(paused.id)).next_run_at).toBeNull();
    expect((await nextOf(active.id)).next_run_at).toEqual(activeNext);
  });

  test("CB-105b: get() can return more than 20 runs", async () => {
    const task = await s.create({
      owner,
      agentId: "bot1",
      threadId: `${owner}-t-cb105b-3`,
      title: "很多次",
      instruction: "x",
      when: { repeat: "hourly" },
    });
    for (let i = 0; i < 25; i++)
      await sql.unsafe(
        "INSERT INTO chisabot_schedule_runs (id, schedule_id, owner_user_id, scheduled_for, started_at, finished_at, status) VALUES ($1, $2, $3, now() - make_interval(hours => $4::int), now() - make_interval(hours => $4::int), now(), 'ok')",
        [`run_cb105b_${task.id}_${i}`, task.id, owner, i],
      );
    expect((await s.get(owner, task.id)).recentRuns.length).toBe(20);
    expect((await s.get(owner, task.id, 25)).recentRuns.length).toBe(25);
    expect((await s.get(owner, task.id, 100)).recentRuns.length).toBe(25);
    expect((await s.get(owner, task.id, 100000)).recentRuns.length).toBe(25);
  });
});

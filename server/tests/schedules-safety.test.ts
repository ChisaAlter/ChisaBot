import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { SCHEDULE_SILENT_MARKER } from "../../shared/schedules";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, users } from "../src/db/schema";
import {
  cancelSchedulesForDeletedThreads,
  createSchedules,
  THREAD_DELETED_RESULT,
} from "../src/schedules/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { holdScheduleSweepLock } from "./support/schedule-sweep-lock";

/**
 * 审查模块 13 数据安全必修（M1/M2/M3/S2/S6）：例程不误停、不发错地方、不误删。
 * 需要 Postgres（TEST_DATABASE_URL）；纯分类规则的用例在 shared/schedules.test.ts。
 */
const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("schedules data safety (database)", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const sql = url ? database.$client : (null as never);
  const suite = randomUUID().slice(0, 8);
  const owner = `schedsafe-${suite}`;
  const tid = (name: string) => `${owner}-${name}`;
  let releaseSweepLock: (() => Promise<void>) | null = null;
  const turns: { threadId: string; content: string }[] = [];
  let reply: (input: { threadId: string; runId: string }) => Promise<{ replyText: string; toolErrors?: string[] }> =
    async () => ({ replyText: "⏰ 该喝水了" });
  let botAvailable: (owner: string, agentId: string) => Promise<boolean> = async () => true;
  const deps = {
    runTurn: async (input: { threadId: string; userMessage?: { content?: unknown }; forwardedProps?: { chisabotSchedule?: { runId: string } } }) => {
      turns.push({ threadId: input.threadId, content: String(input.userMessage?.content ?? "") });
      return reply({ threadId: input.threadId, runId: input.forwardedProps?.chisabotSchedule?.runId ?? "" });
    },
    botAvailable: (o: string, a: string) => botAvailable(o, a),
    retryDelayMs: 1,
  };
  const s = url ? createSchedules(database, deps as never) : (null as never);
  const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
  const due = (id: string) =>
    sql.unsafe("UPDATE chisabot_schedules SET next_run_at = date_trunc('minute', now() - interval '1 minute') WHERE id = $1", [id]);
  const fireDue = async (id: string) => {
    await due(id);
    const r = await s.sweep();
    expect(r.fired).toContain(id);
    await settle();
  };
  const addThread = (id: string, messages: unknown[] = []) =>
    sql.unsafe(
      "INSERT INTO openbot_local_threads (id, owner_user_id, agent_id, messages) VALUES ($1, $2, 'bot1', $3::text::jsonb)",
      [id, owner, JSON.stringify(messages)],
    );
  const daily = (thread: string, title: string) =>
    s.create({ owner, agentId: "bot1", threadId: tid(thread), title, instruction: `提醒：${title}`, when: { repeat: "daily", at: "09:00" } });

  beforeAll(async () => {
    releaseSweepLock = await holdScheduleSweepLock(url!);
    await s.ensure();
    // 本地对话表平时由 local-conversations 建；单独跑这个文件时自己建（同一份最小结构）。
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS openbot_local_threads (
      id text PRIMARY KEY, owner_user_id text NOT NULL, agent_id text NOT NULL,
      name text, archived boolean NOT NULL DEFAULT false,
      messages jsonb NOT NULL DEFAULT '[]'::jsonb, state jsonb NOT NULL DEFAULT '{}'::jsonb,
      run_id text, lock_expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const t of ["m1", "m1-tool", "m2-a", "m2-b", "m2-other", "m3", "m3-gone", "s6-a", "s6-b"]) await addThread(tid(t));
  }, 120_000);
  afterAll(async () => {
    await sql.unsafe("DELETE FROM openbot_local_threads WHERE owner_user_id = $1", [owner]).catch(() => {});
    await sql.unsafe("DELETE FROM chisabot_schedule_runs WHERE owner_user_id LIKE $1", [`${owner}%`]);
    await sql.unsafe("DELETE FROM chisabot_schedules WHERE owner_user_id LIKE $1", [`${owner}%`]);
    await releaseSweepLock?.();
  });

  test("M1/O11: three ordinary replies that mention 没能完成 / 隧道 / 浏览器…失败 / ERR_ stay ok and never auto-pause", async () => {
    const replies = [
      "提醒你：昨天没能完成的周报今天记得交。",
      "提醒：明天走海底隧道去机场，早点出门。",
      "浏览器打开失败的话就用手机看。",
      "好的，已提醒。错误码 ERR_NAME_NOT_RESOLVED 的意思是域名解析失败。",
    ];
    const sc = await daily("m1", "周报");
    for (const text of replies) {
      reply = async () => ({ replyText: text });
      await fireDue(sc.id);
    }
    const after = await s.get(owner, sc.id);
    expect(after.status).toBe("active");
    expect(after.recentRuns!.map((r) => r.status)).toEqual(["ok", "ok", "ok", "ok"]);
  });

  test("M1: tool errors from the runner still count as failures and pause after 3", async () => {
    const sc = await daily("m1-tool", "隧道巡检");
    reply = async () => ({ replyText: "已检查。", toolErrors: ["ERR_TUNNEL_CONNECTION_FAILED"] });
    for (let i = 0; i < 3; i++) await fireDue(sc.id);
    const after = await s.get(owner, sc.id);
    expect(after.recentRuns!.map((r) => r.status)).toEqual(["failed", "failed", "failed"]);
    expect(after.status).toBe("paused");
    reply = async () => ({ replyText: "⏰ 该喝水了" });
  });

  test("M2: original thread deleted → nothing is sent anywhere, task is cancelled and marked 原对话已删除", async () => {
    const sc = await daily("m2-a", "喝水");
    // 同一个机器人另有一个最近活跃的对话：以前会回退到这里。
    await sql.unsafe("UPDATE openbot_local_threads SET updated_at = now() WHERE id = $1", [tid("m2-other")]).catch(() => {});
    await sql.unsafe("DELETE FROM openbot_local_threads WHERE id = $1", [tid("m2-a")]);
    const listed = (await s.list(owner)).find((x) => x.id === sc.id)!;
    expect(listed.threadDeleted).toBe(true);
    turns.length = 0;
    await fireDue(sc.id);
    expect(turns).toHaveLength(0);
    const after = await s.get(owner, sc.id, 5);
    expect(after.status).toBe("cancelled");
    expect(after.lastResult).toBe(THREAD_DELETED_RESULT);
    expect(after.threadDeleted).toBe(true);
    expect(after.recentRuns![0]!.status).toBe("skipped");
  });

  test("M2: deleting a thread cancels the web routines attached to it, not others", async () => {
    const onIt = await daily("m2-b", "挂在 b 上");
    const other = await daily("m2-other", "挂在别处");
    await sql.unsafe("DELETE FROM openbot_local_threads WHERE id = $1", [tid("m2-b")]);
    expect(await cancelSchedulesForDeletedThreads(sql, owner, [tid("m2-b")])).toBe(1);
    expect((await s.get(owner, onIt.id)).status).toBe("cancelled");
    expect((await s.get(owner, other.id)).status).toBe("active");
    expect((await s.list(owner)).find((x) => x.id === other.id)!.threadDeleted).toBe(false);
  });

  test("M3: botAvailable throwing is retried and the run goes ahead; never cancels", async () => {
    const sc = await daily("m3", "抖动");
    let calls = 0;
    botAvailable = async () => {
      calls += 1;
      if (calls <= 2) throw new Error("connection terminated unexpectedly");
      return true;
    };
    turns.length = 0;
    await fireDue(sc.id);
    expect(calls).toBe(3);
    expect(turns).toHaveLength(1);
    expect((await s.get(owner, sc.id)).status).toBe("active");
  });

  test("M3: botAvailable failing every retry skips this run and keeps the task active", async () => {
    const sc = await daily("m3", "一直抖");
    botAvailable = async () => {
      throw new Error("db down");
    };
    turns.length = 0;
    await fireDue(sc.id);
    expect(turns).toHaveLength(0);
    const after = await s.get(owner, sc.id, 5);
    expect(after.status).toBe("active");
    expect(after.recentRuns![0]!.status).toBe("skipped");
  });

  test("M3: only a confirmed-deleted bot cancels", async () => {
    const sc = await daily("m3-gone", "已删");
    botAvailable = async () => false;
    await fireDue(sc.id);
    expect((await s.get(owner, sc.id)).status).toBe("cancelled");
    botAvailable = async () => true;
  });

  test("S6: silent run removes only its trigger message in one statement; a later user message keeps everything", async () => {
    const SILENT = SCHEDULE_SILENT_MARKER;
    const old = { id: "m-old", role: "user", content: "早" };
    // a：触发消息后只有机器人的静默回复 → 收起，之前的消息保留。
    const a = await daily("s6-a", "巡检 a");
    reply = async ({ threadId, runId }) => {
      await sql.unsafe("UPDATE openbot_local_threads SET messages = $2::text::jsonb WHERE id = $1", [
        threadId,
        JSON.stringify([old, { id: `schedule-${runId}`, role: "user", content: "⟦…⟧" }, { id: "r1", role: "assistant", content: SILENT }]),
      ]);
      return { replyText: SILENT };
    };
    await fireDue(a.id);
    const [ta] = await sql.unsafe<{ messages: { id: string }[] }[]>("SELECT messages FROM openbot_local_threads WHERE id = $1", [tid("s6-a")]);
    expect(ta!.messages.map((m) => m.id)).toEqual(["m-old"]);
    // b：静默回复后用户已经又发了一条 → 什么都不删。
    const b = await daily("s6-b", "巡检 b");
    reply = async ({ threadId, runId }) => {
      await sql.unsafe("UPDATE openbot_local_threads SET messages = $2::text::jsonb WHERE id = $1", [
        threadId,
        JSON.stringify([old, { id: `schedule-${runId}`, role: "user", content: "⟦…⟧" }, { id: "r1", role: "assistant", content: SILENT }, { id: "u2", role: "user", content: "在吗" }]),
      ]);
      return { replyText: SILENT };
    };
    await fireDue(b.id);
    const [tb] = await sql.unsafe<{ messages: { id: string }[] }[]>("SELECT messages FROM openbot_local_threads WHERE id = $1", [tid("s6-b")]);
    expect(tb!.messages).toHaveLength(4);
    expect((await s.get(owner, b.id)).lastStatus).toBe("ok");
    reply = async () => ({ replyText: "⏰ 该喝水了" });
  });

  describe("S2: orphan purge", () => {
    const person = `${owner}-u`;
    const live = `${owner}-bot-live`;
    const soft = `${owner}-bot-soft`;
    beforeAll(async () => {
      await database.insert(users).values({ id: person, email: `${person}@example.test`, name: person }).onConflictDoNothing();
      for (const id of [live, soft]) {
        await database.insert(agents).values({ id, name: id, type: "remote_ag_ui", configuration: {} }).onConflictDoNothing();
        await database
          .insert(agentProfiles)
          .values({ agentId: id, ownerUserId: person, title: id, roleDescription: "test", avatarSeed: id, visibility: "private", ...(id === soft ? { deletedAt: new Date() } : {}) })
          .onConflictDoNothing();
      }
    });
    afterAll(async () => {
      await database.delete(agentProfiles).where(inArray(agentProfiles.agentId, [live, soft]));
      await database.delete(agents).where(inArray(agents.id, [live, soft]));
      await database.delete(users).where(inArray(users.id, [person]));
    });
    const mk = async (o: string, agentId: string, status: string, age = "0 days") => {
      const created = await s.create({ owner: o, agentId, threadId: `${o}-t`, title: `${agentId}-${status}`, instruction: "x", when: { repeat: "daily", at: "09:00" } });
      await sql.unsafe(`UPDATE chisabot_schedules SET status = $2, updated_at = now() - interval '${age}' WHERE id = $1`, [created.id, status]);
      return created.id;
    };
    const exists = async (id: string) => (await sql.unsafe("SELECT 1 FROM chisabot_schedules WHERE id = $1", [id])).length > 0;

    test("automatic purge keeps live / recently-ended orphans and only drops ones ended over a week ago", async () => {
      const activeOrphan = await mk(person, soft, "active");
      const recentDone = await mk(person, soft, "done");
      const oldDone = await mk(person, soft, "cancelled", "8 days");
      const liveBot = await mk(person, live, "cancelled", "8 days");
      await s.purgeOrphanSchedules();
      expect(await exists(activeOrphan)).toBe(true);
      expect(await exists(recentDone)).toBe(true);
      expect(await exists(oldDone)).toBe(false);
      expect(await exists(liveBot)).toBe(true);
    });

    test("profiles unreadable (no live profile for this owner at all) → nothing is purged or cancelled", async () => {
      const ghostOwner = `${owner}-ghost`;
      const a = await mk(ghostOwner, `${owner}-unknown-bot`, "cancelled", "30 days");
      const b = await mk(ghostOwner, `${owner}-unknown-bot`, "active");
      expect(await s.purgeOrphanSchedules(ghostOwner)).toBe(0);
      await s.purgeOrphanSchedules();
      expect(await exists(a)).toBe(true);
      expect((await s.get(ghostOwner, b)).status).toBe("active");
    });

    test("user-confirmed purge (owner) removes that owner's confirmed orphans of any status", async () => {
      const activeOrphan = await mk(person, soft, "paused");
      const liveOne = await mk(person, live, "active");
      expect(await s.purgeOrphanSchedules(person)).toBeGreaterThanOrEqual(1);
      expect(await exists(activeOrphan)).toBe(false);
      expect(await exists(liveOne)).toBe(true);
    });
  });
});

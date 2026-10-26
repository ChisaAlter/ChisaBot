import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import {
  type ActivityStore,
  createActivityStore,
} from "../src/computer/activity-store";
import {
  withActivityScope,
  withComputerActivity,
} from "../src/computer/activity-recorder";
import type { ComputerGateway } from "../src/computer/gateway";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("computer activity store", () => {
  let store: ActivityStore;
  const bot = `bot-${randomUUID()}`;
  const user = `user-${randomUUID()}`;

  beforeAll(async () => {
    const database = createDatabase(testDatabaseUrl(), TEST_POOL);
    // 测试库不跑 drizzle 迁移；直接用 0060 迁移文件建表，保证测的就是要上线的那份 DDL。
    const ddl = readFileSync(
      new URL("../drizzle/0060_computer_activity_steps.sql", import.meta.url),
      "utf8",
    );
    for (const statement of ddl.split("--> statement-breakpoint")) {
      const text = statement
        .trim()
        .replace(/^CREATE TABLE /, "CREATE TABLE IF NOT EXISTS ")
        .replace(/^CREATE (UNIQUE )?INDEX /, "CREATE $1INDEX IF NOT EXISTS ");
      if (text) await database.execute(sql.raw(text));
    }
    store = createActivityStore(database, testDatabaseUrl());
  });
  afterAll(async () => {
    await store.clear(bot);
    await store.stop();
  });

  test("CB-101: every write is redacted at the store, even if a caller forgot", async () => {
    const id = await store.begin({
      computerId: bot,
      actorUserId: user,
      actorKind: "agent",
      kind: "run_command",
      subject: "sshpass -p hunter2 ssh root@h",
      detail: { nested: { cmd: "mysql -u root -phunter2" }, list: ["--password=hunter2"] },
    });
    await store.finish(id as string, {
      status: "ok",
      subject: "sshpass -p hunter2 ssh root@h",
      output: "$ redis-cli -a hunter2 ping\nPONG",
      detail: { exitCode: 0, echo: "unzip -P hunter2 a.zip" },
    });
    await store.bump(id as string, { again: "openssl enc -k hunter2" });
    const row = await store.get(bot, user, id as string);
    expect(JSON.stringify(row)).not.toContain("hunter2");
    expect(row?.subject).toBe("sshpass -p •••• ssh root@h");
  });

  test("begin, finish, list and duplicate tool calls", async () => {
    const id = await store.begin({
      computerId: bot,
      toolCallId: "c1",
      actorUserId: user,
      actorKind: "agent",
      kind: "run_command",
      subject: "ls",
    });
    expect(id).toBeTruthy();
    expect(
      await store.begin({
        computerId: bot,
        toolCallId: "c1",
        actorUserId: user,
        actorKind: "agent",
        kind: "run_command",
        subject: "ls",
      }),
    ).toBeNull();
    await store.finish(id as string, {
      status: "ok",
      output: "x",
      detail: { exitCode: 0 },
    });
    const page = await store.list({ computerId: bot, actorUserId: user });
    expect(page.steps[0]).toMatchObject({
      id,
      status: "ok",
      subject: "ls",
      output: "x",
      detail: { exitCode: 0 },
    });
    expect(page.retentionDays).toBe(90);
    expect(
      (await store.list({ computerId: bot, actorUserId: "someone-else" })).steps
        .length,
    ).toBe(0);
  });

  test("an awaiting approval step resumes on the same row", async () => {
    const id = await store.begin({
      computerId: bot,
      toolCallId: "c2",
      actorUserId: user,
      actorKind: "agent",
      kind: "write_file",
      subject: "/a",
    });
    await store.finish(id as string, {
      status: "refused",
      refusalReason: "awaiting_approval",
    });
    const again = await store.begin({
      computerId: bot,
      toolCallId: "c2",
      actorUserId: user,
      actorKind: "agent",
      kind: "write_file",
      subject: "/a",
    });
    expect(again).toBe(id);
    await store.bump(id as string, { count: 2 });
    expect((await store.get(bot, user, id as string))?.detail).toEqual({
      count: 2,
    });
    expect((await store.get(bot, user, id as string))?.status).toBe("running");
  });

  test("pagination, cancel running and notify", async () => {
    const seen: string[] = [];
    const off = store.subscribe((event) => seen.push(event.stepId));
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 5; i++)
      await store.begin({
        computerId: bot,
        actorUserId: user,
        actorKind: "agent",
        kind: "click",
        subject: `${i}`,
      });
    const first = await store.list({
      computerId: bot,
      actorUserId: user,
      limit: 3,
    });
    expect(first.steps.length).toBe(3);
    const second = await store.list({
      computerId: bot,
      actorUserId: user,
      limit: 3,
      before: first.nextCursor ?? undefined,
    });
    expect(
      new Set([...first.steps, ...second.steps].map((s) => s.id)).size,
    ).toBe(first.steps.length + second.steps.length);
    expect(await store.cancelRunning(bot)).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 500));
    off();
    expect(seen.length).toBeGreaterThan(0);
  });

  test("concurrent tool calls are stored under the turn each one was sent with", async () => {
    const concurrentBot = `${bot}-concurrent`;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = withComputerActivity(
      {
        status: async () => ({ state: "ready" }),
        runCommand: async (_b: string, _a: unknown, input: { command: string }) => {
          if (input.command.startsWith("slow")) await gate;
          return { command: input.command, exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false, elapsedMs: 1 };
        },
      } as unknown as ComputerGateway,
      { store: () => store },
    );
    const actor = { id: user, userId: user };
    const calls = [
      { runId: "turnA", toolCallId: "callA", command: "slow a" },
      { runId: "turnB", toolCallId: "callB", command: "fast b" },
      { runId: "turnC", toolCallId: "callC", command: "slow c" },
    ].map((call) =>
      withActivityScope(
        { threadId: null, runId: call.runId, toolCallId: call.toolCallId, actorUserId: user },
        () => gateway.runCommand(concurrentBot, actor as never, { command: call.command } as never),
      ),
    );
    await calls[1];
    release();
    await Promise.all(calls);
    const page = await store.list({ computerId: concurrentBot, actorUserId: user });
    const bySubject = Object.fromEntries(page.steps.map((step) => [step.subject, step]));
    expect(bySubject["slow a"]).toMatchObject({ runId: "turnA", toolCallId: "callA", status: "ok" });
    expect(bySubject["fast b"]).toMatchObject({ runId: "turnB", toolCallId: "callB", status: "ok" });
    expect(bySubject["slow c"]).toMatchObject({ runId: "turnC", toolCallId: "callC", status: "ok" });
    await store.clear(concurrentBot);
  });
});

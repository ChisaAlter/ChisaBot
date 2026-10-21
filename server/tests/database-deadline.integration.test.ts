import { afterAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { testDatabaseUrl } from "./support/database";

const base = testDatabaseUrl();
const short = new URL(base);
short.searchParams.set("statement_timeout", "80");
short.searchParams.set("lock_timeout", "40");
const database = createDatabase(short.toString(), { max: 1 });
afterAll(async () => { await database.$client.close(); });

const pgCode = (error: unknown): string | undefined => {
  let current = error as { code?: string; errno?: string; cause?: unknown } | undefined;
  for (let n = 0; current && n < 6; n++) {
    if (current.errno) return current.errno;
    if (current.code && /^[0-9A-Z]{5}$/.test(current.code)) return current.code;
    current = current.cause as typeof current;
  }
};

test("a statement budget cancels work on Postgres and releases the single connection", async () => {
  const start = performance.now();
  let failed: unknown;
  try { await database.execute(sql`select pg_sleep(2)`); } catch (error) { failed = error; }
  expect(pgCode(failed)).toBe("57014");
  expect(performance.now() - start).toBeLessThan(1500);
  expect((await database.execute(sql`select 1 as ok`))[0]?.ok).toBe(1);
});

test("a timed-out write is rolled back once, without replay, and the pool recovers", async () => {
  await database.execute(sql`create temporary table deadline_probe (id int primary key)`);
  let failed: unknown;
  try {
    await database.transaction(async (tx) => {
      await tx.execute(sql`insert into deadline_probe values (1)`);
      await tx.execute(sql`select pg_sleep(2)`);
    });
  } catch (error) { failed = error; }
  expect(pgCode(failed)).toBe("57014");
  expect((await database.execute(sql`select count(*)::int as count from deadline_probe`))[0]?.count).toBe(0);
});

test("lock contention has its own budget and a cancelled waiter releases its connection", async () => {
  const other = createDatabase(base, { max: 1 });
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const blocker = other.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(870210)`);
    acquired();
    await hold;
  });
  await ready;
  try {
    let failed: unknown;
    try { await database.execute(sql`select pg_advisory_xact_lock(870210)`); } catch (error) { failed = error; }
    expect(pgCode(failed)).toBe("55P03");
    expect((await database.execute(sql`select 1 as ok`))[0]?.ok).toBe(1);
  } finally {
    release();
    await blocker;
    await other.$client.close();
  }
});

test("default budgets and explicit deployment overrides reach the real server", async () => {
  const defaults = createDatabase(base, { max: 1 });
  try {
    expect((await defaults.execute(sql`show statement_timeout`))[0]?.statement_timeout).toBe("25s");
    expect((await defaults.execute(sql`show lock_timeout`))[0]?.lock_timeout).toBe("5s");
    expect((await database.execute(sql`show statement_timeout`))[0]?.statement_timeout).toBe("80ms");
    expect((await database.execute(sql`show lock_timeout`))[0]?.lock_timeout).toBe("40ms");
  } finally { await defaults.$client.close(); }
});

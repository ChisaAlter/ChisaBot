import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { testDatabaseUrl } from "./support/database";

test("a queued transaction cannot absorb a standalone write and roll its acknowledgement back", async () => {
  const database = createDatabase(testDatabaseUrl(), { max: 1 });
  const table = sql.identifier(`isolation_${randomUUID().replaceAll("-", "")}`);
  const rolledBack = new Error("roll back only the transaction's write");
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let transaction: Promise<unknown> | undefined;
  let outside: Promise<unknown> | undefined;
  try {
    await database.execute(sql`create table ${table} (id int primary key)`);
    // Queue BEGIN behind an ordinary query on a busy connection. Bun 1.3.14's
    // native pool can keep that reserved connection available to other queries.
    const busy = database.$client.unsafe("select pg_sleep(0.03)").execute();
    // Let the lazy driver's execution microtasks acquire the connection before BEGIN.
    await new Promise((resolve) => setTimeout(resolve, 0));
    transaction = database
      .transaction(async (tx) => {
        await tx.execute(sql`insert into ${table} values (1)`);
        entered();
        await held;
        throw rolledBack;
      })
      .catch((error) => error);
    await busy;
    await ready;
    let acknowledged = false;
    outside = database
      .execute(sql`insert into ${table} values (2)`)
      .then(() => {
        acknowledged = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const acknowledgedWhileReserved = acknowledged;
    release();
    expect(await transaction).toBe(rolledBack);
    await outside;
    expect(acknowledgedWhileReserved).toBe(false);
    expect(await database.execute(sql`select id from ${table}`)).toEqual([
      { id: 2 },
    ]);
  } finally {
    release();
    await Promise.allSettled([transaction, outside]);
    try {
      await database.execute(sql`drop table if exists ${table}`);
    } finally {
      await database.$client.close();
    }
  }
});

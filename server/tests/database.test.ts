import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { customType, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createDatabase } from "../src/db/client";
import { jsonb } from "../src/db/schema/json";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

test("creates a typed database boundary without opening a query", () => {
  const database = createDatabase(
    "postgres://openbot:openbot@localhost:5432/openbot",
    TEST_POOL,
  );

  expect(database.query.users).toBeDefined();
});

const bindingProbe = pgTable("database_binding_probe", {
  id: integer("id").notNull(),
  instant: timestamp("instant", { withTimezone: true }),
  payload: jsonb("payload"),
  labels: text("labels").array(),
  bytes: customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" })("bytes"),
});

(process.env.TEST_DATABASE_URL ? test : test.skip)("unnamed queries preserve the schema's Date, JSON, array and bytea contracts on PostgreSQL", async () => {
  const database = createDatabase(testDatabaseUrl(), { max: 1 });
  const instant = new Date("2026-11-09T02:03:04.567Z");
  const payload = { nested: { count: 2 }, text: "千早", enabled: true };
  const labels = ["comma,value", 'quote"value', "slash\\value", "千早"];
  const bytes = Buffer.from([0, 1, 127, 128, 255]);
  try {
    await database.transaction(async tx => {
      await tx.execute(sql`CREATE TEMPORARY TABLE database_binding_probe (
        id int NOT NULL, instant timestamptz, payload jsonb, labels text[], bytes bytea
      ) ON COMMIT DROP`);
      await tx.insert(bindingProbe).values([
        { id: 1, instant, payload, labels, bytes },
        { id: 2, instant: null, payload: null, labels: [], bytes: Buffer.alloc(0) },
      ]);
      const rows = await tx.select().from(bindingProbe).orderBy(bindingProbe.id);
      expect(rows[0]?.instant?.toISOString()).toBe(instant.toISOString());
      expect(rows[0]?.payload).toEqual(payload);
      expect(rows[0]?.labels).toEqual(labels);
      expect(Buffer.from(rows[0]!.bytes!)).toEqual(bytes);
      expect(rows[1]?.instant).toBeNull(); expect(rows[1]?.payload).toBeNull();
      expect(rows[1]?.labels).toEqual([]); expect(Buffer.from(rows[1]!.bytes!)).toEqual(Buffer.alloc(0));
      const [stored] = await tx.execute<{ shape: string; text: string }>(sql`SELECT jsonb_typeof(payload) AS shape,
        payload->>'text' AS text FROM database_binding_probe WHERE id=1`);
      expect(stored?.shape).toBe("object"); expect(stored?.text).toBe("千早");
    });
    // Device expiry and memory undo reconstruct Date values before binding. Unnamed mode needs
    // their ISO representation, not Date.toString(), which PostgreSQL rejects in localized zones.
    const restoredInstant = new Date(instant.toISOString()).toISOString();
    const [raw] = await database.$client.unsafe("SELECT $1::text::jsonb AS payload, $2::timestamptz AS instant, $3::bytea AS bytes, $4::timestamptz AS restored", [JSON.stringify(payload), instant.toISOString(), bytes, restoredInstant]);
    expect(raw.payload).toEqual(payload);
    expect(new Date(raw.instant).toISOString()).toBe(instant.toISOString());
    expect(Buffer.from(raw.bytes)).toEqual(bytes);
    expect(new Date(raw.restored).getTime()).toBe(instant.getTime());
  } finally { await database.$client.close(); }
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createDatabase } from "../src/db/client";
import { createDeviceStore, fullAccessActive } from "../src/devices/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

// 2026-10-15 回归：full_access_until 用 postgres.js unsafe 读，JS 数组参数曾被编码成 "a,b"（malformed array literal），
// 读失败被吞掉 → 完全访问打开后列表 / 工具里永远显示「没开」。这里用真库验证写进去能读回来，多台设备也行。
const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)(
  "device store: full access persists (real database)",
  () => {
    const database = url ? createDatabase(url, TEST_POOL) : (null as never);
    const owner = `fa-${randomUUID().slice(0, 8)}`;
    afterAll(async () => {
      if (!url) return;
      const store = createDeviceStore(database);
      for (const d of await store.list(owner)) await store.remove(d.id);
    });

    beforeAll(async () => {
      // 测试库是空库：只建设备这几张表（迁移 0054 本身是幂等的 IF NOT EXISTS）。
      const sql = readFileSync(
        new URL("../drizzle/0054_pc_devices.sql", import.meta.url),
        "utf8",
      );
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.trim())
          await database.$client.unsafe(statement).catch(() => {});
      }
    });

    test("set, read back for several devices, turn off", async () => {
      const store = createDeviceStore(database);
      await store.ensure();
      const a = (
        await store.enroll({
          ownerUserId: owner,
          name: "A",
          platform: "linux",
          clientVersion: "0.1.8-node",
        })
      ).device;
      const b = (
        await store.enroll({
          ownerUserId: owner,
          name: "B",
          platform: "win32",
          clientVersion: "0.1.8",
        })
      ).device;
      const until = new Date(Date.now() + 3600_000).toISOString();
      await store.update(a.id, { fullAccessUntil: until });
      await store.update(b.id, { fullAccessUntil: until });
      const listed = await store.list(owner);
      expect(listed.length).toBe(2);
      for (const d of listed) {
        expect(d.fullAccessUntil).toBe(until);
        expect(fullAccessActive(d)).toBe(true);
      }
      // 新的 store 实例（像服务器重启）也读得到
      const fresh = createDeviceStore(database);
      await fresh.ensure();
      expect((await fresh.get(a.id))?.fullAccessUntil).toBe(until);
      await fresh.update(a.id, { fullAccessUntil: null });
      expect((await fresh.get(a.id))?.fullAccessUntil).toBeNull();
      expect((await fresh.get(b.id))?.fullAccessUntil).toBe(until);
    });
  },
);

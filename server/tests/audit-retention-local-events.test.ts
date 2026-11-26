import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_LOCAL_EVENT_RETENTION_DAYS,
  LOCAL_EVENTS_SWEEP_LOCK,
  sweepLocalEvents,
} from "../src/audit-retention";

describe("sweepLocalEvents (CB-031 archived streaming event pruning)", () => {
  test("rejects non-positive or non-integer retentionDays without opening a connection", async () => {
    let opened = 0;
    for (const days of [0, -5, 1.5, Number.NaN]) {
      const result = await sweepLocalEvents("postgres://unused", days, {
        connect: () => {
          opened += 1;
          throw new Error("should not connect");
        },
      });
      expect(result).toEqual({ deleted: null });
    }
    expect(opened).toBe(0);
    expect(DEFAULT_LOCAL_EVENT_RETENTION_DAYS).toBeGreaterThanOrEqual(1);
  });

  test("returns deleted: null and releases connection when advisory lock is held elsewhere", async () => {
    let ended = 0;
    let deletedCalls = 0;
    const seenLockIds: number[] = [];
    const result = await sweepLocalEvents("postgres://unused", 14, {
      connect: () => ({
        async tryAdvisoryLock(lockId) {
          seenLockIds.push(lockId);
          return false;
        },
        async deleteArchivedBatch() {
          deletedCalls += 1;
          return 0;
        },
        async end() {
          ended += 1;
        },
      }),
    });
    expect(result).toEqual({ deleted: null });
    expect(seenLockIds).toEqual([LOCAL_EVENTS_SWEEP_LOCK]);
    expect(deletedCalls).toBe(0);
    expect(ended).toBe(1);
  });

  test("deletes in batches until a partial batch is returned and always closes connection", async () => {
    const batchCounts = [50, 50, 12];
    let ended = 0;
    const calls: Array<{ retentionDays: number; batchSize: number }> = [];
    const result = await sweepLocalEvents("postgres://unused", 14, {
      batchSize: 50,
      maxBatches: 10,
      connect: () => ({
        async tryAdvisoryLock() {
          return true;
        },
        async deleteArchivedBatch(retentionDays, batchSize) {
          calls.push({ retentionDays, batchSize });
          return batchCounts.shift() ?? 0;
        },
        async end() {
          ended += 1;
        },
      }),
    });
    expect(result).toEqual({ deleted: 112 });
    expect(calls).toEqual([
      { retentionDays: 14, batchSize: 50 },
      { retentionDays: 14, batchSize: 50 },
      { retentionDays: 14, batchSize: 50 },
    ]);
    expect(ended).toBe(1);
  });

  test("caps iterations at maxBatches and releases connection if a batch throws", async () => {
    let calls = 0;
    const capped = await sweepLocalEvents("postgres://unused", 14, {
      batchSize: 10,
      maxBatches: 3,
      connect: () => ({
        async tryAdvisoryLock() {
          return true;
        },
        async deleteArchivedBatch() {
          calls += 1;
          return 10;
        },
        async end() {},
      }),
    });
    expect(capped).toEqual({ deleted: 30 });
    expect(calls).toBe(3);

    let endedOnError = 0;
    await expect(
      sweepLocalEvents("postgres://unused", 14, {
        connect: () => ({
          async tryAdvisoryLock() {
            return true;
          },
          async deleteArchivedBatch() {
            throw new Error("disk full");
          },
          async end() {
            endedOnError += 1;
          },
        }),
      }),
    ).rejects.toThrow("disk full");
    expect(endedOnError).toBe(1);
  });

  test("SQL deletes only snapshotted non-lifecycle intermediate rows under advisory lock", async () => {
    const source = await readFile(
      new URL("../src/audit-retention.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("e.sequence <= t.snapshot_sequence");
    expect(source).toContain(
      "not in ('RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR')",
    );
    expect(source).toContain("pg_try_advisory_lock");
  });
});

import { expect, test } from "bun:test";
import { OPS_CODES } from "./ops-codes";
import {
  bumpOps,
  isBudgetCode,
  opsCounterSnapshot,
  resetOpsCountersForTests,
} from "./ops-counters";

test("bumpOps accumulates totals and last15m; snapshot omits holes", () => {
  resetOpsCountersForTests();
  const logs: string[] = [];
  const t0 = Date.parse("2026-10-19T05:00:00.000Z");
  bumpOps(OPS_CODES.SSRF_DENIED, {
    now: t0,
    fields: { reason: "private" },
    log: (l) => logs.push(l),
  });
  bumpOps(OPS_CODES.SSRF_DENIED, { now: t0 + 1_000, silent: true });
  bumpOps(OPS_CODES.SEND_UNREACHABLE, { now: t0 + 2_000, silent: true });

  const snap = opsCounterSnapshot(t0 + 3_000);
  expect(snap.totals.SSRF_DENIED).toBe(2);
  expect(snap.totals.SEND_UNREACHABLE).toBe(1);
  expect(snap.totals.STREAM_DISCONNECT).toBe(0);
  expect(snap.last15m.SSRF_DENIED).toBe(2);
  expect(snap.windowMs).toBe(15 * 60_000);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("SSRF_DENIED");
  expect(logs[0]).toContain('"total":1');
});

test("events older than 15m leave the window but stay in totals", () => {
  resetOpsCountersForTests();
  const t0 = Date.parse("2026-10-19T05:00:00.000Z");
  bumpOps(OPS_CODES.STREAM_DISCONNECT, { now: t0, silent: true });
  const later = t0 + 16 * 60_000;
  bumpOps(OPS_CODES.STREAM_DISCONNECT, { now: later, silent: true });
  const snap = opsCounterSnapshot(later);
  expect(snap.totals.STREAM_DISCONNECT).toBe(2);
  expect(snap.last15m.STREAM_DISCONNECT).toBe(1);
});

test("isBudgetCode whitelist", () => {
  expect(isBudgetCode("SSRF_DENIED")).toBe(true);
  expect(isBudgetCode("OPS_HEALTH_DEGRADED")).toBe(false);
  expect(isBudgetCode("nope")).toBe(false);
});

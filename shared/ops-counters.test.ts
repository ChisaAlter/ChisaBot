import { expect, test } from "bun:test";
import { OPS_CODES } from "./ops-codes";
import {
  bumpOps,
  exportOpsMetricsFile,
  importOpsMetricsFile,
  isBudgetCode,
  opsCounterSnapshot,
  opsHistorySeries,
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
  expect(snap.rates.last1h.SSRF_DENIED).toBe(2);
  expect(snap.rates.last1h.SEND_UNREACHABLE).toBe(1);
  expect(snap.rates.perHour1h.SSRF_DENIED).toBe(2);
  expect(snap.series.points.length).toBeGreaterThanOrEqual(1);
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
  expect(snap.rates.last1h.STREAM_DISCONNECT).toBe(2);
});

test("minute ring builds sparse series and survives export/import", () => {
  resetOpsCountersForTests();
  const t0 = Date.parse("2026-10-19T05:00:00.000Z");
  bumpOps(OPS_CODES.SEND_HANG, { now: t0, silent: true });
  bumpOps(OPS_CODES.SEND_HANG, { now: t0 + 90_000, silent: true });
  bumpOps(OPS_CODES.SSRF_DENIED, { now: t0 + 90_000, silent: true });

  const points = opsHistorySeries(t0 + 95_000, 60 * 60_000);
  expect(points.length).toBe(2);
  expect(points[0]?.counts.SEND_HANG).toBe(1);
  expect(points[1]?.counts.SEND_HANG).toBe(1);
  expect(points[1]?.counts.SSRF_DENIED).toBe(1);

  const file = exportOpsMetricsFile(t0 + 95_000);
  expect(file.version).toBe(1);
  expect(file.totals.SEND_HANG).toBe(2);

  resetOpsCountersForTests();
  importOpsMetricsFile(file, t0 + 95_000);
  const snap = opsCounterSnapshot(t0 + 95_000);
  expect(snap.totals.SEND_HANG).toBe(2);
  expect(snap.rates.last1h.SSRF_DENIED).toBe(1);
  expect(opsHistorySeries(t0 + 95_000, 60 * 60_000).length).toBe(2);
});

test("isBudgetCode whitelist", () => {
  expect(isBudgetCode("SSRF_DENIED")).toBe(true);
  expect(isBudgetCode("OPS_HEALTH_DEGRADED")).toBe(false);
  expect(isBudgetCode("nope")).toBe(false);
});

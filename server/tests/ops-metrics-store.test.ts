import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPS_CODES } from "../../shared/ops-codes";
import {
  bumpOps,
  opsCounterSnapshot,
  resetOpsCountersForTests,
} from "../../shared/ops-counters";
import {
  flushOpsMetrics,
  loadOpsMetrics,
  startOpsMetricsStore,
  stopOpsMetricsStoreForTests,
} from "../src/ops-metrics-store";

afterEach(() => {
  stopOpsMetricsStoreForTests();
  resetOpsCountersForTests();
});

test("ops metrics store persists and reloads minute ring", async () => {
  stopOpsMetricsStoreForTests();
  resetOpsCountersForTests();
  const dir = await mkdtemp(join(tmpdir(), "ops-metrics-"));
  const path = join(dir, "budgets.json");
  try {
    const t0 = Date.parse("2026-10-19T06:00:00.000Z");
    await startOpsMetricsStore({ path, now: t0 });
    bumpOps(OPS_CODES.SSRF_DENIED, { now: t0 + 1_000, silent: true });
    bumpOps(OPS_CODES.SEND_UNREACHABLE, { now: t0 + 2_000, silent: true });
    await flushOpsMetrics(t0 + 3_000, path);

    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { version: number; totals: Record<string, number> };
    expect(parsed.version).toBe(1);
    expect(parsed.totals.SSRF_DENIED).toBe(1);
    expect(parsed.totals.SEND_UNREACHABLE).toBe(1);

    stopOpsMetricsStoreForTests();
    resetOpsCountersForTests();
    expect(opsCounterSnapshot(t0 + 4_000).totals.SSRF_DENIED).toBe(0);

    const loaded = await loadOpsMetrics(path, t0 + 4_000);
    expect(loaded).toBe(true);
    const snap = opsCounterSnapshot(t0 + 4_000);
    expect(snap.totals.SSRF_DENIED).toBe(1);
    expect(snap.rates.last1h.SEND_UNREACHABLE).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

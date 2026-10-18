/**
 * Process-local error-budget counters + minute ring (PRD-P1-02 / metrics timeseries).
 *
 * Lean: no Prometheus / managed SaaS. Bump on SEND / STREAM / SSRF events; expose totals,
 * last15m, hourly rates, and a compact minute series on `GET /api/admin/health`. Optional
 * file persistence (server) survives restarts via the workspace volume — see
 * `server/src/ops-metrics-store.ts` and docs/ops/monitoring.md.
 */
import { OPS_CODES, type OpsCode, opsLogLine } from "./ops-codes";

/** Codes that enter the error-budget snapshot (stable contract for monitors). */
export const BUDGET_CODES = [
  OPS_CODES.SEND_UNREACHABLE,
  OPS_CODES.SEND_HANG,
  OPS_CODES.SEND_REPLY_HANG,
  OPS_CODES.STREAM_DISCONNECT,
  OPS_CODES.SSRF_DENIED,
] as const;

export type BudgetCode = (typeof BUDGET_CODES)[number];

const WINDOW_MS = 15 * 60_000;
/** Minute-bucket retention for rates / series (24h). */
export const HISTORY_MS = 24 * 60 * 60_000;
export const MINUTE_MS = 60_000;

type Bucket = {
  total: number;
  /** Recent event timestamps (ms), pruned to WINDOW_MS. */
  recent: number[];
  /** floor(ms / MINUTE_MS) → count in that minute. */
  minutes: Map<number, number>;
};

const buckets = new Map<OpsCode, Bucket>();

/** Optional side-effect after a bump (file flush). Injected by the server store. */
let afterBump: ((code: OpsCode, now: number) => void) | null = null;

export function setOpsAfterBump(
  hook: ((code: OpsCode, now: number) => void) | null,
): void {
  afterBump = hook;
}

function bucket(code: OpsCode): Bucket {
  let b = buckets.get(code);
  if (!b) {
    b = { total: 0, recent: [], minutes: new Map() };
    buckets.set(code, b);
  }
  return b;
}

function pruneRecent(b: Bucket, now: number) {
  const floor = now - WINDOW_MS;
  while (b.recent.length > 0) {
    const head = b.recent[0];
    if (head === undefined || head >= floor) break;
    b.recent.shift();
  }
}

function pruneMinutes(b: Bucket, now: number) {
  const floorMin = Math.floor((now - HISTORY_MS) / MINUTE_MS);
  for (const key of b.minutes.keys()) {
    if (key < floorMin) b.minutes.delete(key);
  }
}

function minuteKey(ms: number): number {
  return Math.floor(ms / MINUTE_MS);
}

function countInWindow(b: Bucket, now: number, windowMs: number): number {
  const floorMin = Math.floor((now - windowMs) / MINUTE_MS);
  let n = 0;
  for (const [min, count] of b.minutes) {
    if (min >= floorMin) n += count;
  }
  return n;
}

function emptyCodeMap(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const code of BUDGET_CODES) out[code] = 0;
  return out;
}

export type OpsBudgetRates = {
  /** Raw event counts in each lookback window. */
  last1h: Record<string, number>;
  last6h: Record<string, number>;
  last24h: Record<string, number>;
  /** Events per hour derived from last1h / last6h (rounded). */
  perHour1h: Record<string, number>;
  perHour6h: Record<string, number>;
};

export type OpsBudgetSeriesPoint = {
  /** ISO start of this minute bucket (UTC). */
  t: string;
  counts: Record<string, number>;
};

export type OpsCounterSnapshot = {
  /** ISO time of snapshot. */
  at: string;
  /** Sliding window length in ms (15 minutes). */
  windowMs: number;
  /** Lifetime totals since process start (or restored file totals). */
  totals: Record<string, number>;
  /** Counts inside the sliding window. */
  last15m: Record<string, number>;
  /** Lookback counts + rates from the minute ring (up to 24h). */
  rates: OpsBudgetRates;
  /**
   * Compact non-zero minute series for scrapers / jq.
   * Default: last 60 minutes. Use `opsHistorySeries` for a longer window.
   */
  series: {
    bucketMs: number;
    retentionMs: number;
    points: OpsBudgetSeriesPoint[];
  };
};

function buildRates(now: number): OpsBudgetRates {
  const last1h = emptyCodeMap();
  const last6h = emptyCodeMap();
  const last24h = emptyCodeMap();
  const perHour1h = emptyCodeMap();
  const perHour6h = emptyCodeMap();
  for (const code of BUDGET_CODES) {
    const b = bucket(code);
    pruneMinutes(b, now);
    last1h[code] = countInWindow(b, now, 60 * 60_000);
    last6h[code] = countInWindow(b, now, 6 * 60 * 60_000);
    last24h[code] = countInWindow(b, now, HISTORY_MS);
    perHour1h[code] = last1h[code] ?? 0;
    perHour6h[code] = Math.round(((last6h[code] ?? 0) / 6) * 10) / 10;
  }
  return { last1h, last6h, last24h, perHour1h, perHour6h };
}

/**
 * Sparse minute series covering `[now - windowMs, now]`.
 * Only minutes with at least one budget event are emitted.
 */
export function opsHistorySeries(
  now = Date.now(),
  windowMs = 60 * 60_000,
): OpsBudgetSeriesPoint[] {
  const capped = Math.min(Math.max(windowMs, MINUTE_MS), HISTORY_MS);
  const floorMin = minuteKey(now - capped);
  const endMin = minuteKey(now);
  const byMin = new Map<number, Record<string, number>>();
  for (const code of BUDGET_CODES) {
    const b = bucket(code);
    pruneMinutes(b, now);
    for (const [min, count] of b.minutes) {
      if (min < floorMin || min > endMin || count <= 0) continue;
      let row = byMin.get(min);
      if (!row) {
        row = emptyCodeMap();
        byMin.set(min, row);
      }
      row[code] = count;
    }
  }
  return [...byMin.keys()]
    .sort((a, b) => a - b)
    .map((min) => ({
      t: new Date(min * MINUTE_MS).toISOString(),
      counts: byMin.get(min) ?? emptyCodeMap(),
    }));
}

/** Read-only snapshot for `/api/admin/health`. Never includes secrets. */
export function opsCounterSnapshot(now = Date.now()): OpsCounterSnapshot {
  const totals = emptyCodeMap();
  const last15m = emptyCodeMap();
  for (const code of BUDGET_CODES) {
    const b = bucket(code);
    pruneRecent(b, now);
    pruneMinutes(b, now);
    totals[code] = b.total;
    last15m[code] = b.recent.length;
  }
  return {
    at: new Date(now).toISOString(),
    windowMs: WINDOW_MS,
    totals,
    last15m,
    rates: buildRates(now),
    series: {
      bucketMs: MINUTE_MS,
      retentionMs: HISTORY_MS,
      points: opsHistorySeries(now, 60 * 60_000),
    },
  };
}

export type BumpOptions = {
  /** Extra greppable fields (no secrets / SQL). */
  fields?: Record<string, string | number | boolean | null | undefined>;
  /** Skip stdout log (tests / high-frequency paths that log elsewhere). */
  silent?: boolean;
  /** Injected clock. */
  now?: number;
  /** Injected logger. */
  log?: (line: string) => void;
};

/**
 * Increment a budget counter and (unless `silent`) emit one `{"type":"ops","code":…}` line.
 * Unknown / non-budget codes still log but only budget codes appear in the health snapshot.
 */
export function bumpOps(code: OpsCode, options: BumpOptions = {}): void {
  const now = options.now ?? Date.now();
  const b = bucket(code);
  b.total += 1;
  b.recent.push(now);
  pruneRecent(b, now);
  const mk = minuteKey(now);
  b.minutes.set(mk, (b.minutes.get(mk) ?? 0) + 1);
  pruneMinutes(b, now);
  afterBump?.(code, now);
  if (options.silent) return;
  const log = options.log ?? ((line: string) => console.info(line));
  log(
    opsLogLine(code, {
      ...options.fields,
      total: b.total,
      last15m: b.recent.length,
    }),
  );
}

/** Test helper: wipe all counters. */
export function resetOpsCountersForTests(): void {
  buckets.clear();
}

export function isBudgetCode(code: string): code is BudgetCode {
  return (BUDGET_CODES as readonly string[]).includes(code);
}

/** Serializable minute ring + totals for disk (server persist). */
export type OpsMetricsFileV1 = {
  version: 1;
  savedAt: string;
  totals: Record<string, number>;
  /** code → { minuteEpochString → count } */
  minutes: Record<string, Record<string, number>>;
};

export function exportOpsMetricsFile(now = Date.now()): OpsMetricsFileV1 {
  const totals = emptyCodeMap();
  const minutes: Record<string, Record<string, number>> = {};
  for (const code of BUDGET_CODES) {
    const b = bucket(code);
    pruneMinutes(b, now);
    totals[code] = b.total;
    const row: Record<string, number> = {};
    for (const [min, count] of b.minutes) {
      if (count > 0) row[String(min)] = count;
    }
    minutes[code] = row;
  }
  return {
    version: 1,
    savedAt: new Date(now).toISOString(),
    totals,
    minutes,
  };
}

/**
 * Merge a saved file into the in-memory ring (does not wipe newer live data).
 * Totals take `max(current, file)` so a stale restore cannot shrink counters.
 */
export function importOpsMetricsFile(
  file: OpsMetricsFileV1,
  now = Date.now(),
): void {
  if (file.version !== 1) return;
  for (const code of BUDGET_CODES) {
    const b = bucket(code);
    const fileTotal = file.totals?.[code] ?? 0;
    if (typeof fileTotal === "number" && fileTotal > b.total) {
      b.total = fileTotal;
    }
    const row = file.minutes?.[code];
    if (!row || typeof row !== "object") continue;
    for (const [key, count] of Object.entries(row)) {
      const min = Number(key);
      if (!Number.isFinite(min) || typeof count !== "number" || count <= 0)
        continue;
      b.minutes.set(min, Math.max(b.minutes.get(min) ?? 0, count));
    }
    pruneMinutes(b, now);
  }
}

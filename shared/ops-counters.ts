/**
 * Process-local error-budget counters (PRD-P1-02 remainder).
 *
 * Lean: no metrics backend, no Prometheus. Bump on SEND / STREAM / SSRF (and health) events;
 * expose a snapshot on `GET /api/admin/health` and keep greppable `opsLogLine` rows in stdout.
 * Totals reset on process restart (expected after each deploy).
 */
import { OPS_CODES, type OpsCode, opsLogLine } from "./ops-codes";

/** Codes that enter the error-budget snapshot (stable contract for monitors). */
export const BUDGET_CODES = [
  OPS_CODES.SEND_UNREACHABLE,
  OPS_CODES.STREAM_DISCONNECT,
  OPS_CODES.SSRF_DENIED,
] as const;

export type BudgetCode = (typeof BUDGET_CODES)[number];

const WINDOW_MS = 15 * 60_000;

type Bucket = {
  total: number;
  /** Recent event timestamps (ms), pruned to WINDOW_MS. */
  recent: number[];
};

const buckets = new Map<OpsCode, Bucket>();

function bucket(code: OpsCode): Bucket {
  let b = buckets.get(code);
  if (!b) {
    b = { total: 0, recent: [] };
    buckets.set(code, b);
  }
  return b;
}

function prune(b: Bucket, now: number) {
  const floor = now - WINDOW_MS;
  while (b.recent.length > 0) {
    const head = b.recent[0];
    if (head === undefined || head >= floor) break;
    b.recent.shift();
  }
}

export type OpsCounterSnapshot = {
  /** ISO time of snapshot. */
  at: string;
  /** Sliding window length in ms (15 minutes). */
  windowMs: number;
  /** Lifetime totals since process start. */
  totals: Record<string, number>;
  /** Counts inside the sliding window. */
  last15m: Record<string, number>;
};

function emptyTotals(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const code of BUDGET_CODES) out[code] = 0;
  return out;
}

/** Read-only snapshot for `/api/admin/health`. Never includes secrets. */
export function opsCounterSnapshot(now = Date.now()): OpsCounterSnapshot {
  const totals = emptyTotals();
  const last15m = emptyTotals();
  for (const code of BUDGET_CODES) {
    const b = bucket(code);
    prune(b, now);
    totals[code] = b.total;
    last15m[code] = b.recent.length;
  }
  return {
    at: new Date(now).toISOString(),
    windowMs: WINDOW_MS,
    totals,
    last15m,
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
  prune(b, now);
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

/**
 * File-backed persistence for ops budget minute rings (no managed SaaS).
 *
 * Default path: `/workspace/.chisabot-ops/budgets.json` (compose `workspace` volume).
 * Override with `CHISABOT_OPS_METRICS_PATH`. Load once at boot; debounce-flush after bumps
 * and on an interval so Haupt survives restarts without a metrics vendor.
 *
 * See docs/ops/monitoring.md §「错误预算时序」.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { reasonWithoutStatement } from "./db/query-failure";
import {
  exportOpsMetricsFile,
  importOpsMetricsFile,
  setOpsAfterBump,
  type OpsMetricsFileV1,
} from "../../shared/ops-counters";

export const DEFAULT_OPS_METRICS_PATH =
  "/workspace/.chisabot-ops/budgets.json";

const FLUSH_DEBOUNCE_MS = 2_000;
const FLUSH_INTERVAL_MS = 60_000;

let storePath = DEFAULT_OPS_METRICS_PATH;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let started = false;
let dirty = false;

export function resolveOpsMetricsPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.CHISABOT_OPS_METRICS_PATH?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_OPS_METRICS_PATH;
}

async function writeAtomic(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
}

export async function flushOpsMetrics(
  now = Date.now(),
  path = storePath,
): Promise<void> {
  const file = exportOpsMetricsFile(now);
  await writeAtomic(path, `${JSON.stringify(file)}\n`);
  dirty = false;
}

function scheduleFlush(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushOpsMetrics().catch((error) => {
      console.warn(
        `[ops-metrics] flush failed: ${reasonWithoutStatement(error)}`,
      );
    });
  }, FLUSH_DEBOUNCE_MS);
  // Don't keep the process alive solely for a pending flush.
  flushTimer.unref?.();
}

export async function loadOpsMetrics(
  path = storePath,
  now = Date.now(),
): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as OpsMetricsFileV1;
    if (parsed?.version !== 1) return false;
    importOpsMetricsFile(parsed, now);
    return true;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    if (code !== "ENOENT") {
      console.warn(
        `[ops-metrics] load failed (${path}): ${reasonWithoutStatement(error)}`,
      );
    }
    return false;
  }
}

/**
 * Load existing file (if any), hook bumps for debounced flush, start periodic flush.
 * Idempotent. Safe to call when `/workspace` is missing (flush will warn).
 */
export async function startOpsMetricsStore(options?: {
  path?: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<{ path: string; loaded: boolean }> {
  if (started) return { path: storePath, loaded: false };
  storePath = options?.path ?? resolveOpsMetricsPath(options?.env);
  const loaded = await loadOpsMetrics(storePath, options?.now ?? Date.now());
  setOpsAfterBump(() => scheduleFlush());
  intervalTimer = setInterval(() => {
    if (!dirty) return;
    void flushOpsMetrics().catch(() => {});
  }, FLUSH_INTERVAL_MS);
  intervalTimer.unref?.();
  started = true;
  return { path: storePath, loaded };
}

/** Test helper: stop timers and clear hook. */
export function stopOpsMetricsStoreForTests(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  setOpsAfterBump(null);
  started = false;
  dirty = false;
}

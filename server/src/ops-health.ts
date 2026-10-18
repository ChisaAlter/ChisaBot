/**
 * Aggregated ops health (PRD-P1-01): one admin JSON surface for uptime monitors and post-deploy smoke.
 *
 * `GET /api/admin/health` — administrators only (gateway session or X-ChisaBot-Local-Caller).
 * Combines app/version, database ping, Magpie status (when configured), computer node (when
 * configured), and a local-caller / gateway-mode marker. Overall `ok` is false when any configured
 * check fails; unconfigured optional deps are `ok: null` and do not fail the aggregate.
 *
 * HTTP 200 when overall ok, 503 otherwise. Never returns secrets. Cache-Control: no-store.
 *
 * Uptime monitors without admin credentials should keep probing public `/health` and `/login`;
 * this endpoint is for authenticated ops (see docs/production-checklist.md).
 */

import { sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { OPS_CODES, opsLogLine } from "../../shared/ops-codes";
import {
  type OpsCounterSnapshot,
  opsCounterSnapshot,
  opsHistorySeries,
} from "../../shared/ops-counters";
import type { BuildVersion } from "../../shared/system-update";
import type { AppVariables } from "./auth/guards";
import { requireAdmin } from "./auth/guards";
import { readRunningBuild, versionPayload } from "./build-info";
import type { Database } from "./db/client";
import { reasonWithoutStatement } from "./db/query-failure";
import type { MagpieService } from "./magpie";

export type CheckOk = boolean | null;

export type AppCheck = { ok: true; status: "ok" };
export type DatabaseCheck = {
  ok: boolean;
  latencyMs?: number;
  error?: string;
};
export type MagpieCheck = {
  ok: CheckOk;
  configured: boolean;
  reachable?: boolean;
  gatewayOn?: boolean;
  providersReady?: number;
  providersTotal?: number;
  version?: string;
  error?: string;
};
export type ComputerCheck = {
  ok: CheckOk;
  configured: boolean;
  provider?: string;
  reachable?: boolean;
  running?: number;
  total?: number;
  error?: string;
};
export type LocalCallerCheck = {
  ok: true;
  authenticated: true;
  gatewayMode: "on" | "off";
};

export type OpsHealthReport = {
  ok: boolean;
  checkedAt: string;
  version: BuildVersion;
  checks: {
    app: AppCheck;
    database: DatabaseCheck;
    magpie: MagpieCheck;
    computer: ComputerCheck;
    localCaller: LocalCallerCheck;
  };
  /** PRD-P1-02: SEND/STREAM/SSRF budgets — totals, last15m, rates, 1h series. */
  budgets: OpsCounterSnapshot;
};

export type PingDatabase = () => Promise<DatabaseCheck>;
export type ProbeComputer = () => Promise<ComputerCheck>;

const DB_TIMEOUT_MS = 5_000;
const MAGPIE_BUDGET_MS = 8_000;
const COMPUTER_BUDGET_MS = 8_000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Pure aggregation used by the route and by unit tests. */
export async function collectOpsHealth(options: {
  pingDatabase: PingDatabase;
  magpie?: MagpieService | null;
  probeComputer?: ProbeComputer | null;
  gatewayMode: "on" | "off";
  now?: () => number;
  log?: (line: string) => void;
}): Promise<OpsHealthReport> {
  const log = options.log ?? ((line: string) => console.info(line));
  const checkedAt = new Date(options.now?.() ?? Date.now()).toISOString();
  const version = versionPayload(readRunningBuild());

  const app: AppCheck = { ok: true, status: "ok" };
  const localCaller: LocalCallerCheck = {
    ok: true,
    authenticated: true,
    gatewayMode: options.gatewayMode,
  };

  let database: DatabaseCheck;
  try {
    database = await withTimeout(
      options.pingDatabase(),
      DB_TIMEOUT_MS,
      "database",
    );
  } catch (error) {
    database = { ok: false, error: reasonWithoutStatement(error) };
  }

  let magpie: MagpieCheck;
  if (!options.magpie?.configured) {
    magpie = { ok: null, configured: false };
  } else {
    try {
      const status = await withTimeout(
        options.magpie.status({ refresh: true }),
        MAGPIE_BUDGET_MS,
        "magpie",
      );
      const providersTotal = status.providers.length;
      const providersReady = status.providers.filter(
        (p) => p.ready && p.enabled,
      ).length;
      magpie = {
        ok: status.reachable,
        configured: true,
        reachable: status.reachable,
        gatewayOn: status.gatewayOn,
        providersReady,
        providersTotal,
        ...(status.version ? { version: status.version } : {}),
        ...(status.error ? { error: status.error.slice(0, 200) } : {}),
      };
    } catch (error) {
      magpie = {
        ok: false,
        configured: true,
        reachable: false,
        error: reasonWithoutStatement(error),
      };
    }
  }

  let computer: ComputerCheck;
  if (!options.probeComputer) {
    computer = { ok: null, configured: false };
  } else {
    try {
      computer = await withTimeout(
        options.probeComputer(),
        COMPUTER_BUDGET_MS,
        "computer",
      );
    } catch (error) {
      computer = {
        ok: false,
        configured: true,
        error: reasonWithoutStatement(error),
      };
    }
  }

  const required: Array<{ name: string; ok: CheckOk }> = [
    { name: "app", ok: app.ok },
    { name: "database", ok: database.ok },
    { name: "magpie", ok: magpie.ok },
    { name: "computer", ok: computer.ok },
    { name: "localCaller", ok: localCaller.ok },
  ];
  const failed = required.filter((c) => c.ok === false).map((c) => c.name);
  const ok = failed.length === 0;

  if (!ok) {
    log(
      opsLogLine(OPS_CODES.HEALTH_DEGRADED, {
        failed: failed.join(","),
        db: database.ok,
        magpie: magpie.ok,
        computer: computer.ok,
      }),
    );
    if (database.ok === false)
      log(opsLogLine(OPS_CODES.HEALTH_DB, { error: database.error ?? "" }));
    if (magpie.ok === false)
      log(opsLogLine(OPS_CODES.HEALTH_MAGPIE, { error: magpie.error ?? "" }));
    if (computer.ok === false)
      log(
        opsLogLine(OPS_CODES.HEALTH_COMPUTER, { error: computer.error ?? "" }),
      );
  }

  return {
    ok,
    checkedAt,
    version,
    checks: { app, database, magpie, computer, localCaller },
    budgets: opsCounterSnapshot(options.now?.() ?? Date.now()),
  };
}

/** `SELECT 1` via drizzle; scrubbed on failure. */
export function createDatabasePinger(database: Database): PingDatabase {
  return async () => {
    const start = performance.now();
    await database.execute(sql`SELECT 1`);
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  };
}

export function createOpsHealthRoutes(options: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  pingDatabase: PingDatabase;
  magpie?: MagpieService | null;
  probeComputer?: ProbeComputer | null;
  gatewayMode: "on" | "off";
  log?: (line: string) => void;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", options.requireUser);
  routes.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    context.header("Cache-Control", "no-store");
    await next();
  });

  routes.get("/", async (context) => {
    const report = await collectOpsHealth({
      pingDatabase: options.pingDatabase,
      magpie: options.magpie,
      probeComputer: options.probeComputer,
      gatewayMode: options.gatewayMode,
      log: options.log,
    });
    return context.json(report, report.ok ? 200 : 503);
  });

  /**
   * Scrape-friendly budget history (admin only).
   * `?hours=1|6|24` (default 6). Sparse minute points; no secrets.
   */
  routes.get("/budgets", (context) => {
    const raw = context.req.query("hours");
    const hours = raw === "1" || raw === "24" || raw === "6" ? Number(raw) : 6;
    const now = Date.now();
    const snap = opsCounterSnapshot(now);
    return context.json({
      at: snap.at,
      hours,
      bucketMs: snap.series.bucketMs,
      retentionMs: snap.series.retentionMs,
      totals: snap.totals,
      last15m: snap.last15m,
      rates: snap.rates,
      points: opsHistorySeries(now, hours * 60 * 60_000),
    });
  });

  return routes;
}

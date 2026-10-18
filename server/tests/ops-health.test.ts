import { expect, test } from "bun:test";
import { Hono } from "hono";
import { OPS_CODES } from "../../shared/ops-codes";
import { resetOpsCountersForTests } from "../../shared/ops-counters";
import type { AppVariables } from "../src/auth/guards";
import type { MagpieService, MagpieStatus } from "../src/magpie";
import {
  type ComputerCheck,
  collectOpsHealth,
  createOpsHealthRoutes,
  type DatabaseCheck,
} from "../src/ops-health";

function magpieStub(status: MagpieStatus): MagpieService {
  return {
    configured: status.configured,
    managementAvailable: status.managementAvailable,
    status: async () => status,
    proxy: async () => new Response("no"),
    onChange: () => {},
  };
}

test("collectOpsHealth: all green when optional deps skipped", async () => {
  resetOpsCountersForTests();
  const report = await collectOpsHealth({
    pingDatabase: async () => ({ ok: true, latencyMs: 2 }),
    gatewayMode: "off",
    now: () => Date.parse("2026-10-19T04:00:00.000Z"),
  });
  expect(report.ok).toBe(true);
  expect(report.checkedAt).toBe("2026-10-19T04:00:00.000Z");
  expect(report.checks.app).toEqual({ ok: true, status: "ok" });
  expect(report.checks.database).toEqual({ ok: true, latencyMs: 2 });
  expect(report.checks.magpie).toEqual({ ok: null, configured: false });
  expect(report.checks.computer).toEqual({ ok: null, configured: false });
  expect(report.checks.localCaller).toEqual({
    ok: true,
    authenticated: true,
    gatewayMode: "off",
  });
  expect(report.version.version).toMatch(/^\d+\.\d+\.\d+/u);
  expect(report.budgets.totals.SSRF_DENIED).toBe(0);
  expect(report.budgets.last15m.SEND_UNREACHABLE).toBe(0);
  expect(report.budgets.windowMs).toBe(15 * 60_000);
});

test("collectOpsHealth: database failure fails overall and logs OPS code", async () => {
  const logs: string[] = [];
  const report = await collectOpsHealth({
    pingDatabase: async () => ({ ok: false, error: "connection refused" }),
    gatewayMode: "on",
    log: (line) => logs.push(line),
  });
  expect(report.ok).toBe(false);
  expect(report.checks.database.ok).toBe(false);
  expect(logs.some((l) => l.includes(OPS_CODES.HEALTH_DEGRADED))).toBe(true);
  expect(logs.some((l) => l.includes(OPS_CODES.HEALTH_DB))).toBe(true);
  expect(logs.join("\n")).not.toContain("SELECT");
});

test("collectOpsHealth: configured Magpie down fails; computer skip stays null", async () => {
  const report = await collectOpsHealth({
    pingDatabase: async (): Promise<DatabaseCheck> => ({
      ok: true,
      latencyMs: 1,
    }),
    magpie: magpieStub({
      configured: true,
      managementAvailable: true,
      reachable: false,
      providers: [],
      checkedAt: Date.now(),
      error: "upstream timeout",
    }),
    gatewayMode: "on",
  });
  expect(report.ok).toBe(false);
  expect(report.checks.magpie).toMatchObject({
    ok: false,
    configured: true,
    reachable: false,
  });
  expect(report.checks.computer.ok).toBeNull();
});

test("collectOpsHealth: Magpie ready + computer reachable → overall ok", async () => {
  const probeComputer = async (): Promise<ComputerCheck> => ({
    ok: true,
    configured: true,
    provider: "shared",
    reachable: true,
    running: 0,
    total: 0,
  });
  const report = await collectOpsHealth({
    pingDatabase: async () => ({ ok: true, latencyMs: 1 }),
    magpie: magpieStub({
      configured: true,
      managementAvailable: true,
      reachable: true,
      gatewayOn: true,
      version: "1.2.3",
      providers: [
        { id: "a", name: "A", ready: true, enabled: true, models: 2 },
        { id: "b", name: "B", ready: false, enabled: true, models: 1 },
      ],
      checkedAt: Date.now(),
    }),
    probeComputer,
    gatewayMode: "on",
  });
  expect(report.ok).toBe(true);
  expect(report.checks.magpie).toMatchObject({
    ok: true,
    providersReady: 1,
    providersTotal: 2,
    version: "1.2.3",
  });
  expect(report.checks.computer.ok).toBe(true);
});

test("collectOpsHealth: database timeout becomes failure without leaking internals", async () => {
  const report = await collectOpsHealth({
    pingDatabase: () =>
      new Promise(() => {
        /* never resolves */
      }),
    gatewayMode: "off",
  });
  expect(report.ok).toBe(false);
  expect(report.checks.database.ok).toBe(false);
  expect(report.checks.database.error).toMatch(/timed out/u);
}, 15_000);

function app(
  role: "admin" | "user",
  deps: {
    pingDatabase?: () => Promise<DatabaseCheck>;
    probeComputer?: () => Promise<ComputerCheck>;
  } = {},
) {
  const requireUser = (async (
    context: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    context.set("actor", {
      id: `${role}-1`,
      email: `${role}@x`,
      name: role,
      role,
    });
    await next();
  }) as never;
  const root = new Hono<{ Variables: AppVariables }>();
  root.route(
    "/api/admin/health",
    createOpsHealthRoutes({
      requireUser,
      pingDatabase:
        deps.pingDatabase ?? (async () => ({ ok: true, latencyMs: 1 })),
      probeComputer: deps.probeComputer,
      gatewayMode: "on",
    }),
  );
  return root;
}

test("GET /api/admin/health: admins only", async () => {
  const response = await app("user").request("/api/admin/health");
  expect(response.status).toBe(403);
});

test("GET /api/admin/health: 200 + no-store when healthy", async () => {
  const response = await app("admin").request("/api/admin/health");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(body.checks.localCaller.gatewayMode).toBe("on");
  const text = JSON.stringify(body);
  expect(text).not.toContain("sk-");
  expect(text).not.toContain("password");
  expect(text).not.toContain("DATABASE_URL");
});

test("GET /api/admin/health: 503 when database down", async () => {
  const response = await app("admin", {
    pingDatabase: async () => ({ ok: false, error: "down" }),
  }).request("/api/admin/health");
  expect(response.status).toBe(503);
  const body = await response.json();
  expect(body.ok).toBe(false);
  expect(body.checks.database.ok).toBe(false);
});
